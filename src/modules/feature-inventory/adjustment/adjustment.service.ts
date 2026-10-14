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
import { addDaysToDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
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
import { InventoryTransactions } from '../core/inventory-transactions';
import { AUDIT_ENTITY, MAX_DOCUMENT_LINES } from '../core/inventory.constants';
import { LedgerEntry, StockLedgerService } from '../core/stock-ledger.service';
import {
  AdjustmentItemRequest,
  AdjustmentQuery,
  CancelAdjustmentRequest,
  CreateAdjustmentRequest,
} from './dtos/adjustment.request';
import { AdjustmentDetail, AdjustmentRepository } from './repositories/adjustment.repository';

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
 * DRAFT → CONFIRMED (ghi sổ kho) hoặc → CANCELLED. Phiếu đã xác nhận KHÔNG huỷ được — sai thì lập phiếu khác bù lại,
 * vì phiếu kiểm kê/huỷ là biên bản đã ký.
 */
@Injectable()
export class AdjustmentService {
  constructor(
    private readonly adjustments: AdjustmentRepository,
    private readonly transactions: InventoryTransactions,
    private readonly ledger: StockLedgerService,
    private readonly codes: DocumentCodeService,
    private readonly audit: AuditLogService,
  ) {}

  list(query: AdjustmentQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const where: Prisma.StockAdjustmentWhereInput = {};
    if (branchId) where.branchId = branchId;
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.fromDate || query.toDate) {
      where.createdAt = {
        ...(query.fromDate ? { gte: vietnamDayStartUtc(query.fromDate) } : {}),
        ...(query.toDate ? { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } : {}),
      };
    }
    if (query.search) where.code = { contains: query.search, mode: 'insensitive' };
    return this.adjustments.findPage(where, query.page, query.limit);
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

    return this.transactions.run(async ({ tx }) => {
      const branch = await this.adjustments.findBranch(tx, branchId);
      if (!branch) throw invalidReference('chi nhánh không tồn tại');
      if (branch.status !== RecordStatus.ACTIVE) throw inventoryError(ErrorCode.BRANCH_INACTIVE);
      if (dto.supplierId && !(await this.adjustments.findSupplier(tx, dto.supplierId))) {
        throw invalidReference('nhà cung cấp không tồn tại');
      }

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

      const code = await this.codes.next(tx, 'STOCK_ADJUSTMENT');
      const { id } = await this.adjustments.createHeader(tx, {
        code,
        branchId,
        type: dto.type,
        supplierId: dto.supplierId ?? null,
        reason: dto.reason,
        note: dto.note ?? null,
        createdBy: actorId,
      });
      await this.adjustments.createItems(
        tx,
        items.map((item) => ({ ...item, adjustmentId: id, createdBy: actorId })),
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

    return this.transactions.run(async ({ tx }) => {
      const head = await this.adjustments.findHead(tx, id, branchWhere(scope));
      if (!head) throw errors.notFound();
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

  private async mustFind(tx: Prisma.TransactionClient, id: string): Promise<AdjustmentDetail> {
    const adjustment = await this.adjustments.findDetail(id, {}, tx);
    if (!adjustment) throw errors.notFound();
    return adjustment;
  }
}
