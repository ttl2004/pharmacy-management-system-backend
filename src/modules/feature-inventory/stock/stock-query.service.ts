import { Injectable } from '@nestjs/common';
import { BatchStatus, Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
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
import { branchWhere } from '../core/inventory-scope';
import { afterCursorDesc, decodeCursor, toKeysetPage } from 'src/common/utils/keyset-cursor';
import {
  LowStockQuery,
  MovementSummaryQuery,
  NearExpiryQuery,
  StockBatchQuery,
  StockMovementQuery,
  StockProductQuery,
} from './dtos/stock.query';
import { StockBatchRow, StockQueryRepository } from './repositories/stock-query.repository';

/** Kỳ báo cáo dài nhất — chặn một request quét cả sổ kho nhiều năm. */
const MAX_SUMMARY_DAYS = 366;

/** Lô trả về client kèm các trường suy ra — client không phải tự tính hạn, tồn khả dụng. */
export type StockBatchView = StockBatchRow & {
  availableQuantity: number;
  daysToExpiry: number;
  isExpired: boolean;
  /** Xuất/bán được: AVAILABLE và còn hạn. */
  isSellable: boolean;
};

/**
 * Đọc tồn kho, sổ kho, báo cáo. Phạm vi: PM/nhân viên luôn bị ép về chi nhánh mình (lọc chi nhánh khác → 1506);
 * ADMIN thấy toàn chuỗi. Không có hàm ghi nào ở đây.
 */
@Injectable()
export class StockQueryService {
  constructor(private readonly stock: StockQueryRepository) {}

  async listBatches(query: StockBatchQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const today = todayInVietnam();
    const where: Prisma.StockBatchWhereInput = {};
    if (branchId) where.branchId = branchId;
    if (query.productId) where.productId = query.productId;
    if (query.status) where.status = query.status;
    if (query.inStockOnly !== false) where.quantityOnHand = { gt: 0 };
    if (query.expiringWithinDays !== undefined) {
      where.expiryDate = { lte: parseDateOnly(addDaysToDateOnly(today, query.expiringWithinDays)) };
    }
    if (query.search) {
      where.OR = [
        { batchNumber: { contains: escapeLike(query.search), mode: 'insensitive' } },
        { product: { name: { contains: escapeLike(query.search), mode: 'insensitive' } } },
        { product: { code: { contains: escapeLike(query.search), mode: 'insensitive' } } },
      ];
    }
    const page = await this.stock.findBatchPage(where, query.page, query.limit);
    return { ...page, hits: page.hits.map((row) => this.toBatchView(row, today)) };
  }

  async getBatch(id: string, actor: RequestActor): Promise<StockBatchView> {
    const row = await this.stock.findBatch(id, branchWhere(resolveBranchScope(actor.user)));
    if (!row) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Lô hàng không tồn tại' });
    return this.toBatchView(row, todayInVietnam());
  }

  async listProducts(query: StockProductQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const page = await this.stock.findProductStockPage(
      { branchId, productId: query.productId, search: query.search, today: parseDateOnly(todayInVietnam()) },
      query.page,
      query.limit,
    );
    return {
      ...page,
      hits: page.hits.map((row) => ({ ...row, isLow: row.minStockLevel > 0 && row.sellable < row.minStockLevel })),
    };
  }

  /** Nhật ký sổ kho, mới nhất trước, phân trang con trỏ. */
  async listMovements(query: StockMovementQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const conditions: Prisma.StockMovementWhereInput[] = [];
    if (branchId) conditions.push({ branchId });
    if (query.productId) conditions.push({ productId: query.productId });
    if (query.batchId) conditions.push({ batchId: query.batchId });
    if (query.type) conditions.push({ type: query.type });
    if (query.refType) conditions.push({ refType: query.refType });
    if (query.refId) conditions.push({ refId: query.refId });
    if (query.fromDate) conditions.push({ createdAt: { gte: vietnamDayStartUtc(query.fromDate) } });
    if (query.toDate) conditions.push({ createdAt: { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } });
    if (query.cursor) conditions.push(afterCursorDesc(decodeCursor(query.cursor)));

    const rows = await this.stock.findMovements({ AND: conditions }, query.limit + 1);
    return toKeysetPage(rows, query.limit);
  }

  async lowStock(query: LowStockQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    if (!branchId) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Cần chọn chi nhánh (branchId)' });
    }
    return this.stock.findLowStock(branchId, parseDateOnly(todayInVietnam()), query.page, query.limit);
  }

  nearExpiry(query: NearExpiryQuery, actor: RequestActor) {
    return this.listBatches(
      Object.assign(new StockBatchQuery(), { ...query, inStockOnly: true, expiringWithinDays: query.days ?? 90 }),
      actor,
    );
  }

  async movementSummary(query: MovementSummaryQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const days = daysBetweenDateOnly(query.fromDate, query.toDate);
    if (days < 0) throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'fromDate phải trước toDate' });
    if (days >= MAX_SUMMARY_DAYS) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: `Kỳ báo cáo tối đa ${MAX_SUMMARY_DAYS} ngày`,
      });
    }
    const rows = await this.stock.findMovementSummary({
      branchId,
      from: vietnamDayStartUtc(query.fromDate),
      toExclusive: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)),
    });
    return { branchId: branchId ?? null, fromDate: query.fromDate, toDate: query.toDate, rows };
  }

  private toBatchView(row: StockBatchRow, today: string): StockBatchView {
    const daysToExpiry = daysBetweenDateOnly(today, toDateOnlyString(row.expiryDate));
    const isExpired = daysToExpiry <= 0;
    return {
      ...row,
      availableQuantity: row.quantityOnHand - row.reservedQuantity,
      daysToExpiry,
      isExpired,
      isSellable: row.status === BatchStatus.AVAILABLE && !isExpired,
    };
  }
}
