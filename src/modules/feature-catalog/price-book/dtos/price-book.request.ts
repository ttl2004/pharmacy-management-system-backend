import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Giá gốc của công thức: 3 khoá cố định hoặc id một bảng giá khác. */
const BASE_PATTERN = /^(avgCost|lastPurchaseCost|general|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const MAX_SCOPE_IDS = 200;

export class PriceBookFormulaRequest {
  @Matches(BASE_PATTERN, { message: 'Giá gốc phải là avgCost, lastPurchaseCost, general hoặc id một bảng giá' })
  @ApiProperty({ example: 'avgCost', description: 'avgCost | lastPurchaseCost | general | <id bảng giá khác>' })
  base: string;

  @IsIn(['+', '-'], { message: 'Phép tính công thức phải là + hoặc -' })
  @ApiProperty({ enum: ['+', '-'] })
  op: '+' | '-';

  @IsInt({ message: 'Giá trị công thức phải là số nguyên' })
  @Min(0, { message: 'Giá trị công thức không được âm' })
  @ApiProperty({ example: 10 })
  amount: number;

  @IsIn(['vnd', '%'], { message: 'Đơn vị công thức phải là vnd hoặc %' })
  @ApiProperty({ enum: ['vnd', '%'] })
  unit: 'vnd' | '%';
}

/** Dùng cho cả tạo và sửa — bảng giá luôn được gửi đủ, không có PATCH từng phần. */
export class PriceBookRequest {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Thiếu tên bảng giá' })
  @MaxLength(100, { message: 'Tên bảng giá tối đa 100 ký tự' })
  @ApiProperty({ example: 'Giá sỉ' })
  name: string;

  @IsDateString({}, { message: 'Ngày bắt đầu không hợp lệ' })
  @ApiProperty({ example: '2026-10-01T00:00:00+07:00' })
  startAt: string;

  @IsDateString({}, { message: 'Ngày kết thúc không hợp lệ' })
  @ApiProperty({ example: '2026-10-31T23:59:00+07:00', description: 'Phải sau ngày bắt đầu' })
  endAt: string;

  @IsIn(['active', 'inactive'])
  @ApiProperty({ enum: ['active', 'inactive'] })
  status: 'active' | 'inactive';

  @IsArray()
  @ArrayMaxSize(MAX_SCOPE_IDS)
  @IsUUID('all', { each: true })
  @ApiProperty({ type: [String], description: 'Rỗng = toàn hệ thống (quản lý chi nhánh KHÔNG được gửi rỗng)' })
  branchIds: string[];

  @IsArray()
  @ArrayMaxSize(MAX_SCOPE_IDS)
  @IsUUID('all', { each: true })
  @ApiProperty({ type: [String], description: 'Rỗng = mọi người bán' })
  userIds: string[];

  @IsIn(['allow', 'warn', 'block'])
  @ApiProperty({ enum: ['allow', 'warn', 'block'] })
  outOfBookPolicy: 'allow' | 'warn' | 'block';

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceBookFormulaRequest)
  @ApiPropertyOptional({ type: PriceBookFormulaRequest, description: 'Không gửi = bỏ công thức' })
  formula?: PriceBookFormulaRequest;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Chỉ PUT: tính lại giá các dòng đang có theo công thức' })
  reapplyFormula?: boolean;
}
