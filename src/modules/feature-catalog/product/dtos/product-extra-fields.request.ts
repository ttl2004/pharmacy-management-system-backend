import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductType } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

const MAX_LOCATIONS = 20;
export const WEIGHT_UNITS = ['g', 'kg'] as const;

/**
 * Trường mở rộng của sản phẩm (loại hàng, lô, vị trí, đường dùng, trọng lượng, ghi chú…), dùng chung cho tạo
 * và sửa: mọi trường tuỳ chọn; khi sửa, trường nullable gửi `null` để xoá giá trị cũ, bỏ trống để giữ nguyên.
 */
export class ProductExtraFieldsRequest {
  @IsOptional()
  @IsEnum(ProductType)
  @ApiPropertyOptional({ enum: ProductType, description: 'Mặc định DRUG khi tạo; không đổi được sau khi tạo' })
  type?: ProductType;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Quản lý theo lô/HSD. Mặc định theo loại; không đổi được khi đã phát sinh kho' })
  trackBatches?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LOCATIONS)
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    type: [String],
    description: `Vị trí (kệ/tủ), tối đa ${MAX_LOCATIONS}; khi sửa là thay toàn bộ`,
  })
  locationIds?: string[];

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true, description: 'Đường dùng; gửi null để bỏ' })
  routeId?: string | null;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Thuốc kiểm soát đặc biệt' })
  isControlled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ nullable: true, description: 'Định mức tồn tối đa; null = không giới hạn' })
  maxStockLevel?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ nullable: true })
  shortName?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @ApiPropertyOptional({ nullable: true })
  weight?: number | null;

  @IsOptional()
  @IsIn(WEIGHT_UNITS)
  @ApiPropertyOptional({ enum: WEIGHT_UNITS, default: 'g' })
  weightUnit?: (typeof WEIGHT_UNITS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @ApiPropertyOptional({ nullable: true })
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional({ nullable: true })
  orderNote?: string | null;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Đánh dấu sao ở danh sách hàng hóa' })
  isFavourite?: boolean;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    nullable: true,
    description: 'Thuốc trong danh mục CSDL Dược (`GET /drug`). Bắt buộc khi tạo hàng DRUG; hàng GOODS không được gửi',
  })
  drugId?: string | null;
}
