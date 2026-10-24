import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  OrderChannel,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RecordStatus,
  TransactionStatus,
  UserStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { escapeLike } from 'src/common/utils/like-pattern.util';
import { normalizePhoneSearch } from 'src/common/utils/phone.util';
import { resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { DocumentCodeService } from 'src/modules/feature-inventory/core/document-code.service';
import { branchWhere, resolveWriteBranch } from 'src/modules/feature-inventory/core/inventory-scope';
import { InventoryTransactions, InventoryTxContext } from 'src/modules/feature-inventory/core/inventory-transactions';
import { badRequest, inventoryError, invalidReference } from 'src/modules/feature-inventory/core/inventory.error';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { buildOrderLines, OrderLine, orderTotals } from '../core/order-lines';
import { OrderStockService } from '../core/order-stock.service';
import { EXPIRY_BATCH_SIZE, POS_ABANDON_MINUTES, SALES_AUDIT_ENTITY } from '../core/sales.constants';
import { orderErrors, salesError } from '../core/sales.error';
import {
  CancelOrderRequest,
  CreatePosOrderRequest,
  InteractionOverrideRequest,
  OrderQuery,
  PayOrderRequest,
  PrescriptionRequest,
  ReplaceOrderItemsRequest,
} from './dtos/order.request';
import { OrderDetail, OrderHead, OrderRepository, WalkInCustomer } from './repositories/order.repository';

/** Trạng thái huỷ được theo kênh. Online để tương lai (huỷ trước SHIPPING) — hiện chưa có đơn online nào. */
const CANCELLABLE: Record<OrderChannel, readonly OrderStatus[]> = {
  [OrderChannel.POS]: [OrderStatus.PENDING],
  [OrderChannel.ONLINE]: [],
};

const ABANDONED_REASON = `Tự huỷ: đơn tại quầy bỏ dở quá ${POS_ABANDON_MINUTES} phút`;

/** Cột đơn thuốc từ DTO; không gửi thì `{}` để giữ nguyên giá trị cũ khi sửa đơn. */
function prescriptionData(prescription: PrescriptionRequest | undefined) {
  if (!prescription) return {};
  return {
    prescriptionCode: prescription.code,
    prescriberName: prescription.prescriberName,
    prescriptionImageUrl: prescription.imageUrl ?? null,
  };
}

/** Ghi đè cảnh báo tương tác: server tự điền người ghi đè + thời điểm. Không gửi → `{}` (giữ giá trị cũ khi sửa đơn). */
function overrideData(override: InteractionOverrideRequest | undefined, actorId: string) {
  if (!override) return {};
  const value = { ...override, byUserId: actorId, at: new Date().toISOString() };
  return { interactionOverride: value as unknown as Prisma.InputJsonValue };
}

function isDuplicateTransactionCode(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Đơn hàng phía nhân viên — bán tại quầy: lập (giữ hàng ngay) → sửa khi PENDING → thu tiền một lần (trừ kho, COMPLETED)
 * hoặc huỷ (nhả hàng). Mọi thao tác ghi chiếm đơn bằng cập nhật có điều kiện trước khi đụng kho, nên bấm đúp hay hai quầy
 * cùng thao tác một đơn đều chỉ một request thắng (1701 cho request còn lại).
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly orders: OrderRepository,
    private readonly transactions: InventoryTransactions,
    private readonly stock: OrderStockService,
    private readonly codes: DocumentCodeService,
    private readonly audit: AuditLogService,
  ) {}

  list(query: OrderQuery, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const branchId = scopedBranchFilter(scope, query.branchId);
    const conditions: Prisma.OrderWhereInput[] = [];
    if (branchId) conditions.push({ branchId });
    if (query.channel) conditions.push({ channel: query.channel });
    if (query.status) conditions.push({ status: query.status });
    if (query.fromDate) conditions.push({ createdAt: { gte: vietnamDayStartUtc(query.fromDate) } });
    if (query.toDate) conditions.push({ createdAt: { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } });
    if (query.search?.trim()) {
      const keyword = escapeLike(normalizePhoneSearch(query.search.trim()));
      conditions.push({
        OR: [
          { code: { contains: keyword, mode: 'insensitive' } },
          { customer: { phoneNumber: { contains: keyword } } },
        ],
      });
    }
    return this.orders.findPage({ AND: conditions }, query.page, query.limit);
  }

  async getDetail(id: string, actor: RequestActor): Promise<OrderDetail> {
    const order = await this.orders.findDetail(id, branchWhere(resolveBranchScope(actor.user)));
    if (!order) throw orderErrors.notFound();
    return order;
  }

  /** Lập đơn tại quầy (S1, S2, S9, S10): PENDING, giữ hàng FEFO ngay. Thiếu hàng → 1700 và không có đơn nào được tạo. */
  async createPos(dto: CreatePosOrderRequest, actor: RequestActor): Promise<OrderDetail> {
    const branchId = resolveWriteBranch(resolveBranchScope(actor.user), dto.branchId);
    const actorId = actor.user.userId;

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      await this.assertBranchActive(tx, branchId);
      const customer = dto.customerPhone
        ? await this.walkInCustomerOf(tx, dto.customerPhone, dto.customerName, actorId)
        : null;
      const lines = buildOrderLines(dto.items, await this.orders.findSellableUnits(tx, this.unitIdsOf(dto)));
      const totals = orderTotals(lines, 0, dto.discountAmount ?? 0);
      // Thuốc kiểm soát đặc biệt: phải biết người mua (như mock — chặn khách lẻ).
      if (!customer && lines.some((line) => line.isControlled)) {
        throw badRequest('Đơn có thuốc kiểm soát đặc biệt phải nhập SĐT khách mua');
      }

      const code = await this.codes.next(tx, 'ORDER');
      const { id } = await this.orders.createHeader(tx, {
        code,
        branchId,
        customerId: customer?.id ?? null,
        staffId: actorId,
        channel: OrderChannel.POS,
        subtotalAmount: totals.subtotalAmount,
        discountAmount: totals.discountAmount,
        totalAmount: totals.totalAmount,
        ...prescriptionData(dto.prescription),
        ...overrideData(dto.interactionOverride, actorId),
        note: dto.note ?? null,
        createdBy: actorId,
      });
      await this.saveLines(ctx, { orderId: id, branchId, actorId }, lines);

      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.CREATE,
          entityType: SALES_AUDIT_ENTITY.ORDER,
          entityId: id,
          branchId,
          after: { code, channel: OrderChannel.POS, lines: lines.length, totalAmount: Number(totals.totalAmount) },
          ipAddress: actor.ip,
        },
        // Hồ sơ khách do hệ thống tạo cũng phải có dấu vết: ai tạo, ở quầy nào.
        ...(customer?.created
          ? [
              {
                actorId,
                action: AuditAction.CREATE,
                entityType: SALES_AUDIT_ENTITY.USER,
                entityId: customer.id,
                branchId,
                after: { phoneNumber: dto.customerPhone ?? null, source: 'POS' },
                ipAddress: actor.ip,
              },
            ]
          : []),
      ]);
      return this.mustFind(tx, id);
    });
  }

  /** Sửa đơn tại quầy (S3): thay toàn bộ dòng — nhả phần giữ cũ, chọn lô lại cho danh sách mới. */
  async replacePosItems(id: string, dto: ReplaceOrderItemsRequest, actor: RequestActor): Promise<OrderDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const head = await this.loadEditablePos(tx, id, branchWhere(scope));
      const lines = buildOrderLines(dto.items, await this.orders.findSellableUnits(tx, this.unitIdsOf(dto)));
      const totals = orderTotals(lines, 0, dto.discountAmount ?? 0);

      // Chiếm trước khi đụng kho: request thu tiền/huỷ cùng lúc phải chờ, rồi thấy đơn đã đổi.
      const claimed = await this.orders.claim(
        tx,
        id,
        { status: OrderStatus.PENDING, channel: OrderChannel.POS },
        {
          subtotalAmount: totals.subtotalAmount,
          discountAmount: totals.discountAmount,
          totalAmount: totals.totalAmount,
          ...prescriptionData(dto.prescription),
          ...overrideData(dto.interactionOverride, actorId),
          updatedAt: now,
          updatedBy: actorId,
        },
      );
      if (!claimed) throw orderErrors.wrongState();

      await this.stock.discard(ctx, id, actorId);
      await this.orders.deleteItems(tx, id);
      await this.saveLines(ctx, { orderId: id, branchId: head.branchId, actorId }, lines);

      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.UPDATE,
          entityType: SALES_AUDIT_ENTITY.ORDER,
          entityId: id,
          branchId: head.branchId,
          before: { lines: head.lineCount, totalAmount: Number(head.totalAmount) },
          after: { lines: lines.length, totalAmount: Number(totals.totalAmount) },
          ipAddress: actor.ip,
        },
      ]);
      return this.mustFind(tx, id);
    });
  }

  /** Thu tiền một lần (S4–S6): ghi thanh toán đủ tổng, trừ kho từ phần đã giữ, đơn COMPLETED. */
  async payPos(id: string, dto: PayOrderRequest, actor: RequestActor): Promise<OrderDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    try {
      return await this.transactions.run(async (ctx) => {
        const { tx } = ctx;
        const before = await this.loadEditablePos(tx, id, branchWhere(scope));
        const claimed = await this.orders.claim(
          tx,
          id,
          { status: OrderStatus.PENDING, channel: OrderChannel.POS },
          {
            status: OrderStatus.COMPLETED,
            paymentStatus: PaymentStatus.PAID,
            completedAt: now,
            updatedAt: now,
            updatedBy: actorId,
          },
        );
        if (!claimed) throw orderErrors.wrongState();
        // Đọc lại SAU khi chiếm: bản đọc trước có thể cũ nếu một request sửa đơn vừa commit ngay trước lúc ta chiếm.
        const head = await this.mustHead(tx, id);
        if (head.prescriptionLineCount > 0 && (!head.prescriptionCode || !head.prescriberName)) {
          throw salesError(ErrorCode.PRESCRIPTION_REQUIRED);
        }

        // Đơn 0đ (giảm giá hết): không có lượt thu nào — CHECK `payments_amount_positive_chk`.
        if (head.totalAmount > 0n) {
          await this.orders.createPayment(tx, {
            orderId: id,
            method: dto.method,
            amount: head.totalAmount,
            status: TransactionStatus.SUCCESS,
            transactionCode: dto.transactionCode ?? null,
            paidAt: now,
            updatedAt: now,
            note: dto.note ?? null,
            createdBy: actorId,
          });
        }
        await this.stock.consume(ctx, id, actorId);

        await this.audit.record(tx, [
          {
            actorId,
            action: AuditAction.STATUS_CHANGE,
            entityType: SALES_AUDIT_ENTITY.ORDER,
            entityId: id,
            branchId: before.branchId,
            before: { status: OrderStatus.PENDING },
            after: { status: OrderStatus.COMPLETED, method: dto.method, amount: Number(head.totalAmount) },
            ipAddress: actor.ip,
          },
        ]);
        return this.mustFind(tx, id);
      });
    } catch (error) {
      // Unique (method, transactionCode): transaction đã hỏng nên chỉ bắt được ở ngoài `run`.
      if (isDuplicateTransactionCode(error)) {
        throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: 'Mã giao dịch này đã được ghi nhận' });
      }
      throw error;
    }
  }

  /** Huỷ (S7): chỉ đơn tại quầy PENDING; nhả toàn bộ phần đang giữ, không ghi sổ kho. */
  async cancel(id: string, dto: CancelOrderRequest, actor: RequestActor): Promise<OrderDetail> {
    const scope = resolveBranchScope(actor.user);

    return this.transactions.run(async (ctx) => {
      const head = await this.orders.findHead(ctx.tx, id, branchWhere(scope));
      if (!head) throw orderErrors.notFound();
      if (!CANCELLABLE[head.channel].includes(head.status)) throw orderErrors.wrongState(head.status);
      await this.cancelInTx(ctx, head, { status: head.status }, dto.reason, actor.user.userId, actor.ip);
      return this.mustFind(ctx.tx, id);
    });
  }

  /**
   * Job tự huỷ (S8). Mỗi đơn một transaction riêng — một đơn lỗi không chặn các đơn khác. Điều kiện chiếm có `updatedAt`
   * lúc đọc: nhân viên vừa sửa đơn giữa lúc job đọc và lúc job huỷ thì đơn không bị huỷ.
   */
  async expireAbandonedPos(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - POS_ABANDON_MINUTES * 60_000);
    const candidates = await this.orders.findAbandonedPos(cutoff, EXPIRY_BATCH_SIZE);
    let cancelled = 0;
    for (const order of candidates) {
      try {
        await this.transactions.run((ctx) =>
          this.cancelInTx(
            ctx,
            order,
            { status: OrderStatus.PENDING, updatedAt: order.updatedAt },
            ABANDONED_REASON,
            SYSTEM_ACTOR_ID,
            null,
          ),
        );
        cancelled++;
      } catch (error) {
        // Đơn vừa được sửa/huỷ bởi người khác — đúng ý đồ, không phải lỗi.
        if (error instanceof ErrorException && error.errorCode === ErrorCode.INVALID_DOCUMENT_STATE) continue;
        this.logger.error(`Tự huỷ đơn ${order.id} thất bại`, error as Error);
      }
    }
    return cancelled;
  }

  private async cancelInTx(
    ctx: InventoryTxContext,
    order: Pick<OrderHead, 'id' | 'branchId' | 'status'>,
    condition: Prisma.OrderWhereInput,
    reason: string,
    actorId: string,
    ip: string | null,
  ): Promise<void> {
    const now = new Date();
    const claimed = await this.orders.claim(ctx.tx, order.id, condition, {
      status: OrderStatus.CANCELLED,
      cancelReason: reason,
      cancelledAt: now,
      updatedAt: now,
      updatedBy: actorId,
    });
    if (!claimed) throw orderErrors.wrongState();
    await this.stock.release(ctx, order.id, actorId);
    await this.audit.record(ctx.tx, [
      {
        actorId,
        action: AuditAction.STATUS_CHANGE,
        entityType: SALES_AUDIT_ENTITY.ORDER,
        entityId: order.id,
        branchId: order.branchId,
        before: { status: order.status },
        after: { status: OrderStatus.CANCELLED },
        reason,
        ipAddress: ip,
      },
    ]);
  }

  /** Ghi dòng đơn rồi giữ hàng. Id dòng sinh ở đây để nối phân bổ lô về đúng dòng mà không phải đọc lại. */
  private async saveLines(
    ctx: InventoryTxContext,
    target: { orderId: string; branchId: string; actorId: string },
    lines: readonly OrderLine[],
  ): Promise<void> {
    const rows = lines.map((line) => ({
      id: randomUUID(),
      orderId: target.orderId,
      productId: line.productId,
      productUnitId: line.productUnitId,
      productName: line.productName,
      unitName: line.unitName,
      conversionRate: line.conversionRate,
      quantity: line.quantity,
      baseQuantity: line.baseQuantity,
      unitPrice: line.unitPrice,
      totalPrice: line.totalPrice,
      createdBy: target.actorId,
    }));
    await this.orders.createItems(ctx.tx, rows);
    await this.stock.reserve(ctx, {
      orderId: target.orderId,
      branchId: target.branchId,
      actorId: target.actorId,
      items: rows.map((row) => ({ orderItemId: row.id, productId: row.productId, baseQuantity: row.baseQuantity })),
    });
  }

  /** Đơn sửa/thu tiền được: trong phạm vi, kênh POS, đang PENDING. Thông báo nói rõ vì sao không được. */
  private async loadEditablePos(
    tx: Prisma.TransactionClient,
    id: string,
    scopeWhere: Prisma.OrderWhereInput,
  ): Promise<OrderHead> {
    const head = await this.orders.findHead(tx, id, scopeWhere);
    if (!head) throw orderErrors.notFound();
    if (head.channel !== OrderChannel.POS) {
      throw inventoryError(ErrorCode.INVALID_DOCUMENT_STATE, 'đơn online không sửa được — huỷ rồi đặt đơn mới');
    }
    if (head.status !== OrderStatus.PENDING) throw orderErrors.wrongState(head.status);
    return head;
  }

  private async mustHead(tx: Prisma.TransactionClient, id: string): Promise<OrderHead> {
    const head = await this.orders.findHead(tx, id, {});
    if (!head) throw orderErrors.notFound();
    return head;
  }

  private async mustFind(tx: Prisma.TransactionClient, id: string): Promise<OrderDetail> {
    const order = await this.orders.findDetail(id, {}, tx);
    if (!order) throw orderErrors.notFound();
    return order;
  }

  private async assertBranchActive(tx: Prisma.TransactionClient, branchId: string): Promise<void> {
    const branch = await this.orders.findBranch(tx, branchId);
    if (!branch) throw invalidReference('chi nhánh không tồn tại');
    if (branch.status !== RecordStatus.ACTIVE) throw inventoryError(ErrorCode.BRANCH_INACTIVE);
  }

  /**
   * Người mua tại quầy (S9): có hồ sơ khách thì gắn, chưa có thì hệ thống tạo. SĐT thuộc nhân viên hoặc tài khoản đã
   * khoá/xoá → 1602 — không gắn đơn của khách vào tài khoản người khác.
   */
  private async walkInCustomerOf(
    tx: Prisma.TransactionClient,
    phoneNumber: string,
    name: string | undefined,
    actorId: string,
  ): Promise<WalkInCustomer> {
    const customer = await this.orders.upsertWalkInCustomer(tx, {
      phoneNumber,
      fullName: name ?? `Khách ${phoneNumber}`,
      actorId,
    });
    if (!customer.isCustomer || customer.isDeleted || customer.status !== UserStatus.ACTIVE) {
      throw invalidReference('số điện thoại này thuộc nhân viên hoặc tài khoản đã khoá — không gắn được làm khách mua');
    }
    return customer;
  }

  private unitIdsOf(dto: { items: { productUnitId: string }[] }): string[] {
    return dto.items.map((item) => item.productUnitId);
  }
}
