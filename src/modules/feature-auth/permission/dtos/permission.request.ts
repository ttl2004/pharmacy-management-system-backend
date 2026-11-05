import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { PermissionCode } from '../permission.constant';

export class ReplaceRolePermissionsRequest {
  /** Ghi đè toàn bộ: quyền không có trong danh sách này sẽ bị thu hồi. Danh sách rỗng là thu hồi hết. */
  @IsArray()
  @IsString({ each: true })
  @ApiProperty({ type: [String], example: ['permission:read'] })
  permissionCodes: PermissionCode[];

  /** Lý do lưu thay đổi — MỘT lý do chung cho cả lần lưu, ghi vào nhật ký. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ApiProperty({ example: 'Thu hẹp quyền theo yêu cầu kiểm toán', maxLength: 500 })
  reason: string;
}

export class AssignRoleRequest {
  @IsString()
  @ApiProperty({ example: 'PHARMACY_MANAGER' })
  roleCode: string;

  /** Lý do đổi vai trò, ghi vào nhật ký. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @ApiProperty({ example: 'Được bổ nhiệm quản lý chi nhánh', maxLength: 500 })
  reason: string;
}
