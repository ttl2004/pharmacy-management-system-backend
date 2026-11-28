import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Cắt khoảng trắng hai đầu trước khi kiểm, để chuỗi toàn khoảng trắng không lọt qua `@IsNotEmpty`. */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Khối thông tin thuốc MANUAL (nhập tay từ tờ HDSD), dùng khi lưu bản nháp và khi sửa thuốc MANUAL qua sửa sản phẩm.
 * Độ dài tối đa theo cột của bảng `drugs`; cột Text không giới hạn. Trường tuỳ chọn gửi `null`/chuỗi rỗng để để trống.
 */
export class ManualDrugInput {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @ApiProperty({ example: 'VD-12345-12' })
  registrationNumber: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  @ApiProperty()
  name: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @ApiProperty({ description: 'Hoạt chất, nhiều hoạt chất nối bằng "; "' })
  ingredients: string;

  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional({ nullable: true })
  strength?: string | null;

  @IsOptional() @IsString() @MaxLength(250) @ApiPropertyOptional({ nullable: true, description: 'Dạng bào chế nguyên văn' })
  dosageFormText?: string | null;

  @IsOptional() @IsString() @MaxLength(250) @ApiPropertyOptional({ nullable: true })
  packagingSpec?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  indications?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  contraindications?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  dosage?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  sideEffects?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  warnings?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  storage?: string | null;

  @IsOptional() @IsString() @MaxLength(250) @ApiPropertyOptional({ nullable: true })
  manufacturerName?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  interactions?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  pregnancyLactation?: string | null;

  @IsOptional() @IsString() @ApiPropertyOptional({ nullable: true })
  overdose?: string | null;

  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional({ nullable: true })
  shelfLife?: string | null;

  @IsBoolean()
  @ApiProperty({ description: 'Thuốc kê đơn; sản phẩm gắn thuốc này theo cờ này' })
  isPrescription: boolean;

  @IsOptional() @IsString() @MaxLength(100)
  @ApiPropertyOptional({ nullable: true, description: 'Loại kiểm soát đặc biệt; có giá trị thì sản phẩm luôn bật cờ kiểm soát' })
  controlType?: string | null;

  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional({ nullable: true })
  drugGroup?: string | null;

  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional({ nullable: true })
  countryOfOrigin?: string | null;

  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional({ nullable: true })
  route?: string | null;
}

export const DUPLICATE_RESOLUTION_TYPES = ['LINK_DQG', 'OVERWRITE_MANUAL'] as const;
export type DuplicateResolutionType = (typeof DUPLICATE_RESOLUTION_TYPES)[number];

/** Cách xử lý khi trùng số đăng ký, gửi lại sau khi nhận lỗi 1616/1617. */
export class DuplicateResolutionRequest {
  @IsIn(DUPLICATE_RESOLUTION_TYPES)
  @ApiProperty({ enum: DUPLICATE_RESOLUTION_TYPES })
  type: DuplicateResolutionType;

  @IsUUID()
  @ApiProperty({ description: 'Thuốc trùng được chọn (nằm trong `details` của lỗi trùng)' })
  drugId: string;
}
