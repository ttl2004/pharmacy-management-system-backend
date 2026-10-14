import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { JwtUser } from 'src/modules/feature-auth/authz/types/authz.types';

/**
 * Người thực hiện một thao tác ghi: ai (để kiểm phạm vi chi nhánh, ghi `…By`) và từ đâu (IP, ghi vào `audit_logs`).
 * Service nghiệp vụ nhận cả cụm này thay vì chỉ `userId`, để không phải sửa chữ ký hàm khi nhật ký cần thêm thông tin.
 */
export interface RequestActor {
  user: JwtUser;
  ip: string | null;
}

/** Chỉ dùng sau `AuthzGuard` — trước đó `request.user` chưa có. */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestActor => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest & { user: JwtUser }>();
  return { user: request.user, ip: request.ip ?? null };
});
