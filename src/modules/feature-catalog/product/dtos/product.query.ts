import { ApiPropertyOptional } from '@nestjs/swagger';
import { DosageForm, RecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
import { ProductListFilterQuery } from 'src/common/dtos/product-list-filter.query';
import { CATALOG_SORT_KEYS, type CatalogSortKey } from 'src/common/databases/sql/product-filter.sql';

/**
 * `Boolean('false')` trả `true` nên chuỗi query phải chuyển tường minh; giá trị khác `true`/`false`
 * được giữ nguyên để `@IsBoolean` báo lỗi 400 thay vì âm thầm thành `true`.
 */
export const toBoolean = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

/**
 * Danh sách sản phẩm. Gửi bất kỳ tham số lọc mới nào (`q`, `categoryIds`, `statuses`, `sortBy`… — xem
 * `ProductListFilterQuery`) → lọc/sắp xếp/đếm hoàn toàn ở SQL và mỗi dòng có thêm đơn vị bán, vị trí, mô tả (đủ cột màn
 * Danh mục hàng hoá); khi đó `sort` cũ bị bỏ qua, `search` cũ được hiểu như `q`. Không gửi → hành vi cũ, giữ nguyên.
 */
export class ProductQuery extends ProductListFilterQuery {
  @IsOptional()
  @IsIn(CATALOG_SORT_KEYS)
  @ApiPropertyOptional({
    enum: CATALOG_SORT_KEYS,
    description: 'Cột sắp xếp (không gửi = hàng tạo trước đứng trước). price = giá bán đơn vị cơ bản',
  })
  sortBy?: CatalogSortKey;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo nhóm sản phẩm' })
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo hãng sản xuất' })
  manufacturerId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Lọc theo đơn vị cơ bản' })
  baseUnitId?: string;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;

  @IsOptional()
  @IsEnum(DosageForm)
  @ApiPropertyOptional({ enum: DosageForm })
  dosageForm?: DosageForm;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  @ApiPropertyOptional({ type: Boolean, description: 'Lọc thuốc kê đơn' })
  requiresPrescription?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  @ApiPropertyOptional({
    type: Boolean,
    description: 'true = chỉ liệt kê sản phẩm ĐÃ xoá (để khôi phục); cần quyền product:delete',
  })
  deleted?: boolean;
}
