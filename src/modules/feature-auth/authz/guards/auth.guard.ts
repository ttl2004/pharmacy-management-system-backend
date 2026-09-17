import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AUTH_JWT } from 'src/common/constants/app.constant';

@Injectable()
export class AuthzGuard extends AuthGuard(AUTH_JWT) {}
