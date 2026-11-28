import { Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import type { ProductListItem } from 'src/common/databases/product-list-item';
import { toProductListFilter } from 'src/common/dtos/product-list-filter.query';
import { addDaysToDateOnly, toDateOnlyString, todayInVietnam } from 'src/common/utils/date-only.util';
import { resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { PermissionService } from 'src/modules/feature-auth/permission/permission.service';
import { canSeeCost } from '../core/cost-visibility';
import { BranchProductListQuery } from './dtos/branch-product-list.query';
import {
  BranchProductListRepository,
  SALES_WINDOW_DAYS,
  type StockAggRow,
} from './repositories/branch-product-list.repository';

/** Số liệu kho của một hàng trong một phạm vi (chi nhánh, hoặc cả chuỗi ở dòng tổng). */
export interface BranchStockFigures {
  qtyOnHand: number;
  /** Bán được ngay: lô AVAILABLE, còn hạn, trừ phần đang giữ cho đơn online. */
  sellable: number;
  /** Giá vốn đơn vị gốc; null = không còn lô AVAILABLE có tồn, hoặc người gọi không được xem giá vốn. */
  avgCost: number | null;
  /** Giá nhập cuối đơn vị gốc; null = chưa có phiếu nhập CONFIRMED, hoặc không được xem giá vốn. */
  lastPurchaseCost: number | null;
  /** Lượng bán ròng 30 ngày gần nhất (đơn vị gốc). */
  soldLast30Days: number;
  /** YYYY-MM-DD; null khi tồn ≤ 0 hoặc không bán được gì trong 30 ngày. */
  stockoutDate: string | null;
  /** YYYY-MM-DD — hạn dùng gần nhất của lô còn tồn; null khi hết tồn. */
  nearestExpiry: string | null;
}

export interface BranchBreakdownView extends BranchStockFigures {
  branchId: string;
  branchCode: string;
  branchName: string;
  minStock: number;
  maxStock: number | null;
}

export type BranchProductView = ProductListItem &
  BranchStockFigures & {
    /** Định mức của chi nhánh (branch_products, rơi về chung). null ở chế độ toàn chuỗi — xem `branches`. */
    minStock: number | null;
    maxStock: number | null;
    /** Chỉ ở chế độ toàn chuỗi: các chi nhánh có lô của hàng; chế độ chi nhánh = null. */
    branches: BranchBreakdownView[] | null;
  };

/** Ngày hết hàng dự kiến = hôm nay + floor(tồn × 30 / lượng bán 30 ngày). Cùng công thức với sắp xếp ở SQL. */
export function forecastStockout(today: string, onHand: number, sold: number): string | null {
  if (onHand <= 0 || sold <= 0) return null;
  return addDaysToDateOnly(today, Math.floor((onHand * SALES_WINDOW_DAYS) / sold));
}

/**
 * Hàng hoá chi nhánh (`GET /stock/branch-products`). Phạm vi: PM/nhân viên luôn bị ép về chi nhánh mình (chi nhánh
 * khác → 1506); ADMIN/SUPER_ADMIN không gửi `branchId` = TOÀN CHUỖI (mỗi hàng một dòng, số liệu cộng cả chuỗi, kèm
 * `branches`). Giá vốn / giá nhập cuối = null với người không được xem giá vốn (K8), và sắp xếp theo hai cột đó bị bỏ
 * qua (không dò được giá qua thứ tự).
 */
@Injectable()
export class BranchProductListService {
  constructor(
    private readonly repository: BranchProductListRepository,
    private readonly permissions: PermissionService,
  ) {}

  async list(query: BranchProductListQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId) ?? null;
    const showCost = await canSeeCost(this.permissions, actor.user);
    const sortBy =
      !showCost && (query.sortBy === 'avgCost' || query.sortBy === 'lastPurchaseCost') ? undefined : query.sortBy;
    const today = todayInVietnam();

    const page = await this.repository.findPage(
      {
        product: toProductListFilter(query),
        branchId,
        supplierIds: query.supplierIds ?? [],
        stock: query.stockFilter ?? 'all',
        stockOp: query.stockOp ?? 'lt',
        stockValue: query.stockValue,
        today,
      },
      { page: query.page, limit: query.limit, sortBy, sortDir: query.sortDir ?? 'asc' },
    );

    const ids = page.rows.map((row) => row.productId);
    const scope = branchId ?? 'ALL';
    const chain = branchId === null;
    const [items, lastCost, sold, breakdown, branchLastCost, branchSold] = await Promise.all([
      this.repository.findItems(ids),
      showCost ? this.repository.findLastPurchase(scope, ids) : new Map<string, number>(),
      this.repository.findSold(scope, ids, today),
      chain ? this.repository.findBranchBreakdown(ids, today) : [],
      chain && showCost ? this.repository.findLastPurchase('ALL', ids, true) : new Map<string, number>(),
      chain ? this.repository.findSold('ALL', ids, today, true) : new Map<string, number>(),
    ]);

    const figures = (row: StockAggRow, last: number | undefined, soldQty: number): BranchStockFigures => ({
      qtyOnHand: row.onHand,
      sellable: row.sellable,
      avgCost: showCost ? row.avgCost : null,
      lastPurchaseCost: showCost ? (last ?? null) : null,
      soldLast30Days: soldQty,
      stockoutDate: forecastStockout(today, row.onHand, soldQty),
      nearestExpiry: row.nearestExpiry ? toDateOnlyString(row.nearestExpiry) : null,
    });

    const branchesOf = new Map<string, BranchBreakdownView[]>();
    for (const row of breakdown) {
      const key = `${row.branchId}:${row.productId}`;
      const list = branchesOf.get(row.productId) ?? [];
      list.push({
        branchId: row.branchId,
        branchCode: row.branchCode,
        branchName: row.branchName,
        ...figures(row, branchLastCost.get(key), branchSold.get(key) ?? 0),
        minStock: row.minStock,
        maxStock: row.maxStock,
      });
      branchesOf.set(row.productId, list);
    }

    const itemById = new Map(items.map((item) => [item.id, item]));
    const hits: BranchProductView[] = page.rows.flatMap((row) => {
      const item = itemById.get(row.productId);
      if (!item) return [];
      return [
        {
          ...item,
          ...figures(row, lastCost.get(row.productId), sold.get(row.productId) ?? 0),
          minStock: chain ? null : row.minStock,
          maxStock: chain ? null : row.maxStock,
          branches: chain ? (branchesOf.get(row.productId) ?? []) : null,
        },
      ];
    });

    return {
      hits,
      total: page.total,
      page: query.page,
      totalPages: Math.ceil(page.total / query.limit),
      limit: query.limit,
      /** Chi nhánh đang xem; null = toàn chuỗi. */
      branchId,
      summary: { totalQtyOnHand: page.totalQtyOnHand },
    };
  }
}
