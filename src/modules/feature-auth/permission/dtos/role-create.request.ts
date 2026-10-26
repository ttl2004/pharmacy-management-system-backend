import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { PermissionCode } from '../permission.constant';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateRoleRequest {
  /** Mã vai trò (`code`) được sinh từ tên: bỏ dấu, viết HOA, nối bằng `_`. */
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  @ApiProperty({ example: 'Thủ kho' })
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  @ApiPropertyOptional()
  description?: string;

  /** Phải lớn hơn cấp CUSTOMER (20) và nhỏ hơn cấp của người tạo. */
  @IsInt()
  @ApiProperty({ example: 50 })
  level: number;

  @IsArray()
  @IsString({ each: true })
  @ApiProperty({ type: [String], example: ['stock:read'] })
  permissionCodes: PermissionCode[];
}
