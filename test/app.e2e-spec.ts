import { ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookie from '@fastify/cookie';
import * as bcrypt from 'bcrypt';
import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AuthzModule } from '../src/modules/feature-auth/authz/authz.module';
import { AuthConfig } from '../src/modules/feature-auth/authz/auth.config';
import { PrismaService } from '../src/common/databases/prisma.service';
import { PrismaDatabaseModule } from '../src/common/databases/drivers/prisma.module';
import { TokenService } from '../src/modules/feature-auth/authz/token.service';
import { PasswordService } from '../src/modules/feature-auth/authz/password.service';
import type { AuthJwtPayload } from '../src/modules/feature-auth/authz/types/authz.types';
import { AuthRole } from '../src/common/types/common.enum';
import { ErrorCode } from '../src/common/types/error-code';
import { validateEnv } from '../src/common/configs/env.validation';
import { ResolveExceptionFilter } from '../src/common/exceptions/resolve.exception';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

interface ApiBody {
  data: { accessToken: string; refreshToken?: string };
  code: ErrorCode;
  message: string;
}
function bodyOf(response: request.Response): ApiBody {
  return response.body as ApiBody;
}

interface Pair {
  accessToken: string;
  refreshToken: string;
  cookie: string;
}
const secret = 'test-only-access-secret-at-least-32-characters';

// Mỗi chế độ dùng SQLite in-memory riêng, guard và bộ giới hạn tần suất thực tế.
describe.each([false, true])('Một phiên đăng nhập: body=%s', (inBody) => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let dbDir: string;
  let userId: string;
  let passwordHash: string;
  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'pos-ndm-e2e-'));
    process.env.DATABASE_URL = `file:${join(dbDir, 'test.sqlite')}`;
    execSync('npx prisma migrate deploy', { env: { ...process.env }, stdio: 'inherit' });

    const fixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          validate: () =>
            validateEnv({
              JWT_ACCESS_SECRET: secret,
              AUTH_REFRESH_IN_BODY: String(inBody),
              DATABASE_URL: process.env.DATABASE_URL,
            }),
        }),
        // AppModule không được nạp trong test nên phải tự đăng ký nguồn DB.
        PrismaDatabaseModule.forRoot(),
        AuthzModule,
        ScheduleModule.forRoot(),
      ],
    }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(cookie);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new ResolveExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    passwordHash = await bcrypt.hash('Original-password1', 10);
  });
  beforeEach(async () => {
    app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
    await prisma.refreshToken.deleteMany();
    await prisma.auth.deleteMany();
    await prisma.user.deleteMany();
    const user = await prisma.user.create({
      data: { email: 'test@example.test', fullName: 'Test', role: AuthRole.SUPER_ADMIN, createdAt: new Date() },
    });
    userId = user.id;
    await prisma.auth.create({
      data: { userId, username: 'tester', password: passwordHash, createdAt: new Date() },
    });
  });
  afterAll(async () => {
    await app?.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  function pairFrom(res: request.Response): Pair {
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/auth');
    const cookieValue = setCookie.split(';')[0];
    const raw = decodeURIComponent(cookieValue.slice(cookieValue.indexOf('=') + 1));
    if (inBody) expect(bodyOf(res).data.refreshToken).toBe(raw);
    else expect(bodyOf(res).data).not.toHaveProperty('refreshToken');
    return { accessToken: bodyOf(res).data.accessToken, refreshToken: raw, cookie: cookieValue };
  }
  async function login() {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'tester', password: 'Original-password1' })
      .expect(200);
    return pairFrom(res);
  }
  function refresh(pair: Pair) {
    const req = request(app.getHttpServer()).post('/auth/refresh');
    return inBody ? req.send({ refreshToken: pair.refreshToken }) : req.set('Cookie', pair.cookie).send({});
  }
  function refreshedPair(res: request.Response, existing: Pair): Pair {
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(bodyOf(res).data)).toEqual(['accessToken']);
    return { ...existing, accessToken: bodyOf(res).data.accessToken };
  }
  function me(pair: Pair) {
    return request(app.getHttpServer()).get('/auth/me').auth(pair.accessToken, { type: 'bearer' });
  }
  async function revoked(pair: Pair) {
    const res = await me(pair).expect(401);
    expect(bodyOf(res).code).toBe(ErrorCode.SESSION_REVOKED);
  }

  it('Đăng nhập B thu hồi ngay access A đã cache và refresh A, nhưng giữ phiên B', async () => {
    const a = await login();
    await me(a).expect(200); // Đưa trạng thái phiên đang hoạt động vào cache.
    const b = await login();
    await revoked(a);
    const res = await refresh(a).expect(401);
    expect(bodyOf(res).code).toBe(ErrorCode.SESSION_REVOKED);
    await me(b).expect(200);
    await refresh(b).expect(200);
  });

  it('Thời gian trả về client là chuỗi ISO 8601, bản ghi mới có updatedAt null', async () => {
    const a = await login();
    const res = await me(a).expect(200);
    const data = bodyOf(res).data as unknown as { createdAt: unknown; updatedAt: unknown };

    expect(typeof data.createdAt).toBe('string');
    expect(data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(data.updatedAt).toBeNull();
  });

  it('Hai lần đăng nhập song song đều thành công, không lỗi khoá ghi', async () => {
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post('/auth/login').send({ username: 'tester', password: 'Original-password1' }),
      request(app.getHttpServer()).post('/auth/login').send({ username: 'tester', password: 'Original-password1' }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('Refresh chỉ cấp AT mới, giữ nguyên RT, sid, hạn dùng và bản ghi trong DB', async () => {
    const a = await login();
    const before = await prisma.refreshToken.findFirstOrThrow({ where: { userId } });
    const b = refreshedPair(await refresh(a).expect(200), a);
    const jwt = app.get(JwtService);
    expect(jwt.decode<AuthJwtPayload>(b.accessToken).sid).toBe(jwt.decode<AuthJwtPayload>(a.accessToken).sid);
    expect(jwt.decode<AuthJwtPayload>(b.accessToken).jti).not.toBe(jwt.decode<AuthJwtPayload>(a.accessToken).jti);
    expect(Object.keys(jwt.decode<AuthJwtPayload>(b.accessToken)).sort()).toEqual([
      'exp',
      'iat',
      'jti',
      'role',
      'sid',
      'sub',
    ]);
    const rows = await prisma.refreshToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].lastUsedAt).toBeInstanceOf(Date);
    expect({ ...rows[0], lastUsedAt: before.lastUsedAt }).toEqual(before);
    expect(rows[0].tokenHash).toBe(createHash('sha256').update(a.refreshToken).digest('hex'));
    expect(rows[0].revokedAt).toBeNull();
    expect(rows[0].replacedById).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(a.refreshToken);
    await me(b).expect(200);
    await refresh(b).expect(200);
  });

  it('Cấp token thất bại không làm mất hiệu lực RT hiện tại', async () => {
    const a = await login();
    await me(a).expect(200);
    const signing = jest.spyOn(app.get(JwtService), 'signAsync');
    try {
      signing.mockRejectedValueOnce(new Error('Lỗi ký token giả lập'));
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'tester', password: 'Original-password1' })
        .expect(500);
      await me(a).expect(200);
      signing.mockRejectedValueOnce(new Error('Lỗi ký token giả lập'));
      await refresh(a).expect(500);
      await me(a).expect(200);
      await refresh(a).expect(200);
    } finally {
      signing.mockRestore();
    }
  });

  it('Từ chối chữ ký sai và token đã ký nhưng thiếu thông tin phiên', async () => {
    const a = await login();
    const payload = app.get(JwtService).decode<AuthJwtPayload>(a.accessToken);
    const forged = await app
      .get(JwtService)
      .signAsync(
        { sub: payload.sub, role: payload.role, sid: payload.sid, jti: randomUUID() },
        { secret: 'different-test-key' },
      );
    expect(bodyOf(await me({ ...a, accessToken: forged }).expect(401)).code).toBe(ErrorCode.INVALID_TOKEN);
    const legacy = await app.get(JwtService).signAsync({ sub: payload.sub, role: payload.role });
    expect(bodyOf(await me({ ...a, accessToken: legacy }).expect(401)).code).toBe(ErrorCode.INVALID_TOKEN);
  });

  it('Dùng cùng RT nhiều lần không thu hồi phiên và không tạo thêm bản ghi', async () => {
    const a = await login();
    const initial = await prisma.refreshToken.findFirstOrThrow({ where: { userId } });
    for (let i = 0; i < 20; i++) {
      const next = refreshedPair(await refresh(a).expect(200), a);
      await me(next).expect(200);
    }
    expect(await prisma.refreshToken.count()).toBe(1);
    const latest = await prisma.refreshToken.findFirstOrThrow({ where: { userId } });
    expect(latest.lastUsedAt).toBeInstanceOf(Date);
    expect({ ...latest, lastUsedAt: initial.lastUsedAt }).toEqual(initial);
  });

  it.each(['logout', 'logout-all'])('%s thu hồi phiên ngay và xóa cookie tương ứng', async (endpoint) => {
    const a = await login();
    await me(a).expect(200);
    const res = await request(app.getHttpServer())
      .post(`/auth/${endpoint}`)
      .auth(a.accessToken, { type: 'bearer' })
      .set('Cookie', a.cookie)
      .send({})
      .expect(200);
    expect(res.headers['set-cookie'][0]).toContain('Path=/auth');
    expect(res.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
    await revoked(a);
    await refresh(a).expect(401);
  });

  it('Access token hết hạn trả TOKEN_EXPIRED trong khi refresh vẫn dùng được', async () => {
    const a = await login();
    const payload = app.get(JwtService).decode<AuthJwtPayload>(a.accessToken);
    const expired = await app
      .get(JwtService)
      .signAsync({ sub: payload.sub, role: payload.role, sid: payload.sid, jti: randomUUID() }, { expiresIn: -1 });
    expect(bodyOf(await me({ ...a, accessToken: expired }).expect(401)).code).toBe(ErrorCode.TOKEN_EXPIRED);
    await me(refreshedPair(await refresh(a).expect(200), a)).expect(200);
  });

  it('Đăng xuất nhận token từ body theo cờ cấu hình nhưng vẫn xác định phiên bằng sid', async () => {
    const a = await login();
    await request(app.getHttpServer())
      .post('/auth/logout')
      .auth(a.accessToken, { type: 'bearer' })
      .send({ refreshToken: a.refreshToken })
      .expect(200);
    const token = await prisma.refreshToken.findFirstOrThrow({ where: { userId } });
    if (inBody) expect(token.lastUsedAt).toBeInstanceOf(Date);
    else expect(token.lastUsedAt).toBeNull();
    await revoked(a);
  });

  it('Đổi mật khẩu thu hồi toàn bộ token cũ và yêu cầu mật khẩu mới', async () => {
    const a = await login();
    await me(a).expect(200);
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .auth(a.accessToken, { type: 'bearer' })
      .send({ currentPassword: 'wrong', newPassword: 'Updated-password1' })
      .expect(401);
    await me(a).expect(200);
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .auth(a.accessToken, { type: 'bearer' })
      .send({ currentPassword: 'Original-password1', newPassword: 'Updated-password1' })
      .expect(200);
    await revoked(a);
    await refresh(a).expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'tester', password: 'Original-password1' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'tester', password: 'Updated-password1' })
      .expect(200);
  });

  it('Đặt lại mật khẩu nội bộ tạo hash mới và thu hồi các phiên hiện có', async () => {
    const a = await login();
    await me(a).expect(200);
    await app.get(PasswordService).resetPassword(userId, 'Reset-password1');
    await revoked(a);
    await refresh(a).expect(401);
    const credentials = await prisma.auth.findFirstOrThrow({ where: { userId } });
    expect(credentials.password).not.toBe('Reset-password1');
    expect(await bcrypt.compare('Reset-password1', credentials.password)).toBe(true);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'tester', password: 'Reset-password1' })
      .expect(200);
  });

  it('Refresh đồng thời cùng RT đều cấp AT và không tạo thêm RT hay thu hồi phiên', async () => {
    const a = await login();
    const results = await Promise.all([refresh(a), refresh(a)]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    for (const res of results) await me(refreshedPair(res, a)).expect(200);
    expect(bodyOf(results[0]).data.accessToken).not.toBe(bodyOf(results[1]).data.accessToken);
    expect(await prisma.refreshToken.count()).toBe(1);
  });

  it('Nhận token từ body theo cờ cấu hình và luôn ưu tiên cookie', async () => {
    const a = await login();
    const body = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: a.refreshToken })
      .expect(inBody ? 200 : 401);
    if (inBody) refreshedPair(body, a);
    else expect(bodyOf(body).code).toBe(ErrorCode.INVALID_TOKEN);
    const b = await login();
    expect(
      bodyOf(
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', 'refreshToken=invalid-cookie')
          .send({ refreshToken: b.refreshToken })
          .expect(401),
      ).code,
    ).toBe(ErrorCode.INVALID_TOKEN);
    await refresh(b).expect(200);
  });

  it('Refresh token hết hạn và token không tồn tại có mã lỗi riêng', async () => {
    const a = await login();
    await prisma.refreshToken.updateMany({ where: { userId }, data: { expiresAt: new Date(0) } });
    expect(bodyOf(await refresh(a).expect(401)).code).toBe(ErrorCode.TOKEN_EXPIRED);
    expect(
      bodyOf(await refresh({ ...a, refreshToken: 'unknown', cookie: 'refreshToken=unknown' }).expect(401)).code,
    ).toBe(ErrorCode.INVALID_TOKEN);
  });

  it('Refresh sát hạn không gia hạn RT; đến hạn phiên yêu cầu đăng nhập lại dù AT còn hạn', async () => {
    const a = await login();
    const original = await prisma.refreshToken.findFirstOrThrow({ where: { userId } });
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(original.expiresAt.getTime() - 1000);
      const latest = refreshedPair(await refresh(a).expect(200), a);
      await me(latest).expect(200);
      expect((await prisma.refreshToken.findFirstOrThrow({ where: { userId } })).expiresAt).toEqual(original.expiresAt);
      clock.mockReturnValue(original.expiresAt.getTime());
      expect(bodyOf(await refresh(a).expect(401)).code).toBe(ErrorCode.TOKEN_EXPIRED);
      await revoked(latest);
    } finally {
      clock.mockRestore();
    }
    const b = await login();
    expect(b.refreshToken).not.toBe(a.refreshToken);
    await me(b).expect(200);
  });

  it('Tên đăng nhập không tồn tại và mật khẩu sai trả cùng lỗi', async () => {
    const responses = await Promise.all(
      ['tester', 'unknown'].map((username) =>
        request(app.getHttpServer()).post('/auth/login').send({ username, password: 'wrong' }).expect(401),
      ),
    );
    expect(responses.map((res) => [bodyOf(res).code, bodyOf(res).message])).toEqual([
      [ErrorCode.LOGIN_INVALID, 'Thông tin đăng nhập không chính xác'],
      [ErrorCode.LOGIN_INVALID, 'Thông tin đăng nhập không chính xác'],
    ]);
    await request(app.getHttpServer()).post('/auth/login').send({ username: 'tester' }).expect(400);
    await request(app.getHttpServer()).post('/authz/login').send({}).expect(404);
  });

  it('Đăng nhập và refresh đều được giới hạn tần suất', async () => {
    for (let i = 0; i < 10; i++) await request(app.getHttpServer()).post('/auth/login').send({}).expect(400);
    await request(app.getHttpServer()).post('/auth/login').send({}).expect(429);
    for (let i = 0; i < 30; i++) await request(app.getHttpServer()).post('/auth/refresh').send({}).expect(401);
    await request(app.getHttpServer()).post('/auth/refresh').send({}).expect(429);
  });

  it('Dọn token hết hạn hoặc đã thu hồi quá lâu, giữ lại các bản ghi còn hiệu lực', async () => {
    expect(app.get(SchedulerRegistry).getCronJobs().size).toBe(1);
    await login();
    const template = (await prisma.refreshToken.findMany())[0];
    await prisma.refreshToken.createMany({
      data: [
        { ...template, id: randomUUID(), tokenHash: 'expired', expiresAt: new Date(0) },
        { ...template, id: randomUUID(), tokenHash: 'old-revoked', revokedAt: new Date(Date.now() - 31 * 86400000) },
        { ...template, id: randomUUID(), tokenHash: 'recent-revoked', revokedAt: new Date() },
      ],
    });
    await app.get(TokenService).cleanup();
    expect((await prisma.refreshToken.findMany()).map((row) => row.tokenHash).sort()).toEqual(
      [template.tokenHash, 'recent-revoked'].sort(),
    );
  });

  it('Swagger mô tả refreshToken là trường tùy chọn và khai báo các đường dẫn mới', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
    expect(document.paths['/auth/login']).toBeDefined();
    expect(document.paths['/authz/login']).toBeUndefined();
    const schema = document.components?.schemas?.TokenResponse;
    expect(schema && 'required' in schema ? schema.required : []).toEqual(['accessToken']);
    const accessSchema = document.components?.schemas?.AccessTokenResponse;
    expect(accessSchema && 'properties' in accessSchema ? accessSchema.properties : {}).not.toHaveProperty(
      'refreshToken',
    );
    expect(document.paths['/auth/refresh'].post?.responses['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessTokenEnvelopeResponse' } } },
    });
    expect(document.paths['/auth/refresh'].post?.responses['401']).toBeDefined();
  });
});

describe('Kiểm tra biến môi trường xác thực', () => {
  it('Mặc định chỉ dùng cookie Strict và từ chối cấu hình không hợp lệ', () => {
    const valid = validateEnv({ JWT_ACCESS_SECRET: secret });
    expect(valid.AUTH_REFRESH_IN_BODY).toBe('false');
    expect(valid.COOKIE_PATH).toBe('/auth');
    for (const invalid of [
      { AUTH_REFRESH_IN_BODY: 'yes' },
      { COOKIE_SECURE: 'yes' },
      { COOKIE_SAMESITE: 'other' },
      { JWT_ACCESS_TTL: '0m' },
      { REFRESH_TTL: '7' },
      { JWT_ACCESS_SECRET: '' },
      { COOKIE_PATH: 'auth' },
      { COOKIE_SAMESITE: 'none' },
    ]) {
      expect(() => validateEnv({ JWT_ACCESS_SECRET: secret, ...invalid })).toThrow();
    }
  });
  it('Môi trường production không thay đổi hành vi trả token trong body', () => {
    const env = validateEnv({ JWT_ACCESS_SECRET: secret, AUTH_REFRESH_IN_BODY: 'true', NODE_ENV: 'production' });
    expect(new AuthConfig(new ConfigService(env)).refreshInBody).toBe(true);
  });
});
