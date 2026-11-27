import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from 'src/common/guards/user-throttler.guard';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { PermissionGuard } from '../feature-auth/permission/guards/permission.guard';
import { SafetyController } from './safety.controller';

const guardsOf = (method: 'check' | 'drugWarnings' | 'approve'): unknown[] => [
  ...((Reflect.getMetadata(GUARDS_METADATA, SafetyController) as unknown[] | undefined) ?? []),
  ...((Reflect.getMetadata(GUARDS_METADATA, SafetyController.prototype[method]) as unknown[] | undefined) ?? []),
];

/** Chặn vô tình mở/đóng nhầm route: tra tương tác công khai, duyệt của dược sĩ vẫn bắt đăng nhập + quyền. */
describe('SafetyController guards', () => {
  it.each(['check', 'drugWarnings'] as const)('%s: công khai, chỉ giới hạn theo IP', (method) => {
    expect(guardsOf(method)).toEqual([ThrottlerGuard]);
  });

  it('approve: bắt buộc AuthzGuard → PermissionGuard → UserThrottlerGuard', () => {
    expect(guardsOf('approve')).toEqual([AuthzGuard, PermissionGuard, UserThrottlerGuard]);
  });
});
