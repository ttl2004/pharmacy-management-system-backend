import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, ReceiptStatus, RecordStatus, StockMovementType, StockRefType } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorCode } from 'src/common/types/error-code';
import { escapeLike } from 'src/common/utils/like-pattern.util';
import {
  addDaysToDateOnly,
  daysBetweenDateOnly,
  parseDateOnly,
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
import { AUDIT_ENTITY, MAX_DOCUMENT_LINES, NEAR_EXPIRY_WARNING_DAYS } from '../core/inventory.constants';
import { StockIntakeService } from '../core/stock-intake.service';
import { StockLedgerService } from '../core/stock-ledger.service';
import {
  CancelGoodsReceiptRequest,
  CreateGoodsReceiptRequest,
  GoodsReceiptItemRequest,
  UpdateGoodsReceiptRequest,
  UpdateReceiptPaymentRequest,
} from './dtos/goods-receipt.request';
import { GoodsReceiptQuery } from './dtos/goods-receipt.query';
import { computeLine, computeTotals, paymentStatusOf, ReceiptTotals } from './goods-receipt.calculator';
import { GoodsReceiptDetail, GoodsReceiptRepository } from './repositories/goods-receipt.repository';

/** Phiếu trả về client kèm cảnh báo (lô cận date…) — cảnh báo không chặn thao tác. */
export type GoodsReceiptView = GoodsReceiptDetail & { warnings: string[] };

type DraftInput = Omit<CreateGoodsReceiptRequest, 'branchId'>;

interface PreparedDraft {
  header: {
    supplierId: string;
    receivedAt: Date | null;
    supplierInvoiceNo: string | null;
    supplierInvoiceDate: Date | null;
    note: string | null;
  } & ReceiptTotals;
  items: Omit<Prisma.GoodsReceiptItemCreateManyInput, 'receiptId' | 'createdBy'>[];
  warnings: string[];
}

const SORTABLE_FIELDS = new Set(['createdAt', 'code', 'totalAmount']);

const errors = documentErrors('Phiếu nhập');

@Injectable()
export class GoodsReceiptService {
  constructor(
    private readonly receipts: GoodsReceiptRepository,
    private readonly intake: StockIntakeService,
    private readonly transactions: InventoryTransactions,
    private readonly ledger: StockLedgerService,
    private readonly codes: DocumentCodeService,
    private readonly audit: AuditLogService,
  ) {}

  list(query: GoodsReceiptQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const where: Prisma.GoodsReceiptWhereInput = {};
    if (branchId) where.branchId = branchId;
    if (query.supplierId) where.supplierId = query.supplierId;
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
      const draft = await this.prepareDraft(tx, branchId, dto, { requireActiveSupplier: true });
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
      const head = await this.receipts.findStatus(tx, id, branchWhere(scope));
      if (!head) throw errors.notFound();
      if (head.status !== ReceiptStatus.DRAFT) throw errors.wrongState(head.status);

      const draft = await this.prepareDraft(tx, head.branchId, dto, { requireActiveSupplier: true });
      const changed = await this.receipts.transition(tx, id, ReceiptStatus.DRAFT, {
        ...draft.header,
        updatedAt: new Date(),
        updatedBy: actorId,
      });
      if (!changed) throw errors.wrongState();

      await this.receipts.softDeleteItems(tx, id, actorId);
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
          before: { totalAmount: head.totalAmount.toString() },
          after: { totalAmount: draft.header.totalAmount.toString(), lines: draft.items.length },
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
      const head = await this.receipts.findStatus(tx, id, branchWhere(scope));
      if (!head) throw errors.notFound();
      if (head.status !== ReceiptStatus.DRAFT) throw errors.wrongState(head.status);
      await this.assertBranchActive(tx, head.branchId);

      // Chiếm phiếu trước mọi việc khác: request thứ hai (bấm đúp) dừng ở đây, không bao giờ nhập kho lần hai.
      const claimed = await this.receipts.transition(tx, id, ReceiptStatus.DRAFT, {
        status: ReceiptStatus.CONFIRMED,
        confirmedAt: now,
        confirmedBy: actorId,
        receivedAt: head.receivedAt ?? now,
        updatedAt: now,
        updatedBy: actorId,
      });
      if (!claimed) throw errors.wrongState();

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
        this.checkExpiry(item.batchNumber, expiry, today, warnings);

        // K8: hệ số quy đổi lấy theo danh mục LÚC XÁC NHẬN; tiền dòng không đổi vì tính theo đơn vị nhập.
        const amounts = computeLine({
          quantity: item.quantity,
          conversionRate: unit.conversionRate,
          importPrice: item.importPrice,
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

      await this.intake.intake(ctx, {
        branchId: head.branchId,
        type: StockMovementType.IMPORT,
        refType: StockRefType.GOODS_RECEIPT,
        refId: id,
        actorId,
        lines: lines.map(({ item, amounts }) => ({
          productId: item.productId,
          batchNumber: item.batchNumber,
          manufacturingDate: item.manufacturingDate,
          expiryDate: item.expiryDate,
          quantity: amounts.baseQuantity,
          unitCost: amounts.unitCost,
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
      const head = await this.receipts.findStatus(tx, id, branchWhere(scope));
      if (!head) throw errors.notFound();
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

  /** Cập nhật số đã trả NCC (tổng, không phải số trả thêm). Lịch sử từng lần đổi nằm ở `audit_logs`. */
  async updatePayment(id: string, dto: UpdateReceiptPaymentRequest, actor: RequestActor): Promise<GoodsReceiptDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;

    return this.transactions.run(async ({ tx }) => {
      const head = await this.receipts.findStatus(tx, id, branchWhere(scope));
      if (!head) throw errors.notFound();
      if (head.status === ReceiptStatus.CANCELLED) throw errors.wrongState(head.status);

      const paidAmount = BigInt(dto.paidAmount);
      if (paidAmount > head.totalAmount) throw badRequest('Số đã trả lớn hơn tổng tiền phiếu');
      const paymentStatus = paymentStatusOf(paidAmount, head.totalAmount);

      const changed = await this.receipts.transition(tx, id, [ReceiptStatus.DRAFT, ReceiptStatus.CONFIRMED], {
        paidAmount,
        paymentStatus,
        updatedAt: new Date(),
        updatedBy: actorId,
      });
      if (!changed) throw errors.wrongState();

      if (paidAmount !== head.paidAmount) {
        await this.audit.record(tx, [
          {
            actorId,
            action: AuditAction.UPDATE,
            entityType: AUDIT_ENTITY.GOODS_RECEIPT,
            entityId: id,
            branchId: head.branchId,
            before: { paidAmount: head.paidAmount.toString() },
            after: { paidAmount: paidAmount.toString(), paymentStatus },
            ipAddress: actor.ip,
          },
        ]);
      }
      return this.mustFind(tx, id);
    });
  }

  /**
   * Kiểm và tính toàn bộ phiếu nháp. Mọi tra cứu tham chiếu là MỘT câu lệnh cho cả phiếu (không vòng lặp gọi DB).
   */
  private async prepareDraft(
    tx: Prisma.TransactionClient,
    branchId: string,
    dto: DraftInput,
    options: { requireActiveSupplier: boolean },
  ): Promise<PreparedDraft> {
    if (dto.items.length > MAX_DOCUMENT_LINES) {
      throw inventoryError(ErrorCode.DOCUMENT_LINE_LIMIT, `tối đa ${MAX_DOCUMENT_LINES} dòng`);
    }
    this.assertNoDuplicateBatchLines(dto.items);

    await this.assertBranchActive(tx, branchId);
    const supplier = await this.receipts.findSupplier(tx, dto.supplierId);
    if (!supplier) throw invalidReference('nhà cung cấp không tồn tại');
    if (options.requireActiveSupplier && supplier.status !== RecordStatus.ACTIVE) {
      throw inventoryError(ErrorCode.SUPPLIER_INACTIVE);
    }

    const units = await this.receipts.findUnitsWithProduct(tx, [
      ...new Set(dto.items.map((item) => item.productUnitId)),
    ]);
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const today = todayInVietnam();
    const warnings: string[] = [];

    const items = dto.items.map((item, index) => {
      const unit = unitById.get(item.productUnitId);
      if (!unit || unit.isDeleted || unit.productId !== item.productId) {
        throw invalidReference(`dòng ${index + 1}: đơn vị nhập không thuộc sản phẩm`);
      }
      if (
        unit.status !== RecordStatus.ACTIVE ||
        unit.product.isDeleted ||
        unit.product.status !== RecordStatus.ACTIVE
      ) {
        throw invalidReference(`dòng ${index + 1}: sản phẩm ${unit.product.code} hoặc đơn vị nhập đã ngừng kinh doanh`);
      }
      if (item.manufacturingDate && item.manufacturingDate >= item.expiryDate) {
        throw badRequest(`Dòng ${index + 1}: ngày sản xuất phải trước hạn dùng`);
      }
      this.checkExpiry(item.batchNumber, item.expiryDate, today, warnings);

      const amounts = computeLine({
        quantity: item.quantity,
        conversionRate: unit.conversionRate,
        importPrice: item.importPrice,
      });
      if (!amounts) throw badRequest(`Dòng ${index + 1}: số lượng quy đổi vượt giới hạn`);

      return {
        productId: item.productId,
        productUnitId: item.productUnitId,
        quantity: item.quantity,
        conversionRate: unit.conversionRate,
        baseQuantity: amounts.baseQuantity,
        importPrice: item.importPrice,
        totalPrice: amounts.totalPrice,
        batchNumber: item.batchNumber,
        manufacturingDate: item.manufacturingDate ? parseDateOnly(item.manufacturingDate) : null,
        expiryDate: parseDateOnly(item.expiryDate),
      };
    });

    const totals = computeTotals(
      items.map((item) => item.totalPrice),
      dto,
    );
    if (totals === 'DISCOUNT_EXCEEDS_SUBTOTAL') throw badRequest('Chiết khấu lớn hơn tiền hàng');
    if (totals === 'PAID_EXCEEDS_TOTAL') throw badRequest('Số đã trả lớn hơn tổng tiền phiếu');

    return {
      header: {
        supplierId: dto.supplierId,
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : null,
        supplierInvoiceNo: dto.supplierInvoiceNo ?? null,
        supplierInvoiceDate: dto.supplierInvoiceDate ? parseDateOnly(dto.supplierInvoiceDate) : null,
        note: dto.note ?? null,
        ...totals,
      },
      items,
      warnings,
    };
  }

  /** K7: hạn dùng <= hôm nay (giờ VN) → cấm; còn dưới 90 ngày → cảnh báo, vẫn cho nhập. */
  private checkExpiry(batchNumber: string, expiry: string, today: string, warnings: string[]): void {
    const daysLeft = daysBetweenDateOnly(today, expiry);
    if (daysLeft <= 0) throw inventoryError(ErrorCode.BATCH_EXPIRED, `lô ${batchNumber} hết hạn ${expiry}`);
    if (daysLeft < NEAR_EXPIRY_WARNING_DAYS) {
      warnings.push(`Lô ${batchNumber} chỉ còn ${daysLeft} ngày sử dụng (hạn ${expiry})`);
    }
  }

  /** Một phiếu không được có hai dòng cùng sản phẩm + số lô: lô là một dòng tồn duy nhất, gộp số lượng vào một dòng. */
  private assertNoDuplicateBatchLines(items: readonly GoodsReceiptItemRequest[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.productId}|${item.batchNumber}`;
      if (seen.has(key)) throw badRequest(`Lô ${item.batchNumber} xuất hiện hai lần — gộp vào một dòng`);
      seen.add(key);
    }
  }

  private async assertBranchActive(tx: Prisma.TransactionClient, branchId: string): Promise<void> {
    const branch = await this.receipts.findBranch(tx, branchId);
    if (!branch) throw invalidReference('chi nhánh không tồn tại');
    if (branch.status !== RecordStatus.ACTIVE) throw inventoryError(ErrorCode.BRANCH_INACTIVE);
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
