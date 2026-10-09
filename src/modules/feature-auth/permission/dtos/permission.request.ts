import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';
import type { PermissionCode } from '../permission.constant';

export class ReplaceRolePermissionsRequest {
  /** Ghi đè toàn bộ: quyền không có trong danh sách này sẽ bị thu hồi. Danh sách rỗng là thu hồi hết. */
  @IsArray()
  @IsString({ each: true })
  @ApiProperty({ type: [String], example: ['permission:read'] })
  permissionCodes: PermissionCode[];
}

export class AssignRoleRequest {
  @IsString()
  @ApiProperty({ example: 'PHARMACY_MANAGER' })
  roleCode: string;
}
