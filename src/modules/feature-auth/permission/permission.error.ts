import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ErrorCode } from 'src/common/types/error-code';

export type PermissionErrorCode =
  | ErrorCode.PERMISSION_DENIED
  | ErrorCode.PERMISSION_NOT_DECLARED
  | ErrorCode.ROLE_NOT_FOUND
  | ErrorCode.PERMISSION_NOT_FOUND
  | ErrorCode.ROLE_NOT_EDITABLE
  | ErrorCode.CANNOT_CHANGE_OWN_ROLE
  | ErrorCode.BRANCH_ACCESS_DENIED
  | ErrorCode.BRANCH_NOT_ASSIGNED;

const permissionMessages: Record<PermissionErrorCode, string> = {
  [ErrorCode.PERMISSION_DENIED]: 'Bạn không có quyền thực hiện thao tác này',
  [ErrorCode.PERMISSION_NOT_DECLARED]: 'Đường dẫn chưa khai báo quyền yêu cầu',
  [ErrorCode.ROLE_NOT_FOUND]: 'Vai trò không tồn tại',
  [ErrorCode.PERMISSION_NOT_FOUND]: 'Quyền không tồn tại trong danh mục',
  [ErrorCode.ROLE_NOT_EDITABLE]: 'Không thể sửa quyền của vai trò này',
  [ErrorCode.CANNOT_CHANGE_OWN_ROLE]: 'Không thể tự đổi vai trò của chính mình',
  [ErrorCode.BRANCH_ACCESS_DENIED]: 'Không được thao tác dữ liệu của chi nhánh khác',
  [ErrorCode.BRANCH_NOT_ASSIGNED]: 'Tài khoản nhân viên chưa được gán chi nhánh',
};

export function permissionError(code: PermissionErrorCode) {
  const payload = { code, message: permissionMessages[code] };

  if (code === ErrorCode.ROLE_NOT_FOUND) return new NotFoundException(payload);
  if (code === ErrorCode.PERMISSION_NOT_FOUND) return new BadRequestException(payload);
  return new ForbiddenException(payload);
}
