import type {
  PriceCompareBase,
  PriceCompareOp,
  PriceRowsFilterRequest,
  PriceStockFilter,
} from './dtos/price-book-rows.request';

/** Bộ lọc dòng giá đã chuẩn hoá (mảng thật, mặc định đã điền). */
export interface PriceRowsFilter {
  codes: string[];
  code?: string;
  name?: string;
  categoryIds: string[];
  stock: PriceStockFilter;
  priceOp?: PriceCompareOp;
  priceCompare?: PriceCompareBase;
  branchId?: string;
  /** Giới hạn theo dòng đơn vị cụ thể (dùng khi tính lại công thức cho các dòng đang có trong bảng). */
  productUnitIds?: string[];
}

/** DTO (query hoặc body) → bộ lọc; `branchId` đã qua kiểm phạm vi của người gọi nên truyền riêng. */
export function toRowsFilter(dto: PriceRowsFilterRequest, branchId: string | undefined): PriceRowsFilter {
  return {
    codes: dto.codes ?? [],
    code: dto.code || undefined,
    name: dto.name || undefined,
    categoryIds: dto.categoryIds ?? [],
    stock: dto.stock ?? 'all',
    priceOp: dto.priceOp,
    priceCompare: dto.priceCompare,
    branchId,
  };
}
