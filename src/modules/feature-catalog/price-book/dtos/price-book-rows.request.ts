import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Max, Min, ValidateIf } from 'class-validator';

export const PRICE_STOCK_FILTERS = ['all', 'in_stock', 'out_of_stock', 'below_min', 'above_max'] as const;
export const PRICE_COMPARE_OPS = ['lt', 'lte', 'eq', 'gt', 'gte'] as const;
export const PRICE_COMPARE_BASES = ['avgCost', 'lastPurchaseCost'] as const;
export type PriceStockFilter = (typeof PRICE_STOCK_FILTERS)[number];
export type PriceCompareOp = (typeof PRICE_COMPARE_OPS)[number];
export type PriceCompareBase = (typeof PRICE_COMPARE_BASES)[number];

/** Trần cho "Xuất file": FE xin cả bảng một lần (100000), nên vượt xa trần 100 của danh sách thường. */
const MAX_PAGE_SIZE = 100_000;

/** FE gửi mảng dạng chuỗi nối dấu phẩy (`a,b,c`); body JSON có thể là mảng thật — nhận cả hai. */
const toList = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value;
const toNumber = ({ value }: { value: unknown }) => (value === undefined || value === '' ? undefined : Number(value));

/**
 * Bộ lọc dòng giá. Dùng cho cả query của `GET /price-book/rows` lẫn body của `POST /:id/apply-formula` (áp công
 * thức cho đúng các dòng đang lọc).
 */
export class PriceRowsFilterRequest {
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ type: String, description: 'Mã hàng chọn sẵn, nối dấu phẩy (khớp đúng, không phân biệt hoa thường)' })
  codes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Mã hàng chứa chuỗi này' })
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  @ApiPropertyOptional({ description: 'Tên hàng chứa chuỗi này' })
  name?: string;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Id nhóm hàng, nối dấu phẩy' })
  categoryIds?: string[];

  @IsOptional()
  @IsIn(PRICE_STOCK_FILTERS)
  @ApiPropertyOptional({ enum: PRICE_STOCK_FILTERS, description: 'Cần branchId, không có thì bỏ qua' })
  stock?: PriceStockFilter;

  @IsOptional()
  @IsIn(PRICE_COMPARE_OPS)
  @ApiPropertyOptional({ enum: PRICE_COMPARE_OPS })
  priceOp?: PriceCompareOp;

  @IsOptional()
  @IsIn(PRICE_COMPARE_BASES)
  @ApiPropertyOptional({ enum: PRICE_COMPARE_BASES, description: 'So giá chung với giá nào (cùng priceOp)' })
  priceCompare?: PriceCompareBase;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Chi nhánh tính giá vốn / giá nhập cuối / tồn. Không gửi → các giá đó = 0' })
  branchId?: string;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Bảng giá cần lấy cột giá, nối dấu phẩy (chỉ bảng người gọi xem được)' })
  bookIds?: string[];
}

export class PriceRowsQuery extends PriceRowsFilterRequest {
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ example: 1 })
  page?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  @ApiPropertyOptional({ example: 15, maximum: MAX_PAGE_SIZE })
  pageSize?: number;
}

/** `drugId` = id sản phẩm, `unitId` = id đơn vị tính (bảng `units`), không phải id dòng đơn vị bán. */
export class SetGeneralPriceRequest {
  @IsUUID()
  @ApiProperty()
  drugId: string;

  @IsUUID()
  @ApiProperty()
  unitId: string;

  @IsInt({ message: 'Giá phải là số nguyên' })
  @Min(0, { message: 'Giá không được âm' })
  @ApiProperty({ example: 25000 })
  price: number;
}

export class SetBookItemRequest {
  @IsUUID()
  @ApiProperty()
  drugId: string;

  @IsUUID()
  @ApiProperty()
  unitId: string;

  @ValidateIf((o: SetBookItemRequest) => o.price !== null)
  @IsInt({ message: 'Giá phải là số nguyên' })
  @Min(0, { message: 'Giá không được âm' })
  @ApiProperty({ type: Number, nullable: true, description: 'Số = thêm/cập nhật; null = bỏ hàng khỏi bảng' })
  price: number | null;
}
