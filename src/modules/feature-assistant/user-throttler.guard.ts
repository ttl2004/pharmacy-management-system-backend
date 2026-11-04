import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Giới hạn theo người dùng thay vì IP: FE đi qua Vite proxy nên mọi người cùng một IP.
 * Phải đặt SAU `AuthzGuard` để `req.user` đã có.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return (req.user?.userId as string | undefined) ?? (req.ip as string);
  }
}
