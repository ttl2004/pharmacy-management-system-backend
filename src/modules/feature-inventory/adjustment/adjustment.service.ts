import { Injectable } from '@nestjs/common';
import {
  AdjustmentType,
  AuditAction,
  Prisma,
  ReceiptStatus,
  RecordStatus,
  StockMovementType,
  StockRefType,
} from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorCode } from 'src/common/types/error-code';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { DocumentCodeService } from '../core/document-code.service';
import {
  assertNoDuplicateBatches,
  badRequest,
  documentErrors,
  invalidReference,
  inventoryError,
} from '../core/inventory.error';
import { branchWhere, resolveWriteBranch } from '../core/inventory-scope';
import { InventoryTransactions, type InventoryTxContext } from '../core/inventory-transactions';
import { StockIntakeService } from '../core/stock-intake.service';
import { AUDIT_ENTITY, MAX_DOCUMENT_LINES } from '../core/inventory.constants';
import { LedgerEntry, StockLedgerService } from '../core/stock-ledger.service';
import {
  AdjustmentItemRequest,
  AdjustmentQuery,
  CancelAdjustmentRequest,
  CreateAdjustmentRequest,
  UpdateAdjustmentRequest,
} from './dtos/adjustment.request';
import { adjustmentListWhere, adjustmentOrderBy } from './adjustment-list-filters';
import { NO_RETURN_MONEY, PurchaseReturnMoneyService, type ReturnLineInput } from './purchase-return-money.service';
import { AdjustmentDetail, AdjustmentRepository, type DraftBatch } from './repositories/adjustment.repository';

/** Loại phiếu → loại bút toán sổ kho (bảng ánh xạ trong thiết kế CSDL). */
export const ADJUSTMENT_MOVEMENT_TYPE: Record<AdjustmentType, StockMovementType> = {
  STOCK_TAKE: StockMovementType.ADJUST,
  OTHER: StockMovementType.ADJUST,
  DISPOSE: StockMovementType.DISPOSE,
  RETURN_TO_SUPPLIER: StockMovementType.RETURN_OUT,
};

/**
 * Dòng phiếu nháp đã kiểm theo loại phiếu. Kiểm kê chỉ có số thực đếm (`actualQuantity`); các loại khác có sẵn delta
 * có dấu (`quantity`).
 */
interface DraftLine {
  batchId: string;
  actualQuantity: number | null;
  quantity: number;
  reason: string | null;
}

/**
 * Số sổ sách và chênh lệch của dòng, chốt LÚC LẬP PHIẾU (người dùng lập ngay sau khi đếm): sổ sách = tồn lô lúc đó,
 * chênh lệch = thực đếm − sổ sách. Lúc xác nhận chỉ CỘNG chênh lệch vào tồn hiện tại — hàng bán/nhập giữa lúc đếm và
 * lúc xác nhận được giữ nguyên. (Chốt sổ sách lúc xác nhận sẽ xoá mất các lượt bán/nhập đó.)
 */
function bookFigures(line: DraftLine, onHand: number): { systemQuantity: number | null; quantity: number } {
  if (line.actualQuantity === null) return { systemQuantity: null, quantity: line.quantity };
  return { systemQuantity: onHand, quantity: line.actualQuantity - onHand };
}

/** Giá trị hàng mất (đồng, số dương): Σ lượng giảm × giá vốn lô. Phần tăng (kiểm kê dư) không bù trừ. */
function lossValueOf(lines: readonly { quantity: number; unitCost: number }[]): number {
  return lines.reduce((sum, line) => sum + Math.max(-line.quantity, 0) * line.unitCost, 0);
}

/** Giá trả + dòng nhập gốc của một lô (chỉ phiếu trả NCC; loại khác để null). */
function lineMoneyOf(
  money: { lineMoney: Map<string, { returnPrice: number; goodsReceiptItemId: string | null }> } | null,
  batchId: string,
): { returnPrice: number | null; goodsReceiptItemId: string | null } {
  const found = money?.lineMoney.get(batchId);
  return { returnPrice: found?.returnPrice ?? null, goodsReceiptItemId: found?.goodsReceiptItemId ?? null };
}

/** Một bước đổi trạng thái phiếu, để ghi nhật ký. */
interface StatusChange {
  adjustmentId: string;
  branchId: string;
  from: ReceiptStatus;
  to: ReceiptStatus;
  reason?: string;
  lossValue?: number;
}

const errors = documentErrors('Phiếu điều chỉnh');

/**
 * Chứng từ cho mọi thay đổi tồn KHÔNG đến từ nhập/bán/điều chuyển: kiểm kê, huỷ hàng, trả NCC, điều chỉnh khác.
 * DRAFT → CONFIRMED (ghi sổ kho) hoặc → CANCELLED. Phiếu đã xác nhận: xuất huỷ / trả NCC / xuất nội bộ huỷ được (đảo
 * bút toán, như mock); kiểm kê đã cân bằng thì không — sai thì lập phiếu kiểm khác.
 */
@Injectable()
export class AdjustmentService {
  constructor(
    private readonly adjustments: AdjustmentRepository,
    private readonly transactions: InventoryTransactions,
    private readonly ledger: StockLedgerService,
    private readonly codes: DocumentCodeService,
    private readonly audit: AuditLogService,
    private readonly intake: StockIntakeService,
    private readonly returnMoney: PurchaseReturnMoneyService,
  ) {}

  /** Dòng phiếu trả cho bước tính tiền: lô đã đọc (đã chắc có — bước trước đã từ chối lô lạ) + SL đưa ra (dương). */
  private returnLines(
    requests: readonly AdjustmentItemRequest[],
    draftLines: readonly DraftLine[],
    batchById: Map<string, DraftBatch>,
  ): ReturnLineInput[] {
    return draftLines.map((line, index) => ({
      batch: batchById.get(line.batchId) as DraftBatch,
      quantity: -line.quantity,
      item: requests[index],
    }));
  }

  /** Trả NCC kèm `summary` = tổng MỌI phiếu khớp lọc (trừ phiếu huỷ) cho dòng tổng của danh sách (như mock). */
  async list(query: AdjustmentQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const where = adjustmentListWhere(query, branchId);
    const page = await this.adjustments.findPage(where, query.page, query.limit, adjustmentOrderBy(query.sort));
    if (query.type !== AdjustmentType.RETURN_TO_SUPPLIER) return page;
    return { ...page, summary: await this.adjustments.returnSummary(where) };
  }

  /** Cảnh báo lô mới / lô đổi tồn của phiếu kiểm kê (chỉ đọc). */
  async stockTakeWarnings(id: string, actor: RequestActor) {
    const result = await this.adjustments.findStockTakeWarnings(id, branchWhere(resolveBranchScope(actor.user)));
    if (!result) throw errors.notFound();
    return result;
  }

  /** Nhân sự chọn làm người xuất/trả/nhận → [{id, fullName}]; PM bị ép về chi nhánh mình. */
  staff(branchId: string | undefined, actor: RequestActor) {
    return this.adjustments.findStaffCandidates(scopedBranchFilter(resolveBranchScope(actor.user), branchId));
  }

  /** Bật/tắt sao — cờ chung của phiếu (như mock), ai đọc được phiếu là đổi được, không ghi nhật ký. */
  async setFavourite(id: string, wanted: boolean | undefined, actor: RequestActor): Promise<{ isFavourite: boolean }> {
    const scope = branchWhere(resolveBranchScope(actor.user));
    const current = await this.adjustments.findDetail(id, scope);
    if (!current) throw errors.notFound();
    const isFavourite = wanted ?? !current.isFavourite;
    await this.adjustments.setFavourite(id, scope, isFavourite);
    return { isFavourite };
  }

  async getDetail(id: string, actor: RequestActor): Promise<AdjustmentDetail> {
    const adjustment = await this.adjustments.findDetail(id, branchWhere(resolveBranchScope(actor.user)));
    if (!adjustment) throw errors.notFound();
    return adjustment;
  }

  async create(dto: CreateAdjustmentRequest, actor: RequestActor): Promise<AdjustmentDetail> {
    const branchId = resolveWriteBranch(resolveBranchScope(actor.user), dto.branchId);
    const actorId = actor.user.userId;
    if (dto.items.length > MAX_DOCUMENT_LINES) {
      throw inventoryError(ErrorCode.DOCUMENT_LINE_LIMIT, `tối đa ${MAX_DOCUMENT_LINES} dòng`);
    }
    const batchIds = dto.items.map((item) => item.batchId);
    assertNoDuplicateBatches(batchIds);
    const draftLines = dto.items.map((item, index) => this.toDraftLine(dto.type, item, index));
    const isReturn = dto.type === AdjustmentType.RETURN_TO_SUPPLIER;
    if (isReturn && !dto.supplierId) throw badRequest('Phiếu trả hàng phải chọn nhà cung cấp');
    if (!isReturn && dto.supplierId) throw badRequest('Chỉ phiếu trả hàng mới chọn nhà cung cấp');
    if (!isReturn) this.returnMoney.assertNoMoney(dto);
    const isOther = dto.type === AdjustmentType.OTHER;
    if (!isOther && (dto.receiverId || dto.internalUseTypeId)) {
      throw badRequest('Người nhận, loại xuất chỉ dùng cho phiếu xuất dùng nội bộ');
    }

    return this.transactions.run(async ({ tx }) => {
      const branch = await this.adjustments.findBranch(tx, branchId);
      if (!branch) throw invalidReference('chi nhánh không tồn tại');
      if (branch.status !== RecordStatus.ACTIVE) throw inventoryError(ErrorCode.BRANCH_INACTIVE);
      if (dto.supplierId && !(await this.adjustments.findSupplier(tx, dto.supplierId))) {
        throw invalidReference('nhà cung cấp không tồn tại');
      }
      await this.assertHeaderRefs(tx, dto, branchId);

      // Kiểm kê khoá lô: hai lần lập cùng lúc trên một lô chạy nối tiếp, lần sau thấy phiếu nháp của lần trước.
      // Loại phiếu khác không chốt số sổ sách nên chỉ đọc, không giữ khoá làm chậm bán hàng.
      const isStockTake = dto.type === AdjustmentType.STOCK_TAKE;
      const batches = isStockTake
        ? await this.adjustments.lockBatches(tx, branchId, batchIds)
        : await this.adjustments.findBatches(tx, branchId, batchIds);
      const batchById = new Map(batches.map((batch) => [batch.id, batch]));
      const items = draftLines.map((line, index) => {
        const batch = batchById.get(line.batchId);
        if (!batch) throw invalidReference(`dòng ${index + 1}: lô không thuộc chi nhánh`);
        // Giá vốn chốt lúc xác nhận (giá lô lúc đó), nháp để 0.
        return {
          batchId: line.batchId,
          productId: batch.productId,
          actualQuantity: line.actualQuantity,
          ...bookFigures(line, batch.quantityOnHand),
          unitCost: 0,
          reason: line.reason,
        };
      });
      // Sau bước kiểm chi nhánh: lô của chi nhánh khác đã bị từ chối (1602), không lộ phiếu nháp của họ.
      if (isStockTake) await this.assertNoPendingStockTake(tx, batchIds);
      const money = isReturn
        ? await this.returnMoney.build(tx, {
            dto, branchId, supplierId: dto.supplierId as string, lines: this.returnLines(dto.items, draftLines, batchById),
          })
        : null;

      const code = dto.code?.trim() || (await this.codes.next(tx, 'STOCK_ADJUSTMENT'));
      if (dto.code?.trim() && (await this.adjustments.codeExists(tx, code))) {
        throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Mã phiếu ${code} đã được dùng` });
      }
      const { id } = await this.adjustments.createHeader(tx, {
        code,
        branchId,
        type: dto.type,
        supplierId: dto.supplierId ?? null,
        reason: dto.reason,
        note: dto.note ?? null,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : new Date(),
        handlerId: dto.handlerId ?? null,
        receiverId: dto.receiverId ?? null,
        internalUseTypeId: dto.internalUseTypeId ?? null,
        ...(money?.header ?? NO_RETURN_MONEY),
        createdBy: actorId,
      });
      await this.adjustments.createItems(
        tx,
        items.map((item) => ({ ...item, ...lineMoneyOf(money, item.batchId), adjustmentId: id, createdBy: actorId })),
      );
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.CREATE,
          entityType: AUDIT_ENTITY.STOCK_ADJUSTMENT,
          entityId: id,
          branchId,
          after: { code, type: dto.type, lines: items.length },
          reason: dto.reason,
          ipAddress: actor.ip,
        },
      ]);
      return this.mustFind(tx, id);
    });
  }

  /**
   * Sửa phiếu NHÁP (thay toàn bộ như tạo, như mock PUT). Chiếm phiếu bằng cập nhật có điều kiện DRAFT trước (lần sửa
   * chạy song song với xác nhận/huỷ → 1701). Kiểm kê: khoá lô, số sổ sách chụp lại lúc lưu (như mock — hàng thêm mới
   * chụp tồn lúc lưu; giữ lô cũ thì giá trị chụp lại cũng là tồn hiện tại), phiếu khác giữ lô → 1711.
   */
  async update(id: string, dto: UpdateAdjustmentRequest, actor: RequestActor): Promise<AdjustmentDetail> {
    const actorId = actor.user.userId;
    if (dto.items.length > MAX_DOCUMENT_LINES) {
      throw inventoryError(ErrorCode.DOCUMENT_LINE_LIMIT, `tối đa ${MAX_DOCUMENT_LINES} dòng`);
    }
    const batchIds = dto.items.map((item) => item.batchId);
    assertNoDuplicateBatches(batchIds);

    return this.transactions.run(async ({ tx }) => {
      const head = await this.adjustments.findHead(tx, id, branchWhere(resolveBranchScope(actor.user)));
      if (!head) throw errors.notFound();
      if (head.status !== ReceiptStatus.DRAFT) throw errors.wrongState(head.status);
      const claimed = await this.adjustments.transition(tx, id, ReceiptStatus.DRAFT, { updatedAt: new Date(), updatedBy: actorId });
      if (!claimed) throw errors.wrongState();

      const isReturn = head.type === AdjustmentType.RETURN_TO_SUPPLIER;
      if (isReturn && !dto.supplierId) throw badRequest('Phiếu trả hàng phải chọn nhà cung cấp');
      if (!isReturn && dto.supplierId) throw badRequest('Chỉ phiếu trả hàng mới chọn nhà cung cấp');
      if (!isReturn) this.returnMoney.assertNoMoney(dto);
      if (head.type !== AdjustmentType.OTHER && (dto.receiverId || dto.internalUseTypeId)) {
        throw badRequest('Người nhận, loại xuất chỉ dùng cho phiếu xuất dùng nội bộ');
      }
      if (dto.supplierId && !(await this.adjustments.findSupplier(tx, dto.supplierId))) {
        throw invalidReference('nhà cung cấp không tồn tại');
      }
      await this.assertHeaderRefs(tx, dto, head.branchId);

      const draftLines = dto.items.map((item, index) => this.toDraftLine(head.type, item, index));
      const isStockTake = head.type === AdjustmentType.STOCK_TAKE;
      const batches = isStockTake
        ? await this.adjustments.lockBatches(tx, head.branchId, batchIds)
        : await this.adjustments.findBatches(tx, head.branchId, batchIds);
      const batchById = new Map(batches.map((batch) => [batch.id, batch]));
      const items = draftLines.map((line, index) => {
        const batch = batchById.get(line.batchId);
        if (!batch) throw invalidReference(`dòng ${index + 1}: lô không thuộc chi nhánh`);
        return {
          adjustmentId: id,
          batchId: line.batchId,
          productId: batch.productId,
          actualQuantity: line.actualQuantity,
          ...bookFigures(line, batch.quantityOnHand),
          unitCost: 0,
          reason: line.reason,
          createdBy: actorId,
        };
      });
      if (isStockTake) {
        const pending = await this.adjustments.findPendingStockTake(tx, batchIds, id);
        if (pending) {
          throw inventoryError(ErrorCode.STOCK_TAKE_PENDING, `lô ${pending.batchNumber} đang nằm trong phiếu ${pending.code}`);
        }
      }
      const money = isReturn
        ? await this.returnMoney.build(tx, {
            dto, branchId: head.branchId, supplierId: dto.supplierId as string, excludeId: id,
            lines: this.returnLines(dto.items, draftLines, batchById),
          })
        : null;

      const code = dto.code?.trim();
      if (code && (await this.adjustments.codeExists(tx, code, id))) {
        throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Mã phiếu ${code} đã được dùng` });
      }
      await this.adjustments.transition(tx, id, ReceiptStatus.DRAFT, {
        ...(code ? { code } : {}),
        supplierId: dto.supplierId ?? null,
        reason: dto.reason,
        note: dto.note ?? null,
        ...(dto.documentDate ? { documentDate: new Date(dto.documentDate) } : {}),
        handlerId: dto.handlerId ?? null,
        receiverId: dto.receiverId ?? null,
        internalUseTypeId: dto.internalUseTypeId ?? null,
        ...(money?.header ?? NO_RETURN_MONEY),
      });
      await this.adjustments.replaceItems(tx, id, items.map((item) => ({ ...item, ...lineMoneyOf(money, item.batchId) })));
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.UPDATE,
          entityType: AUDIT_ENTITY.STOCK_ADJUSTMENT,
          entityId: id,
          branchId: head.branchId,
          after: { lines: items.length },
          reason: dto.reason,
          ipAddress: actor.ip,
        },
      ]);
      return this.mustFind(tx, id);
    });
  }

  /**
   * DRAFT → CONFIRMED: khoá lô, chốt giá vốn, ghi chênh lệch đã lưu từ lúc lập phiếu vào sổ kho. Lô bị khoá/thu hồi
   * VẪN điều chỉnh được — huỷ lô bị thu hồi chính là việc phải làm. Không kiểm chi nhánh còn hoạt động: chi nhánh sắp
   * đóng vẫn phải huỷ/trả được hàng tồn.
   */
  async confirm(id: string, actor: RequestActor): Promise<AdjustmentDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const head = await this.adjustments.findHead(tx, id, branchWhere(scope));
      if (!head) throw errors.notFound();
      if (head.status !== ReceiptStatus.DRAFT) throw errors.wrongState(head.status);

      // Chiếm phiếu trước mọi việc khác: bấm đúp dừng ở đây với 1701.
      // Thứ tự khoá: bản ghi phiếu (stock_adjustments) → các lô theo id — cùng thứ tự với nhập/điều chuyển.
      const claimed = await this.adjustments.transition(tx, id, ReceiptStatus.DRAFT, {
        status: ReceiptStatus.CONFIRMED,
        confirmedAt: now,
        confirmedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      });
      if (!claimed) throw errors.wrongState();

      const items = await this.adjustments.findItems(tx, id);
      if (head.type === AdjustmentType.RETURN_TO_SUPPLIER) {
        await this.returnMoney.lockSupplierOf(tx, id);
        // Trả theo phiếu nhập: kiểm lại trần SL / chi phí hoàn (phiếu trả khác có thể đã xác nhận sau lúc lưu nháp).
        if (head.goodsReceiptId) {
          await this.returnMoney.recheckOnConfirm(tx, id, head.goodsReceiptId, items, head.refundExpenses);
        }
      }
      const batchIds = items.map((item) => item.batchId);
      const locked = await this.ledger.lockBatches(ctx, batchIds);
      const batchById = new Map(locked.map((batch) => [batch.id, batch]));

      const finalized = items.map((item) => {
        const batch = batchById.get(item.batchId);
        if (!batch) throw new Error(`Lô ${item.batchId} của phiếu điều chỉnh không còn tồn tại`);
        return { ...item, unitCost: batch.importPrice };
      });
      await this.adjustments.freezeUnitCosts(tx, finalized, actorId);

      // Dòng kiểm kê khớp sổ (chênh 0) vẫn lưu trong biên bản nhưng không sinh bút toán.
      const entries: LedgerEntry[] = finalized
        .filter((item) => item.quantity !== 0)
        .map((item) => ({
          batchId: item.batchId,
          type: ADJUSTMENT_MOVEMENT_TYPE[head.type],
          quantity: item.quantity,
          unitCost: item.unitCost,
          refType: StockRefType.STOCK_ADJUSTMENT,
          refId: id,
          refItemId: item.id,
          note: item.reason,
        }));
      await this.ledger.apply(ctx, entries, actorId, { preLocked: locked });

      await this.recordStatus(tx, actor, {
        adjustmentId: id,
        branchId: head.branchId,
        from: ReceiptStatus.DRAFT,
        to: ReceiptStatus.CONFIRMED,
        lossValue: lossValueOf(finalized),
      });
      return this.mustFind(tx, id);
    });
  }

  async cancel(id: string, dto: CancelAdjustmentRequest, actor: RequestActor): Promise<AdjustmentDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const head = await this.adjustments.findHead(tx, id, branchWhere(scope));
      if (!head) throw errors.notFound();
      // Phiếu đã xác nhận (trừ kiểm kê — biên bản cân bằng, như mock): huỷ = đảo bút toán về đúng lô.
      if (head.status === ReceiptStatus.CONFIRMED && head.type !== AdjustmentType.STOCK_TAKE) {
        return this.cancelConfirmed(ctx, head, dto.reason, actor);
      }
      if (head.status !== ReceiptStatus.DRAFT) throw errors.wrongState(head.status);
      const claimed = await this.adjustments.transition(tx, id, ReceiptStatus.DRAFT, {
        status: ReceiptStatus.CANCELLED,
        cancelledAt: now,
        cancelledBy: actorId,
        cancelReason: dto.reason,
        updatedAt: now,
        updatedBy: actorId,
      });
      if (!claimed) throw errors.wrongState();
      await this.recordStatus(tx, actor, {
        adjustmentId: id,
        branchId: head.branchId,
        from: ReceiptStatus.DRAFT,
        to: ReceiptStatus.CANCELLED,
        reason: dto.reason,
      });
      return this.mustFind(tx, id);
    });
  }

  /**
   * Kiểm trường bắt buộc theo loại phiếu (DTO không diễn đạt được "bắt buộc tuỳ loại") và đổi về dòng nháp:
   * - Kiểm kê: chỉ có số thực đếm; sổ sách và chênh lệch tính khi đã đọc lô (`bookFigures`).
   * - Huỷ / trả NCC: người dùng nhập số dương (lượng đưa ra), lưu sẵn delta âm.
   * - Khác: lưu nguyên delta có dấu.
   */
  private toDraftLine(type: AdjustmentType, item: AdjustmentItemRequest, index: number): DraftLine {
    const label = `Dòng ${index + 1}`;
    const common = { batchId: item.batchId, reason: item.reason ?? null };

    if (type === AdjustmentType.STOCK_TAKE) {
      if (item.actualQuantity === undefined) throw badRequest(`${label}: kiểm kê phải có actualQuantity`);
      if (item.quantity !== undefined) {
        throw badRequest(`${label}: kiểm kê không gửi quantity — server tự tính chênh lệch`);
      }
      return { ...common, actualQuantity: item.actualQuantity, quantity: 0 };
    }

    if (item.actualQuantity !== undefined) throw badRequest(`${label}: actualQuantity chỉ dùng cho kiểm kê`);
    if (item.quantity === undefined || item.quantity === 0) throw badRequest(`${label}: phải có quantity khác 0`);
    if (type === AdjustmentType.OTHER) return { ...common, actualQuantity: null, quantity: item.quantity };
    if (item.quantity < 0) {
      throw badRequest(`${label}: huỷ/trả NCC nhập số dương — là số lượng đưa ra khỏi kho`);
    }
    return { ...common, actualQuantity: null, quantity: -item.quantity };
  }

  /**
   * Mỗi lô chỉ có MỘT phiếu kiểm kê nháp tại một thời điểm. Chênh lệch chốt lúc lập phiếu, nên hai phiếu nháp cùng
   * lô (bấm đúp, hai người cùng đếm) mà đều được xác nhận thì chênh lệch bị cộng hai lần.
   */
  private async assertNoPendingStockTake(tx: Prisma.TransactionClient, batchIds: readonly string[]): Promise<void> {
    const pending = await this.adjustments.findPendingStockTake(tx, batchIds);
    if (pending) {
      throw inventoryError(
        ErrorCode.STOCK_TAKE_PENDING,
        `lô ${pending.batchNumber} đang nằm trong phiếu ${pending.code}`,
      );
    }
  }

  /** Nhật ký đổi trạng thái phiếu (cùng dạng với phiếu điều chuyển). */
  private recordStatus(tx: Prisma.TransactionClient, actor: RequestActor, change: StatusChange) {
    return this.audit.record(tx, [
      {
        actorId: actor.user.userId,
        action: AuditAction.STATUS_CHANGE,
        entityType: AUDIT_ENTITY.STOCK_ADJUSTMENT,
        entityId: change.adjustmentId,
        branchId: change.branchId,
        before: { status: change.from },
        after:
          change.lossValue === undefined ? { status: change.to } : { status: change.to, lossValue: change.lossValue },
        reason: change.reason ?? null,
        ipAddress: actor.ip,
      },
    ]);
  }

  /**
   * CONFIRMED → CANCELLED cho xuất huỷ / trả NCC / xuất nội bộ. Bút toán đảo dùng đúng giá vốn đã chốt trên dòng:
   * dòng từng XUẤT (delta âm) → hoàn về lô qua `returnToBatches` (bình quân lại giá vốn); dòng từng NHẬP (OTHER dương)
   * → trừ ra qua sổ kho (thiếu tồn → 1700, rollback). Chiếm phiếu bằng cập nhật có điều kiện CONFIRMED (bấm đúp → 1701).
   */
  private async cancelConfirmed(
    ctx: InventoryTxContext,
    head: { id: string; type: AdjustmentType; branchId: string },
    reason: string,
    actor: RequestActor,
  ): Promise<AdjustmentDetail> {
    const { tx } = ctx;
    const actorId = actor.user.userId;
    const now = new Date();
    const claimed = await this.adjustments.transition(tx, head.id, ReceiptStatus.CONFIRMED, {
      status: ReceiptStatus.CANCELLED, cancelledAt: now, cancelledBy: actorId, cancelReason: reason,
      updatedAt: now, updatedBy: actorId,
    });
    if (!claimed) throw errors.wrongState();
    // Huỷ phiếu trả NCC làm công nợ tăng lại → khoá NCC như lúc xác nhận.
    if (head.type === AdjustmentType.RETURN_TO_SUPPLIER) await this.returnMoney.lockSupplierOf(tx, head.id);

    const items = (await this.adjustments.findItems(tx, head.id)).filter((item) => item.quantity !== 0);
    const type = ADJUSTMENT_MOVEMENT_TYPE[head.type];
    const note = `Huỷ phiếu: ${reason}`;
    const outflows = items.filter((item) => item.quantity < 0);
    const inflows = items.filter((item) => item.quantity > 0);
    await this.intake.returnToBatches(ctx, {
      type, refType: StockRefType.STOCK_ADJUSTMENT, refId: head.id, actorId, note,
      lines: outflows.map((item) => ({ batchId: item.batchId, quantity: -item.quantity, unitCost: item.unitCost, refItemId: item.id })),
    });
    if (inflows.length) {
      await this.ledger.apply(
        ctx,
        inflows.map((item) => ({
          batchId: item.batchId, type, quantity: -item.quantity, unitCost: item.unitCost,
          refType: StockRefType.STOCK_ADJUSTMENT, refId: head.id, refItemId: item.id, note,
        })),
        actorId,
      );
    }
    await this.recordStatus(tx, actor, {
      adjustmentId: head.id, branchId: head.branchId, from: ReceiptStatus.CONFIRMED, to: ReceiptStatus.CANCELLED, reason,
    });
    return this.mustFind(tx, head.id);
  }

  /** Người xuất/nhận phải là nhân sự của chi nhánh phiếu (hoặc ADMIN); loại xuất phải còn trong danh mục. */
  private async assertHeaderRefs(
    tx: Prisma.TransactionClient,
    dto: { handlerId?: string; receiverId?: string; internalUseTypeId?: string },
    branchId: string,
  ): Promise<void> {
    for (const [userId, label] of [[dto.handlerId, 'người xuất/trả'], [dto.receiverId, 'người nhận']] as const) {
      if (userId && !(await this.adjustments.isValidStaff(tx, userId, branchId))) {
        throw invalidReference(`${label} không thuộc chi nhánh hoặc đã ngừng hoạt động`);
      }
    }
    if (dto.internalUseTypeId && !(await this.adjustments.findInternalUseType(tx, dto.internalUseTypeId))) {
      throw invalidReference('loại xuất không tồn tại');
    }
  }

  private async mustFind(tx: Prisma.TransactionClient, id: string): Promise<AdjustmentDetail> {
    const adjustment = await this.adjustments.findDetail(id, {}, tx);
    if (!adjustment) throw errors.notFound();
    return adjustment;
  }
}
