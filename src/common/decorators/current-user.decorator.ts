import { createParamDecorator, ExecutionContext, Logger } from '@nestjs/common';
import { JwtUser } from 'src/modules/feature-auth/authz/types/authz.types';

export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext): JwtUser => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
