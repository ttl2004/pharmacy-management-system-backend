import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Giới hạn theo người dùng thay vì IP: FE đi qua Vite proxy nên mọi người cùng một IP.
 * Phải đặt SAU `AuthzGuard` để `req.user` đã có.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: { user?: { userId?: string }; ip: string }): Promise<string> {
    return Promise.resolve(req.user?.userId ?? req.ip);
  }
}
