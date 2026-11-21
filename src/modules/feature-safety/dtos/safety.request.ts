import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Tối đa bằng số dòng một đơn có thể có. */
const MAX_CART_PRODUCTS = 100;

export class SafetyCheckRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CART_PRODUCTS)
  @IsUUID(undefined, { each: true })
  @ApiProperty({ type: [String], description: 'Hàng hoá trong giỏ (thứ tự thêm vào giỏ)' })
  productIds: string[];
}

export class CreateInteractionApprovalRequest extends SafetyCheckRequest {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Chi nhánh bán (vai trò toàn chuỗi bắt buộc gửi, như lúc lập đơn)' })
  branchId?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @ApiProperty({ description: 'Tên đăng nhập của dược sĩ duyệt' })
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiProperty({ description: 'Mật khẩu của dược sĩ duyệt' })
  password: string;

  @Transform(trim)
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  @ApiProperty({ description: 'Lý do vẫn bán (≥ 20 ký tự)' })
  reason: string;
}
