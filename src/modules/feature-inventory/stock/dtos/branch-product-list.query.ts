import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CATALOG_SORT_KEYS } from 'src/common/databases/sql/product-filter.sql';
import { ProductListFilterQuery } from 'src/common/dtos/product-list-filter.query';

/** Cột sắp xếp: mọi cột của danh mục + các cột số liệu của chi nhánh. */
export const BRANCH_PRODUCT_SORT_KEYS = [
  ...CATALOG_SORT_KEYS,
  'qtyOnHand',
  'sellable',
  'avgCost',
  'lastPurchaseCost',
  'stockoutDate',
  'nearestExpiry',
] as const;
export type BranchProductSortKey = (typeof BRANCH_PRODUCT_SORT_KEYS)[number];

/** Bộ lọc tồn (khớp `stockFilterSchema` của FE). */
export const BRANCH_STOCK_FILTERS = ['all', 'in_stock', 'out_of_stock', 'below_min', 'above_max', 'custom'] as const;
export type BranchStockFilter = (typeof BRANCH_STOCK_FILTERS)[number];

export const STOCK_OPS = ['lt', 'lte', 'eq', 'gt', 'gte'] as const;
export type StockOp = (typeof STOCK_OPS)[number];

const toList = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : value;
const toInt = ({ value }: { value: unknown }) => (value === undefined || value === '' ? undefined : Number(value));

/** Trần trị tuyệt đối của `stockValue` — vừa int4, đủ xa mọi tồn thật. */
const MAX_STOCK_VALUE = 1_000_000_000;

export class BranchProductListQuery extends ProductListFilterQuery {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description:
      'Chi nhánh. ADMIN/SUPER_ADMIN bỏ trống = TOÀN CHUỖI (mỗi hàng một dòng, kèm `branches`). PM/nhân viên: bỏ trống = chi nhánh mình; chi nhánh khác → 1506',
  })
  branchId?: string;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    type: String,
    description:
      'Id nhà cung cấp, nối dấu phẩy: hàng đã từng nhập (phiếu nhập CONFIRMED) từ NCC đó trong phạm vi đang xem',
  })
  supplierIds?: string[];

  @IsOptional()
  @IsIn(BRANCH_STOCK_FILTERS)
  @ApiPropertyOptional({
    enum: BRANCH_STOCK_FILTERS,
    default: 'all',
    description:
      'Theo tồn (quantityOnHand) của phạm vi. below_min / above_max: định mức của CHI NHÁNH (branch_products, rơi về định mức chung); toàn chuỗi = có ít nhất một chi nhánh dưới / vượt định mức. custom cần stockOp + stockValue',
  })
  stockFilter?: BranchStockFilter;

  @IsOptional()
  @IsIn(STOCK_OPS)
  @ApiPropertyOptional({ enum: STOCK_OPS, default: 'lt', description: 'Toán tử khi stockFilter=custom' })
  stockOp?: StockOp;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(-MAX_STOCK_VALUE)
  @Max(MAX_STOCK_VALUE)
  @ApiPropertyOptional({ description: 'Ngưỡng khi stockFilter=custom (không gửi = bỏ qua bộ lọc tồn)' })
  stockValue?: number;

  @IsOptional()
  @IsIn(BRANCH_PRODUCT_SORT_KEYS)
  @ApiPropertyOptional({
    enum: BRANCH_PRODUCT_SORT_KEYS,
    description:
      'Cột sắp xếp (không gửi = hàng tạo trước đứng trước). Giá trị trống (chưa có giá vốn, không dự kiến được ngày hết…) luôn xuống cuối. avgCost / lastPurchaseCost bị bỏ qua nếu người gọi không được xem giá vốn',
  })
  sortBy?: BranchProductSortKey;
}
