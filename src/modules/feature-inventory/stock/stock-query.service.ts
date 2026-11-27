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
import { PermissionService } from 'src/modules/feature-auth/permission/permission.service';
import { canSeeCost } from '../core/cost-visibility';
import { branchWhere } from '../core/inventory-scope';
import { afterCursorDesc, decodeCursor, toKeysetPage } from 'src/common/utils/keyset-cursor';
import {
  ExpirySummaryQuery,
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
export type StockBatchView = Omit<StockBatchRow, 'importPrice'> & {
  /** Giá nhập của lô — null với người không có quyền thấy giá vốn. */
  importPrice: number | null;
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
  constructor(
    private readonly stock: StockQueryRepository,
    private readonly permissions: PermissionService,
  ) {}

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
    const showCost = await canSeeCost(this.permissions, actor.user);
    const page = await this.stock.findBatchPage(where, query.page, query.limit);
    return { ...page, hits: page.hits.map((row) => this.toBatchView(row, today, showCost)) };
  }

  async getBatch(id: string, actor: RequestActor): Promise<StockBatchView> {
    const row = await this.stock.findBatch(id, branchWhere(resolveBranchScope(actor.user)));
    if (!row) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Lô hàng không tồn tại' });
    return this.toBatchView(row, todayInVietnam(), await canSeeCost(this.permissions, actor.user));
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

    const rows = await this.stock.findMovementsWithProductBalance({ AND: conditions }, query.limit + 1);
    const page = toKeysetPage(rows, query.limit);
    // `refCode`: mã chứng từ đọc được (PN…, HD…, mã hàng với tồn đầu); null khi chứng từ không còn.
    const codes = await this.stock.findRefCodes(page.items);
    // Giá vốn bút toán chỉ cho người thấy được giá vốn (K8); hình dạng JSON giữ nguyên (null).
    const showCost = await canSeeCost(this.permissions, actor.user);
    return {
      ...page,
      items: page.items.map((row) => ({
        ...row,
        unitCost: showCost ? row.unitCost : null,
        refCode: codes.get(row.refId) ?? null,
      })),
    };
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

  /**
   * Thẻ Tổng quan: số lô hết hạn / cận hạn ≤ `days` ngày còn tồn, tổng + từng chi nhánh. ADMIN bỏ trống = toàn chuỗi;
   * PM bị ép về chi nhánh mình (gửi chi nhánh khác → 1506). Đếm cả lô cách ly/thu hồi (như báo cáo cận hạn).
   */
  async expirySummary(query: ExpirySummaryQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const days = query.days ?? 30;
    const today = todayInVietnam();
    const byBranch = await this.stock.findExpirySummary({
      branchId,
      today: parseDateOnly(today),
      until: parseDateOnly(addDaysToDateOnly(today, days)),
    });
    return {
      days,
      expired: byBranch.reduce((sum, row) => sum + row.expired, 0),
      expiring: byBranch.reduce((sum, row) => sum + row.expiring, 0),
      byBranch,
    };
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
    const filter = {
      branchId,
      from: vietnamDayStartUtc(query.fromDate),
      toExclusive: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)),
    };
    // Cùng bộ lọc/phạm vi: dòng theo sản phẩm + tổng theo chi nhánh (byBranch, chỉ khi xem toàn chuỗi — đã lọc một
    // chi nhánh thì bỏ câu thứ hai, trả mảng rỗng).
    const [rows, byBranch, showCost] = await Promise.all([
      this.stock.findMovementSummary(filter),
      branchId ? Promise.resolve([]) : this.stock.findMovementSummaryByBranch(filter),
      canSeeCost(this.permissions, actor.user),
    ]);
    // Cột giá trị tiền theo giá vốn: ẩn (null) với người không thấy được giá vốn (K8).
    const hideValue = <T extends object>(row: T) => ({
      ...row,
      openingValue: null,
      inValue: null,
      outValue: null,
      closingValue: null,
    });
    return {
      branchId: branchId ?? null,
      fromDate: query.fromDate,
      toDate: query.toDate,
      rows: showCost ? rows : rows.map(hideValue),
      byBranch: showCost ? byBranch : byBranch.map(hideValue),
    };
  }

  private toBatchView(row: StockBatchRow, today: string, showCost: boolean): StockBatchView {
    const daysToExpiry = daysBetweenDateOnly(today, toDateOnlyString(row.expiryDate));
    const isExpired = daysToExpiry <= 0;
    return {
      ...row,
      importPrice: showCost ? row.importPrice : null,
      // Lô bị khoá (cách ly / thu hồi) không xuất được → khả dụng 0, dù còn tồn thực tế.
      availableQuantity: row.status === BatchStatus.AVAILABLE ? row.quantityOnHand - row.reservedQuantity : 0,
      daysToExpiry,
      isExpired,
      isSellable: row.status === BatchStatus.AVAILABLE && !isExpired,
    };
  }
}
