import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  BatchStatus,
  Prisma,
  RecordStatus,
  StockMovementType,
  StockRefType,
  TransferStatus,
} from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorCode } from 'src/common/types/error-code';
import {
  addDaysToDateOnly,
  daysBetweenDateOnly,
  toDateOnlyString,
  todayInVietnam,
  vietnamDayStartUtc,
} from 'src/common/utils/date-only.util';
import { permissionError } from 'src/modules/feature-auth/permission/permission.error';
import { BranchScope, isInBranchScope, resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { DocumentCodeService } from '../core/document-code.service';
import { assertNoDuplicateBatches, documentErrors, invalidReference, inventoryError } from '../core/inventory.error';
import { resolveWriteBranch, TransferSide, transferWhere } from '../core/inventory-scope';
import { InventoryTransactions } from '../core/inventory-transactions';
import { AUDIT_ENTITY, MAX_DOCUMENT_LINES } from '../core/inventory.constants';
import { StockIntakeService } from '../core/stock-intake.service';
import type { LockedBatch } from '../core/stock-ledger.repository';
import { StockLedgerService } from '../core/stock-ledger.service';
import { CancelTransferRequest, CreateTransferRequest, TransferQuery } from './dtos/transfer.request';
import { TransferDetail, TransferHead, TransferRepository } from './repositories/transfer.repository';

interface StatusChange {
  transferId: string;
  branchId: string;
  from: TransferStatus;
  to: TransferStatus;
  reason?: string;
}

/**
 * Giá vốn mỗi dòng đã chốt lúc xuất (bút toán TRANSFER_OUT). Phiếu đã xuất mà thiếu giá là lỗi lập trình, không phải lỗi
 * nghiệp vụ — báo lỗi ngay thay vì âm thầm nhận hàng với giá vốn 0.
 */
function shipCostOf(costs: Map<string, number | null>, itemId: string): number {
  const cost = costs.get(itemId);
  if (cost === undefined || cost === null) throw new Error(`Dòng điều chuyển ${itemId} không có giá vốn lúc xuất`);
  return cost;
}

/** Lô ở chi nhánh nhận của từng dòng. `intake` luôn trả đủ; thiếu là lỗi lập trình (tránh ghi NULL vào toBatchId). */
function destinationBatchOf(batchIdByRefItem: Map<string, string>, itemId: string): string {
  const batchId = batchIdByRefItem.get(itemId);
  if (!batchId) throw new Error(`Dòng điều chuyển ${itemId} không có lô nhận`);
  return batchId;
}

/** Lọc danh sách theo chiều: PM chọn phiếu mình gửi đi / nhận về; không chọn thì thấy cả hai. */
function sideOf(direction: TransferQuery['direction']): TransferSide {
  if (direction === 'outgoing') return 'from';
  if (direction === 'incoming') return 'to';
  return 'either';
}

const errors = documentErrors('Phiếu điều chuyển');

/**
 * Điều chuyển giữa hai chi nhánh: PENDING → IN_TRANSIT (trừ kho gửi) → RECEIVED (cộng kho nhận) / CANCELLED.
 *
 * - Lập/xuất/huỷ: chi nhánh GỬI. Nhận: chi nhánh NHẬN. Đọc: cả hai (ma trận kho).
 * - Hàng rời kho gửi ngay lúc xuất — không bán nhầm hàng đang trên đường.
 * - K5: huỷ khi đang IN_TRANSIT → hoàn về ĐÚNG lô gửi bằng bút toán TRANSFER_IN.
 * - K6: không nhận thiếu — nhận đủ cả phiếu hoặc huỷ.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly transfers: TransferRepository,
    private readonly transactions: InventoryTransactions,
    private readonly ledger: StockLedgerService,
    private readonly intake: StockIntakeService,
    private readonly codes: DocumentCodeService,
    private readonly audit: AuditLogService,
  ) {}

  list(query: TransferQuery, actor: RequestActor) {
    const scope = resolveBranchScope(actor.user);
    const conditions: Prisma.StockTransferWhereInput[] = [transferWhere(scope, sideOf(query.direction))];
    if (query.fromBranchId) conditions.push({ fromBranchId: query.fromBranchId });
    if (query.toBranchId) conditions.push({ toBranchId: query.toBranchId });
    if (query.status) conditions.push({ status: query.status });
    if (query.fromDate) conditions.push({ createdAt: { gte: vietnamDayStartUtc(query.fromDate) } });
    if (query.toDate) conditions.push({ createdAt: { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } });
    if (query.search) conditions.push({ code: { contains: query.search, mode: 'insensitive' } });
    return this.transfers.findPage({ AND: conditions }, query.page, query.limit);
  }

  async getDetail(id: string, actor: RequestActor): Promise<TransferDetail> {
    const transfer = await this.transfers.findDetail(id, transferWhere(resolveBranchScope(actor.user), 'either'));
    if (!transfer) throw errors.notFound();
    return transfer;
  }

  async create(dto: CreateTransferRequest, actor: RequestActor): Promise<TransferDetail> {
    const scope = resolveBranchScope(actor.user);
    const fromBranchId = resolveWriteBranch(scope, dto.fromBranchId, 'Cần chọn chi nhánh gửi (fromBranchId)');
    const actorId = actor.user.userId;
    if (fromBranchId === dto.toBranchId) throw inventoryError(ErrorCode.TRANSFER_SAME_BRANCH);
    if (dto.items.length > MAX_DOCUMENT_LINES) {
      throw inventoryError(ErrorCode.DOCUMENT_LINE_LIMIT, `tối đa ${MAX_DOCUMENT_LINES} dòng`);
    }
    const batchIds = dto.items.map((item) => item.batchId);
    assertNoDuplicateBatches(batchIds);

    return this.transactions.run(async ({ tx }) => {
      await this.assertBranchesActive(tx, [fromBranchId, dto.toBranchId]);
      const batches = await this.transfers.findBatches(tx, batchIds);
      const batchById = new Map(batches.map((batch) => [batch.id, batch]));
      const today = todayInVietnam();

      const items = dto.items.map((item, index) => {
        const batch = batchById.get(item.batchId);
        if (!batch || batch.branchId !== fromBranchId) {
          throw invalidReference(`dòng ${index + 1}: lô không thuộc chi nhánh gửi`);
        }
        this.assertBatchShippable(batch, today);
        // Kiểm sớm cho người dùng biết ngay; kiểm thật (có khoá) nằm ở lúc xuất hàng.
        if (batch.quantityOnHand - batch.reservedQuantity < item.quantity) {
          throw inventoryError(ErrorCode.INSUFFICIENT_STOCK, `lô ${batch.batchNumber}`);
        }
        return { batchId: item.batchId, productId: batch.productId, quantity: item.quantity, note: item.note ?? null };
      });

      const code = await this.codes.next(tx, 'STOCK_TRANSFER');
      const { id } = await this.transfers.createHeader(tx, {
        code,
        fromBranchId,
        toBranchId: dto.toBranchId,
        note: dto.note ?? null,
        createdBy: actorId,
      });
      await this.transfers.createItems(
        tx,
        items.map((item) => ({ ...item, transferId: id, createdBy: actorId })),
      );
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.CREATE,
          entityType: AUDIT_ENTITY.STOCK_TRANSFER,
          entityId: id,
          branchId: fromBranchId,
          after: { code, toBranchId: dto.toBranchId, lines: items.length },
          ipAddress: actor.ip,
        },
      ]);
      return this.mustFind(tx, id);
    });
  }

  /** PENDING → IN_TRANSIT: khoá lô gửi, kiểm lại trạng thái/hạn/tồn, ghi TRANSFER_OUT (âm). */
  async ship(id: string, actor: RequestActor): Promise<TransferDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const head = await this.loadForSide(tx, id, scope, 'from');
      if (head.status !== TransferStatus.PENDING) throw errors.wrongState(head.status);
      // Xuất cần cả hai chi nhánh còn hoạt động: không gửi hàng tới nơi đã ngừng nhận.
      await this.assertBranchesActive(tx, [head.fromBranchId, head.toBranchId]);

      // Chiếm phiếu trước mọi việc khác: request thứ hai (bấm đúp) dừng ở đây với 1701, không trừ kho lần hai.
      // Thứ tự khoá luôn là dòng phiếu → các lô (theo id), giống phiếu nhập, nên hai thao tác không khoá chéo nhau.
      const claimed = await this.transfers.transition(tx, id, TransferStatus.PENDING, {
        status: TransferStatus.IN_TRANSIT,
        shippedAt: now,
        shippedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      });
      if (!claimed) throw errors.wrongState();

      const items = await this.transfers.findItems(tx, id);
      const batchIds = items.map((item) => item.batchId);
      const locked = await this.ledger.lockBatches(ctx, batchIds);
      const batchById = new Map(locked.map((batch) => [batch.id, batch]));
      const today = todayInVietnam();
      const entries = items.map((item) => {
        const batch = batchById.get(item.batchId);
        if (!batch) throw new Error(`Lô ${item.batchId} của phiếu điều chuyển không còn tồn tại`);
        this.assertBatchShippable(batch, today);
        return {
          batchId: item.batchId,
          type: StockMovementType.TRANSFER_OUT,
          quantity: -item.quantity,
          unitCost: batch.importPrice,
          refType: StockRefType.STOCK_TRANSFER,
          refId: id,
          refItemId: item.id,
        };
      });
      await this.ledger.apply(ctx, entries, actorId, { preLocked: locked });

      await this.recordStatus(tx, actor, {
        transferId: id,
        branchId: head.fromBranchId,
        from: TransferStatus.PENDING,
        to: TransferStatus.IN_TRANSIT,
      });
      return this.mustFind(tx, id);
    });
  }

  /** IN_TRANSIT → RECEIVED: tạo/gộp lô cùng số ở chi nhánh nhận (giá vốn chốt lúc xuất), ghi TRANSFER_IN. */
  async receive(id: string, actor: RequestActor): Promise<TransferDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const head = await this.loadForSide(tx, id, scope, 'to');
      if (head.status !== TransferStatus.IN_TRANSIT) throw errors.wrongState(head.status);
      // Chỉ chi nhánh nhận cần hoạt động; chi nhánh gửi đã giao xong hàng từ lúc xuất.
      await this.assertBranchesActive(tx, [head.toBranchId]);

      // Chiếm phiếu trước (bấm đúp → 1701), rồi mới khoá lô ở chi nhánh nhận.
      const claimed = await this.transfers.transition(tx, id, TransferStatus.IN_TRANSIT, {
        status: TransferStatus.RECEIVED,
        receivedAt: now,
        receivedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      });
      if (!claimed) throw errors.wrongState();

      const items = await this.transfers.findItems(tx, id);
      const costs = await this.transfers.findShipCosts(tx, id);
      // `intake` cần mỗi (sản phẩm, số lô) xuất hiện một lần: lúc lập phiếu đã cấm trùng lô, và mỗi lô gửi là duy nhất
      // theo (chi nhánh, sản phẩm, số lô).
      const { batchIdByRefItem } = await this.intake.intake(ctx, {
        branchId: head.toBranchId,
        type: StockMovementType.TRANSFER_IN,
        refType: StockRefType.STOCK_TRANSFER,
        refId: id,
        actorId,
        lines: items.map((item) => ({
          productId: item.productId,
          batchNumber: item.batch.batchNumber,
          manufacturingDate: item.batch.manufacturingDate,
          expiryDate: item.batch.expiryDate,
          quantity: item.quantity,
          unitCost: shipCostOf(costs, item.id),
          // Truy vết: lô MỚI sinh ra ở chi nhánh nhận mang NCC của lô gốc; gộp vào lô đã có thì lô đó giữ NCC của nó.
          supplierId: item.batch.supplierId,
          goodsReceiptItemId: null,
          refItemId: item.id,
        })),
      });
      await this.transfers.setToBatchIds(
        tx,
        items.map((item) => ({ itemId: item.id, toBatchId: destinationBatchOf(batchIdByRefItem, item.id) })),
        actorId,
      );

      await this.recordStatus(tx, actor, {
        transferId: id,
        branchId: head.toBranchId,
        from: TransferStatus.IN_TRANSIT,
        to: TransferStatus.RECEIVED,
      });
      return this.mustFind(tx, id);
    });
  }

  /** Huỷ (chi nhánh gửi). PENDING: chỉ đổi trạng thái. IN_TRANSIT (K5): hoàn hàng về đúng lô gửi. */
  async cancel(id: string, dto: CancelTransferRequest, actor: RequestActor): Promise<TransferDetail> {
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;
    const now = new Date();

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const head = await this.loadForSide(tx, id, scope, 'from');
      if (head.status !== TransferStatus.PENDING && head.status !== TransferStatus.IN_TRANSIT) {
        throw errors.wrongState(head.status);
      }
      const claimed = await this.transfers.transition(tx, id, head.status, {
        status: TransferStatus.CANCELLED,
        cancelledAt: now,
        cancelledBy: actorId,
        cancelReason: dto.reason,
        updatedAt: now,
        updatedBy: actorId,
      });
      if (!claimed) throw errors.wrongState();

      // Huỷ không kiểm chi nhánh còn hoạt động: hàng đang đi đường vẫn phải về sổ kể cả khi chi nhánh vừa ngừng.
      if (head.status === TransferStatus.IN_TRANSIT) {
        const items = await this.transfers.findItems(tx, id);
        const costs = await this.transfers.findShipCosts(tx, id);
        // K5: về ĐÚNG lô gửi (kể cả lô vừa bị khoá/thu hồi); giá vốn lô được bình quân lại với phần đang có.
        await this.intake.returnToBatches(ctx, {
          type: StockMovementType.TRANSFER_IN,
          refType: StockRefType.STOCK_TRANSFER,
          refId: id,
          actorId,
          note: 'Hoàn hàng do huỷ điều chuyển',
          lines: items.map((item) => ({
            batchId: item.batchId,
            quantity: item.quantity,
            unitCost: shipCostOf(costs, item.id),
            refItemId: item.id,
          })),
        });
      }

      await this.recordStatus(tx, actor, {
        transferId: id,
        branchId: head.fromBranchId,
        from: head.status,
        to: TransferStatus.CANCELLED,
        reason: dto.reason,
      });
      return this.mustFind(tx, id);
    });
  }

  /**
   * Phiếu đọc được (gửi hoặc nhận) mà thao tác sai phía → 1506: người dùng thấy phiếu này nên không giả "không tồn tại".
   * Phiếu ngoài cả hai phía → 1600.
   */
  private async loadForSide(
    tx: Prisma.TransactionClient,
    id: string,
    scope: BranchScope,
    side: 'from' | 'to',
  ): Promise<TransferHead> {
    const head = await this.transfers.findHead(tx, id, transferWhere(scope, 'either'));
    if (!head) throw errors.notFound();
    const branchId = side === 'from' ? head.fromBranchId : head.toBranchId;
    if (!isInBranchScope(scope, branchId)) throw permissionError(ErrorCode.BRANCH_ACCESS_DENIED);
    return head;
  }

  /** Lô xuất đi được: AVAILABLE và còn hạn (theo ngày giờ VN). */
  private assertBatchShippable(batch: Pick<LockedBatch, 'batchNumber' | 'status' | 'expiryDate'>, today: string) {
    if (batch.status !== BatchStatus.AVAILABLE) {
      throw inventoryError(ErrorCode.BATCH_NOT_AVAILABLE, `lô ${batch.batchNumber} đang ${batch.status}`);
    }
    if (daysBetweenDateOnly(today, toDateOnlyString(batch.expiryDate)) <= 0) {
      throw inventoryError(ErrorCode.BATCH_NOT_AVAILABLE, `lô ${batch.batchNumber} đã hết hạn`);
    }
  }

  private async assertBranchesActive(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
    const branches = await this.transfers.findBranches(tx, ids);
    if (branches.length !== new Set(ids).size) throw invalidReference('chi nhánh không tồn tại');
    if (branches.some((branch) => branch.status !== RecordStatus.ACTIVE)) {
      throw inventoryError(ErrorCode.BRANCH_INACTIVE);
    }
  }

  /** Nhật ký đổi trạng thái, gắn với chi nhánh thực hiện bước đó (gửi: xuất/huỷ, nhận: nhận). */
  private recordStatus(tx: Prisma.TransactionClient, actor: RequestActor, change: StatusChange) {
    return this.audit.record(tx, [
      {
        actorId: actor.user.userId,
        action: AuditAction.STATUS_CHANGE,
        entityType: AUDIT_ENTITY.STOCK_TRANSFER,
        entityId: change.transferId,
        branchId: change.branchId,
        before: { status: change.from },
        after: { status: change.to },
        reason: change.reason ?? null,
        ipAddress: actor.ip,
      },
    ]);
  }

  private async mustFind(tx: Prisma.TransactionClient, id: string): Promise<TransferDetail> {
    const transfer = await this.transfers.findDetail(id, {}, tx);
    if (!transfer) throw errors.notFound();
    return transfer;
  }
}
