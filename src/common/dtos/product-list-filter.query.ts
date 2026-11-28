import { ApiPropertyOptional } from '@nestjs/swagger';
import { DosageForm, ProductType, RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { AbstractBaseQuery } from 'src/providers/abstract-base/abstract-base.query';
import { IsDateOnly } from '../validators/is-date-only.validator';
import type { ProductListFilter } from '../databases/sql/product-filter.sql';

/** FE gửi mảng dạng chuỗi nối dấu phẩy (`a,b,c`); lặp tham số (`a=1&a=2`) cũng nhận. */
const toList = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : value;

/** `Boolean('false')` là `true` — đổi tường minh; giá trị lạ giữ nguyên để `@IsBoolean` báo 400. */
const toBoolean = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

/** Giá trị đặc biệt của `locationIds`: hàng chưa gắn vị trí nào (khớp `NO_LOCATION` của FE). */
export const NO_LOCATION = 'none';

const LOCATION_ID = /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const PRODUCT_SEARCH_FIELDS = ['code_name', 'registration', 'generic', 'manufacturer'] as const;
export type ProductSearchField = (typeof PRODUCT_SEARCH_FIELDS)[number];

export const SORT_DIRS = ['asc', 'desc'] as const;
export type SortDir = (typeof SORT_DIRS)[number];

/** Trần phần tử mỗi bộ lọc mảng — chặn URL chứa hàng nghìn id. */
const MAX_LIST = 200;
const MAX_TEXT = 200;

/**
 * Bộ lọc danh sách hàng hoá KHÔNG phụ thuộc chi nhánh — dùng chung cho Danh mục hàng hoá (`GET /product`) và Hàng hoá
 * chi nhánh (`GET /stock/branch-products`). Tên tham số khớp `drugListQuerySchema` của FE (giá trị enum theo BE).
 */
export class ProductListFilterQuery extends AbstractBaseQuery {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT)
  @ApiPropertyOptional({ description: 'Từ khoá ô tìm nhanh, tìm theo `searchField`' })
  q?: string;

  @IsOptional()
  @IsIn(PRODUCT_SEARCH_FIELDS)
  @ApiPropertyOptional({
    enum: PRODUCT_SEARCH_FIELDS,
    default: 'code_name',
    description:
      'code_name = mã, tên, tên viết tắt, mã vạch (cả mã vạch đơn vị), hoạt chất, số đăng ký · registration = số đăng ký · generic = hoạt chất, hàm lượng · manufacturer = hãng sản xuất',
  })
  searchField?: ProductSearchField;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({ type: String, description: 'Id nhóm hàng, nối dấu phẩy. Chọn nhóm cha gồm cả nhóm con cháu' })
  categoryIds?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsEnum(DosageForm, { each: true })
  @ApiPropertyOptional({
    type: String,
    description: `Dạng bào chế, nối dấu phẩy: ${Object.values(DosageForm).join(', ')}`,
  })
  dosageForms?: DosageForm[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsEnum(RecordStatus, { each: true })
  @ApiPropertyOptional({ type: String, description: 'Trạng thái kinh doanh, nối dấu phẩy: ACTIVE, INACTIVE' })
  statuses?: RecordStatus[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsEnum(ProductType, { each: true })
  @ApiPropertyOptional({ type: String, description: 'Loại hàng, nối dấu phẩy: DRUG, GOODS' })
  types?: ProductType[];

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ example: '2026-11-01', description: 'Tạo từ ngày (giờ VN, tính trọn ngày)' })
  createdFrom?: string;

  @IsOptional()
  @IsDateOnly()
  @ApiPropertyOptional({ example: '2026-11-30', description: 'Tạo đến ngày (giờ VN, tính trọn ngày)' })
  createdTo?: string;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @Matches(LOCATION_ID, { each: true, message: `locationIds chỉ gồm id vị trí (uuid) hoặc "${NO_LOCATION}"` })
  @ApiPropertyOptional({
    type: String,
    description: `Id vị trí kệ, nối dấu phẩy (OR). "${NO_LOCATION}" = hàng chưa gắn vị trí nào`,
  })
  locationIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT)
  @ApiPropertyOptional({ description: 'Tìm nâng cao: mã, tên, tên viết tắt' })
  qCodeName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT)
  @ApiPropertyOptional({ description: 'Tìm nâng cao: mã vạch hàng hoặc mã vạch đơn vị' })
  qBarcode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT)
  @ApiPropertyOptional({ description: 'Tìm nâng cao: số đăng ký (thuốc liên kết)' })
  qRegistration?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT)
  @ApiPropertyOptional({
    description:
      'Tìm nâng cao: số lô hoặc hạn dùng (YYYY-MM-DD hay DD/MM/YYYY) của lô CÒN TỒN — trong chi nhánh đang xem (danh mục: cả chuỗi)',
  })
  qLot?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT)
  @ApiPropertyOptional({ description: 'Tìm nâng cao: hoạt chất, hàm lượng' })
  qGeneric?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT)
  @ApiPropertyOptional({ description: 'Tìm nâng cao: hãng sản xuất' })
  qManufacturer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT)
  @ApiPropertyOptional({ description: 'Tìm nâng cao: mô tả, ghi chú đặt hàng' })
  qNote?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean, description: 'Thuốc kê đơn' })
  isPrescriptionOnly?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean, description: 'Quản lý theo lô' })
  trackLots?: boolean;

  @IsOptional()
  @IsIn(SORT_DIRS)
  @ApiPropertyOptional({ enum: SORT_DIRS, default: 'asc' })
  sortDir?: SortDir;
}

/** Tên các tham số lọc mới (để `GET /product` biết khi nào chuyển sang đường truy vấn SQL đầy đủ). */
export const PRODUCT_LIST_FILTER_KEYS = [
  'q',
  'searchField',
  'categoryIds',
  'dosageForms',
  'statuses',
  'types',
  'createdFrom',
  'createdTo',
  'locationIds',
  'qCodeName',
  'qBarcode',
  'qRegistration',
  'qLot',
  'qGeneric',
  'qManufacturer',
  'qNote',
  'isPrescriptionOnly',
  'trackLots',
  'sortDir',
] as const satisfies readonly (keyof ProductListFilterQuery)[];

const trimmed = (value: string | undefined) => value?.trim() || undefined;

/** DTO → bộ lọc SQL (mảng thật, chuỗi rỗng bỏ qua). */
export function toProductListFilter(dto: ProductListFilterQuery): ProductListFilter {
  return {
    q: trimmed(dto.q),
    searchField: dto.searchField ?? 'code_name',
    categoryIds: dto.categoryIds ?? [],
    dosageForms: dto.dosageForms ?? [],
    statuses: dto.statuses ?? [],
    types: dto.types ?? [],
    createdFrom: dto.createdFrom,
    createdTo: dto.createdTo,
    locationIds: dto.locationIds ?? [],
    qCodeName: trimmed(dto.qCodeName),
    qBarcode: trimmed(dto.qBarcode),
    qRegistration: trimmed(dto.qRegistration),
    qLot: trimmed(dto.qLot),
    qGeneric: trimmed(dto.qGeneric),
    qManufacturer: trimmed(dto.qManufacturer),
    qNote: trimmed(dto.qNote),
    requiresPrescription: dto.isPrescriptionOnly,
    trackBatches: dto.trackLots,
  };
}
