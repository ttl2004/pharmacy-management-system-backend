import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserThrottlerGuard } from 'src/common/guards/user-throttler.guard';
import { AuthzGuard } from './guards/auth.guard';
import { AuthzController } from './authz.controller';

describe('POST /auth/change-password — giới hạn số lần thử (L5)', () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- chỉ đọc metadata của decorator, không gọi hàm
  const handler = AuthzController.prototype.changePassword;

  it('throttle theo NGƯỜI DÙNG, đặt sau AuthzGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
    expect(guards).toEqual([AuthzGuard, UserThrottlerGuard]);
  });

  it('tối đa 5 lần mỗi phút', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });
});
