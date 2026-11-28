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
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DuplicateResolutionRequest, ManualDrugInput } from '../../drug-leaflet/dtos/manual-drug.request';
import { ProductExtraFieldsRequest } from './product-extra-fields.request';

const CODE_PATTERN = /^[A-Z0-9_-]+$/;
const MAX_IMAGE_URLS = 10;
/** Cột `Int` của PostgreSQL tối đa 2.147.483.647; chặn ở 400 thay vì để Prisma ném 500. */
const MAX_MONEY = 1_000_000_000;
const MAX_CONVERSION_RATE = 1_000_000;
/** URL ảnh ngoài, hoặc đường dẫn ảnh do `POST /product-image` trả về (tên tệp UUID + đuôi ảnh). */
const IMAGE_URL_PATTERN = /^(https?:\/\/\S+|\/uploads\/products\/[0-9a-f-]{36}\.(png|jpg|webp|gif))$/;

/** `@Transform` chạy trước class-validator nên `sp0001` được đưa về `SP0001` rồi mới qua regex. */
const normalizeCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Khi tạo: để trống (hoặc chỉ khoảng trắng) = không gửi → BE tự sinh mã `SPxxxx`. */
const normalizeOptionalCode = ({ value }: { value: unknown }) => {
  const code = normalizeCode({ value });
  return code === '' || code === null ? undefined : code;
};

export class ProductUnitRequest {
  @IsUUID()
  @ApiProperty()
  unitId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_CONVERSION_RATE, { message: `Quy đổi tối đa ${MAX_CONVERSION_RATE.toLocaleString('en-US')}` })
  @ApiProperty({ description: 'Số đơn vị cơ bản trong một đơn vị này; dòng cơ bản phải bằng 1' })
  conversionRate: number;

  @IsInt()
  @Min(0)
  @Max(MAX_MONEY, { message: `Giá bán tối đa ${MAX_MONEY.toLocaleString('en-US')} đồng` })
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
  @IsBoolean()
  @ApiPropertyOptional({ default: true, description: 'Cho bán lẻ đơn vị này ở POS' })
  allowLooseSale?: boolean;

  @IsOptional()
  @IsEnum(RecordStatus)
  @ApiPropertyOptional({ enum: RecordStatus })
  status?: RecordStatus;
}

export class CreateProductRequest extends ProductExtraFieldsRequest {
  @IsOptional()
  @Transform(normalizeOptionalCode)
  @IsString()
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: 'code chỉ nhận chữ in hoa không dấu, chữ số, gạch ngang và gạch dưới' })
  @ApiPropertyOptional({ example: 'SP0001', description: 'Bỏ trống → hệ thống tự sinh `SP` + số tăng dần' })
  code?: string;

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
  @Matches(IMAGE_URL_PATTERN, {
    each: true,
    message: 'imageUrls chỉ nhận URL http(s) hoặc ảnh đã tải lên (/uploads/products/…)',
  })
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
  @ApiPropertyOptional({ description: 'Không gửi thì lấy "Chỉ định" của thuốc trong danh mục' })
  indications?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Không gửi thì lấy "Liều lượng" của thuốc trong danh mục' })
  dosageNote?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Không gửi thì lấy "Cách bảo quản" của thuốc trong danh mục' })
  storageNote?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MONEY, { message: `Định mức tồn tối thiểu tối đa ${MAX_MONEY.toLocaleString('en-US')}` })
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
export class UpdateProductRequest extends ProductExtraFieldsRequest {
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
  @Matches(IMAGE_URL_PATTERN, {
    each: true,
    message: 'imageUrls chỉ nhận URL http(s) hoặc ảnh đã tải lên (/uploads/products/…)',
  })
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
  @Max(MAX_MONEY, { message: `Định mức tồn tối thiểu tối đa ${MAX_MONEY.toLocaleString('en-US')}` })
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

  @IsOptional()
  @ValidateNested()
  @Type(() => ManualDrugInput)
  @ApiPropertyOptional({
    type: ManualDrugInput,
    description:
      'Sửa thông tin thuốc nhập tay (MANUAL) đang gắn với sản phẩm, dùng chung cho mọi sản phẩm gắn thuốc này. ' +
      'Thuốc DQG gửi khối này trả DRUG_NOT_MANUAL (1618)',
  })
  drug?: ManualDrugInput;

  @IsOptional()
  @ValidateNested()
  @Type(() => DuplicateResolutionRequest)
  @ApiPropertyOptional({
    type: DuplicateResolutionRequest,
    description:
      'Gửi lại sau lỗi trùng số đăng ký (1616/1617) khi đổi số đăng ký trong khối `drug`: LINK_DQG chuyển sản phẩm sang ' +
      'thuốc DQG, OVERWRITE_MANUAL chuyển sang thuốc nhập tay kia và ghi đè nó',
  })
  resolution?: DuplicateResolutionRequest;
}
