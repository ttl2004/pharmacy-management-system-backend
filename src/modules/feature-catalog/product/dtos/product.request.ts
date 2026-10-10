import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DosageForm, RecordStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const CODE_PATTERN = /^[A-Z0-9_-]+$/;
const MAX_IMAGE_URLS = 10;

/** `@Transform` chạy trước class-validator nên `sp0001` được đưa về `SP0001` rồi mới qua regex. */
const normalizeCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class ProductUnitRequest {
  @IsUUID()
  @ApiProperty()
  unitId: string;

  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Số đơn vị cơ bản trong một đơn vị này; dòng cơ bản phải bằng 1' })
  conversionRate: number;

  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'Giá bán theo đơn vị này, đơn vị đồng' })
  salePrice: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional()
  barcode?: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Đúng một dòng trong payload đặt true' })
  isBaseUnit?: boolean;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}

export class CreateProductRequest {
  @Transform(normalizeCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiProperty({ example: 'SP0001' })
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional()
  barcode?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  @ApiProperty({ example: 'Paracetamol 500mg' })
  name: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_IMAGE_URLS)
  @IsUrl({}, { each: true })
  @MaxLength(2048, { each: true })
  @ApiPropertyOptional({ type: [String], description: `Tối đa ${MAX_IMAGE_URLS} URL ảnh` })
  imageUrls?: string[];

  @IsUUID()
  @ApiProperty()
  categoryId: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  manufacturerId?: string;

  @IsUUID()
  @ApiProperty({ description: 'Đơn vị nhỏ nhất dùng để đếm tồn kho' })
  baseUnitId: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  @ApiPropertyOptional()
  activeIngredient?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional()
  strength?: string;

  @IsOptional()
  @IsEnum(DosageForm)
  @ApiPropertyOptional({ enum: DosageForm })
  dosageForm?: DosageForm;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @ApiPropertyOptional()
  packagingSpec?: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  requiresPrescription?: boolean;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  indications?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  dosageNote?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  storageNote?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  minStockLevel?: number;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductUnitRequest)
  @ApiProperty({ type: [ProductUnitRequest], description: 'Cấu hình đơn vị bán, phải có đúng một đơn vị cơ bản' })
  units: ProductUnitRequest[];
}

/**
 * DTO sửa sản phẩm. Không gửi `units` là giữ nguyên cấu hình đơn vị bán; có gửi là **thay toàn bộ**
 * (replace-all) — dòng vắng mặt bị xoá mềm. Các trường nullable gửi `null` để xoá giá trị cũ.
 */
export class UpdateProductRequest {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(normalizeCode)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiPropertyOptional({ example: 'SP0001' })
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  barcode?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  @ApiPropertyOptional()
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_IMAGE_URLS)
  @IsUrl({}, { each: true })
  @MaxLength(2048, { each: true })
  @ApiPropertyOptional({ type: [String], description: `Tối đa ${MAX_IMAGE_URLS} URL ảnh` })
  imageUrls?: string[];

  @ValidateIf((_, value) => value !== undefined)
  @IsUUID()
  @ApiPropertyOptional()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để bỏ hãng sản xuất' })
  manufacturerId?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsUUID()
  @ApiPropertyOptional({ description: 'Đổi đơn vị cơ bản bắt buộc gửi kèm units' })
  baseUnitId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  activeIngredient?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  strength?: string | null;

  @IsOptional()
  @IsEnum(DosageForm)
  @ApiPropertyOptional({ enum: DosageForm, nullable: true, description: 'Gửi null để xoá' })
  dosageForm?: DosageForm | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  packagingSpec?: string | null;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  requiresPrescription?: boolean;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  indications?: string | null;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  dosageNote?: string | null;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ nullable: true, description: 'Gửi null để xoá' })
  storageNote?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  minStockLevel?: number;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductUnitRequest)
  @ApiPropertyOptional({
    type: [ProductUnitRequest],
    description: 'Trạng thái đầy đủ mới của cấu hình đơn vị bán; bỏ trống để giữ nguyên',
  })
  units?: ProductUnitRequest[];
}
