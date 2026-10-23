import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ReceiptStatus,
  RecordStatus,
  StockMovementType,
  StockRefType,
  SupplierPaymentSource,
} from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorCode } from 'src/common/types/error-code';
import { escapeLike } from 'src/common/utils/like-pattern.util';
import {
  addDaysToDateOnly,
  toDateOnlyString,
  todayInVietnam,
  vietnamDayStartUtc,
} from 'src/common/utils/date-only.util';
import { resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { DocumentCodeService } from '../core/document-code.service';
import { badRequest, documentErrors, invalidReference, inventoryError } from '../core/inventory.error';
import { branchWhere, resolveWriteBranch } from '../core/inventory-scope';
import { InventoryTransactions } from '../core/inventory-transactions';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { StockIntakeService } from '../core/stock-intake.service';
import { StockLedgerService } from '../core/stock-ledger.service';
import { assertBranchDebtNotNegative } from '../supplier-debt/supplier-debt-guards';
import { SupplierDebtRepository } from '../supplier-debt/repositories/supplier-debt.repository';
import { SupplierPaymentWriter } from '../supplier-debt/supplier-payment.writer';
import {
  CancelGoodsReceiptRequest,
  CreateGoodsReceiptRequest,
  UpdateGoodsReceiptRequest,
} from './dtos/goods-receipt.request';
import { GoodsReceiptQuery } from './dtos/goods-receipt.query';
import { allocateUnitCosts } from './goods-receipt-cost-allocation';
import { GoodsReceiptDraftBuilder } from './goods-receipt-draft.builder';
import { GoodsReceiptLocker } from './goods-receipt-locker';
import { computeLine } from './goods-receipt.calculator';
import { GoodsReceiptDetail, GoodsReceiptRepository } from './repositories/goods-receipt.repository';

/** Phiếu trả về client kèm cảnh báo (lô cận date…) — cảnh báo không chặn thao tác. */
export type GoodsReceiptView = GoodsReceiptDetail & { warnings: string[] };

const SORTABLE_FIELDS = new Set(['createdAt', 'code', 'totalAmount']);

const errors = documentErrors('Phiếu nhập');

@Injectable()
export class GoodsReceiptService {
  constructor(
    private readonly receipts: GoodsReceiptRepository,
    private readonly locker: GoodsReceiptLocker,
    private readonly debts: SupplierDebtRepository,
    private readonly draftBuilder: GoodsReceiptDraftBuilder,
    private readonly intake: StockIntakeService,
    private readonly transactions: InventoryTransactions,
    private readonly ledger: StockLedgerService,
    private readonly codes: DocumentCodeService,
    private readonly supplierPayments: SupplierPaymentWriter,
    private readonly audit: AuditLogService,
  ) {}

  list(query: GoodsReceiptQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const where: Prisma.GoodsReceiptWhereInput = {};
    if (branchId) where.branchId = branchId;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.createdBy) where.createdBy = query.createdBy;
    if (query.receiverId) where.receiverId = query.receiverId;
    if (query.status) where.status = query.status;
    if (query.fromDate || query.toDate) {
      where.createdAt = {
        ...(query.fromDate ? { gte: vietnamDayStartUtc(query.fromDate) } : {}),
        ...(query.toDate ? { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } : {}),
      };
    }
    if (query.search) {
      where.OR = [
        { code: { contains: escapeLike(query.search), mode: 'insensitive' } },
        { supplierInvoiceNo: { contains: escapeLike(query.search), mode: 'insensitive' } },
      ];
    }
    return this.receipts.findPage(where, query.page, query.limit, this.toOrder(query.sort));
  }

  async getDetail(id: string, actor: RequestActor): Promise<GoodsReceiptDetail> {
    const scope = resolveBranchScope(actor.user);
    const receipt = await this.receipts.findDetail(id, branchWhere(scope));
    if (!receipt) throw errors.notFound();
    return receipt;
  }

  async create(dto: CreateGoodsReceiptRequest, actor: RequestActor): Promise<GoodsReceiptView> {
    const branchId = resolveWriteBranch(
      resolveBranchScope(actor.user),
      dto.branchId,
      'Cần chọn chi nhánh nhập kho (branchId)',
    );
    const actorId = actor.user.userId;

    return this.transactions.run(async ({ tx }) => {
      const draft = await this.draftBuilder.prepare(tx, branchId, dto, {
        requireActiveSupplier: true,
        defaultReceiverId: actorId,
      });
      const code = await this.codes.next(tx, 'GOODS_RECEIPT');
      const { id } = await this.receipts.createHeader(tx, { code, branchId, ...draft.header, createdBy: actorId });
      await this.receipts.createItems(
        tx,
        draft.items.map((item) => ({ ...item, receiptId: id, createdBy: actorId })),
      );
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.CREATE,
          entityType: AUDIT_ENTITY.GOODS_RECEIPT,
          entityId: id,
          branchId,
          after: {
            code,
            supplierId: draft.header.supplierId,
            receiverId: draft.header.receiverId,
            paymentMethod: draft.header.paymentMethod,
            discountAmount: draft.header.discountAmount.toString(),
            supplierExpenseAmount: draft.header.supplierExpenseAmount.toString(),
            otherExpenseAmount: draft.header.otherExpenseAmount.toString(),
            totalAmount: draft.header.totalAmount.toString(),
            lines: draft.items.length,
          },
          ipAddress: actor.ip,
        },
      ]);
      return { ...(await this.mustFind(tx, id)), warnings: draft.warnings };
    });
  }

  /** Thay toàn bộ phiếu NHÁP (đầu phiếu + dòng). Dòng cũ xoá mềm. */
  async update(id: string, dto: UpdateGoodsReceiptRequest, actor: RequestActor): Promise<GoodsReceiptView> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;

    return this.transactions.run(async ({ tx }) => {
      // Khoá phiếu: đầu phiếu/dòng không đổi giữa lúc đọc và ghi (xác nhận, PATCH payment chạy song song phải xếp hàng).
      const head = await this.locker.lock(tx, id, branchWhere(scope));
      if (head.status !== ReceiptStatus.DRAFT) throw errors.wrongState(head.status);

      const draft = await this.draftBuilder.prepare(tx, head.branchId, dto, {
        requireActiveSupplier: true,
        defaultReceiverId: actorId,
      });
      const changed = await this.receipts.transition(tx, id, ReceiptStatus.DRAFT, {
        ...draft.header,
        updatedAt: new Date(),
        updatedBy: actorId,
      });
      if (!changed) throw errors.wrongState();

      // Số dòng bị xoá mềm = số dòng trước khi sửa, dùng cho phần "trước" của nhật ký.
      const { count: previousLines } = await this.receipts.softDeleteItems(tx, id, actorId);
      await this.receipts.createItems(
        tx,
        draft.items.map((item) => ({ ...item, receiptId: id, createdBy: actorId })),
      );
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.UPDATE,
          entityType: AUDIT_ENTITY.GOODS_RECEIPT,
          entityId: id,
          branchId: head.branchId,
          // Cùng bộ khoá với `after` để nhật ký chỉ hiện trường thật sự đổi.
          before: {
            receiverId: head.receiverId,
            paymentMethod: head.paymentMethod,
            discountAmount: head.discountAmount.toString(),
            supplierExpenseAmount: head.supplierExpenseAmount.toString(),
            otherExpenseAmount: head.otherExpenseAmount.toString(),
            totalAmount: head.totalAmount.toString(),
            lines: previousLines,
          },
          after: {
            receiverId: draft.header.receiverId,
            paymentMethod: draft.header.paymentMethod,
            discountAmount: draft.header.discountAmount.toString(),
            supplierExpenseAmount: draft.header.supplierExpenseAmount.toString(),
            otherExpenseAmount: draft.header.otherExpenseAmount.toString(),
            totalAmount: draft.header.totalAmount.toString(),
            lines: draft.items.length,
          },
          ipAddress: actor.ip,
        },
      ]);
      return { ...(await this.mustFind(tx, id)), warnings: draft.warnings };
    });
  }

  /**
   * DRAFT → CONFIRMED: hàng vào kho. Số câu lệnh cố định bất kể số dòng:
   * đổi trạng thái có điều kiện → đọc dòng → (sửa hệ số) → `StockIntakeService` (tạo/khoá/gộp lô, sổ kho) → nhật ký.
   */
  async confirm(id: string, actor: RequestActor): Promise<GoodsReceiptView> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      // Khoá phiếu: paidAmount, chi phí, giảm giá, dòng hàng dưới đây là số cuối cùng — PUT/PATCH song song phải chờ.
      const head = await this.locker.lock(tx, id, branchWhere(scope));
      if (head.status !== ReceiptStatus.DRAFT) throw errors.wrongState(head.status);
      await this.draftBuilder.assertBranchActive(tx, head.branchId);

      // Chiếm phiếu trước mọi việc khác: request thứ hai (bấm đúp) dừng ở đây, không bao giờ nhập kho lần hai.
      const claimed = await this.receipts.transition(tx, id, ReceiptStatus.DRAFT, {
        status: ReceiptStatus.CONFIRMED,
        confirmedAt: now,
        confirmedBy: actorId,
        receivedAt: head.receivedAt ?? now,
        // "Tiền trả NCC" của nháp thành phiếu chi ngay dưới đây; paidAmount chỉ là bộ đệm Σ phân bổ nên về 0 trước.
        ...(head.paidAmount > 0n ? { paidAmount: 0n, paymentStatus: PaymentStatus.UNPAID } : {}),
        updatedAt: now,
        updatedBy: actorId,
      });
      if (!claimed) throw errors.wrongState();
      if (head.paidAmount > 0n) {
        await this.supplierPayments.createForReceipt(
          tx,
          head,
          head.paidAmount,
          {
            method: head.paymentMethod ?? PaymentMethod.CASH,
            source: SupplierPaymentSource.RECEIPT,
            note: `Trả khi nhập hàng ${head.code}`,
          },
          { actorId, ip: actor.ip },
        );
      }

      const items = await this.receipts.findItemsForConfirm(tx, id);
      const today = todayInVietnam();
      const warnings: string[] = [];
      const conversions: { id: string; conversionRate: number; baseQuantity: number }[] = [];
      const lines = items.map((item) => {
        const unit = item.productUnit;
        if (
          unit.isDeleted ||
          unit.status !== RecordStatus.ACTIVE ||
          unit.product.isDeleted ||
          unit.product.status !== RecordStatus.ACTIVE
        ) {
          throw invalidReference(`sản phẩm ${unit.product.code} hoặc đơn vị nhập đã ngừng kinh doanh`);
        }
        const expiry = toDateOnlyString(item.expiryDate);
        this.draftBuilder.checkExpiry(item.batchNumber, expiry, today, warnings);

        // K8: hệ số quy đổi lấy theo danh mục LÚC XÁC NHẬN; tiền dòng không đổi vì tính theo đơn vị nhập.
        const amounts = computeLine({
          quantity: item.quantity,
          conversionRate: unit.conversionRate,
          importPrice: item.importPrice,
          unitDiscount: item.unitDiscount,
        });
        if (!amounts) throw badRequest(`Dòng lô ${item.batchNumber}: số lượng quy đổi vượt giới hạn`);
        if (unit.conversionRate !== item.conversionRate) {
          conversions.push({ id: item.id, conversionRate: unit.conversionRate, baseQuantity: amounts.baseQuantity });
          warnings.push(
            `Lô ${item.batchNumber}: hệ số quy đổi đã đổi từ ${item.conversionRate} thành ${unit.conversionRate}`,
          );
        }
        return { item, amounts };
      });
      await this.receipts.updateItemConversions(tx, conversions);

      // Q7: phân bổ chi phí (NCC + khác) − giảm giá phiếu vào giá vốn từng dòng theo tỷ lệ thành tiền. VAT không vào.
      const adjustment = Number(head.supplierExpenseAmount + head.otherExpenseAmount - head.discountAmount);
      const unitCosts = allocateUnitCosts(
        lines.map(({ item, amounts }) => ({ totalPrice: item.totalPrice, baseQuantity: amounts.baseQuantity })),
        adjustment,
      );

      await this.intake.intake(ctx, {
        branchId: head.branchId,
        type: StockMovementType.IMPORT,
        refType: StockRefType.GOODS_RECEIPT,
        refId: id,
        actorId,
        lines: lines.map(({ item, amounts }, index) => ({
          productId: item.productId,
          batchNumber: item.batchNumber,
          manufacturingDate: item.manufacturingDate,
          expiryDate: item.expiryDate,
          quantity: amounts.baseQuantity,
          unitCost: unitCosts[index],
          supplierId: head.supplierId,
          goodsReceiptItemId: item.id,
          refItemId: item.id,
        })),
      });

      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.STATUS_CHANGE,
          entityType: AUDIT_ENTITY.GOODS_RECEIPT,
          entityId: id,
          branchId: head.branchId,
          before: { status: ReceiptStatus.DRAFT },
          after: { status: ReceiptStatus.CONFIRMED, lines: lines.length },
          ipAddress: actor.ip,
        },
      ]);
      return { ...(await this.mustFind(tx, id)), warnings };
    });
  }

  /**
   * Huỷ phiếu. NHÁP: chỉ đổi trạng thái. ĐÃ XÁC NHẬN (K4): đảo toàn bộ bút toán nhập — chỉ khi chưa lô nào của phiếu
   * phát sinh xuất kể từ lúc nhập; ngược lại 1707 và người dùng phải lập phiếu điều chỉnh/trả NCC.
   * Giá vốn bình quân của lô gộp KHÔNG tính ngược lại được (đã ghi rõ trong spec).
   */
  async cancel(id: string, dto: CancelGoodsReceiptRequest, actor: RequestActor): Promise<GoodsReceiptDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      // Phiếu đã xác nhận: khoá NCC rồi khoá phiếu (lock order chung) — huỷ làm đổi công nợ nên xếp hàng cùng phiếu chi/điều chỉnh.
      const head = await this.locker.lock(tx, id, branchWhere(scope), { supplierWhenConfirmed: true });
      if (head.status === ReceiptStatus.CANCELLED) throw errors.wrongState(head.status);

      const claimed = await this.receipts.transition(tx, id, head.status, {
        status: ReceiptStatus.CANCELLED,
        cancelledAt: now,
        cancelledBy: actorId,
        cancelReason: dto.reason,
        updatedAt: now,
        updatedBy: actorId,
      });
      if (!claimed) throw errors.wrongState();

      if (head.status === ReceiptStatus.CONFIRMED) {
        // Phiếu chi lập tay còn hiệu lực → 1713; phiếu chi tự sinh (RECEIPT) huỷ theo, paidAmount về 0.
        await this.supplierPayments.releaseForReceiptCancel(tx, head, { actorId, ip: actor.ip });
        // Điều chỉnh nợ trước đó có thể đã hạ nợ chi nhánh về sát 0: huỷ phiếu làm nợ âm thì từ chối.
        await assertBranchDebtNotNegative(this.debts, tx, head.supplierId, head.branchId, 'Huỷ phiếu nhập');
        const imports = await this.receipts.findImportMovements(tx, id);
        if (imports.length) {
          const locked = await this.ledger.lockBatches(
            ctx,
            imports.map((movement) => movement.batchId),
          );
          const since = new Date(Math.min(...imports.map((movement) => movement.createdAt.getTime())));
          const moved = await this.receipts.findBatchesMovedSince(
            tx,
            locked.map((batch) => batch.id),
            since,
            id,
          );
          if (moved.length) {
            const numbers = locked
              .filter((batch) => moved.some((row) => row.batchId === batch.id))
              .map((batch) => batch.batchNumber);
            throw inventoryError(ErrorCode.BATCH_ALREADY_MOVED, `lô ${numbers.join(', ')}`);
          }
          // Rút qua intake để giá vốn của lô trở về như chưa từng nhập phiếu này (gõ nhầm giá không để lại dấu).
          await this.intake.withdraw(ctx, {
            type: StockMovementType.IMPORT,
            refType: StockRefType.GOODS_RECEIPT,
            refId: id,
            lines: imports.map((movement) => ({
              batchId: movement.batchId,
              quantity: movement.quantity,
              unitCost: movement.unitCost,
              refItemId: movement.refItemId,
            })),
            locked,
            actorId,
            note: 'Đảo bút toán nhập do huỷ phiếu',
          });
        }
      }

      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.STATUS_CHANGE,
          entityType: AUDIT_ENTITY.GOODS_RECEIPT,
          entityId: id,
          branchId: head.branchId,
          before: { status: head.status },
          after: { status: ReceiptStatus.CANCELLED },
          reason: dto.reason,
          ipAddress: actor.ip,
        },
      ]);
      return this.mustFind(tx, id);
    });
  }

  private toOrder(sort?: string): Prisma.GoodsReceiptOrderByWithRelationInput[] {
    const [field, direction] = (sort ?? '').split(':');
    const order: Prisma.GoodsReceiptOrderByWithRelationInput[] = [];
    if (field && SORTABLE_FIELDS.has(field)) order.push({ [field]: direction === 'asc' ? 'asc' : 'desc' });
    else order.push({ createdAt: 'desc' });
    order.push({ id: 'desc' });
    return order;
  }

  private async mustFind(tx: Prisma.TransactionClient, id: string): Promise<GoodsReceiptDetail> {
    const receipt = await this.receipts.findDetail(id, {}, tx);
    if (!receipt) throw errors.notFound();
    return receipt;
  }
}
