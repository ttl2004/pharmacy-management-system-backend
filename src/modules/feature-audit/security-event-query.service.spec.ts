import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { SecurityEventQuery } from './dtos/security-event.query';
import { SecurityEventQueryService } from './security-event-query.service';

const actorOf = (role: AuthRole): RequestActor =>
  ({ user: { userId: 'u1', sid: 's', email: null, role, branchId: null, roleLevel: 80 } }) as unknown as RequestActor;
const q = (p: Partial<SecurityEventQuery> = {}) => Object.assign(new SecurityEventQuery(), p);

function setup(rows: unknown[] = []) {
  const prisma = {
    securityEvent: { findMany: jest.fn().mockResolvedValue(rows) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, service: new SecurityEventQueryService(prisma as never) };
}
const where = (fn: jest.Mock) => (fn.mock.calls as { where: unknown }[][])[0][0].where;

describe('SecurityEventQueryService', () => {
  it('ADMIN không thấy dòng SUPER_ADMIN; SUPER_ADMIN thấy', async () => {
    const admin = setup();
    await admin.service.list(q(), actorOf(AuthRole.ADMIN));
    expect(JSON.stringify(where(admin.prisma.securityEvent.findMany))).toContain(
      JSON.stringify({ OR: [{ actorRoleCode: null }, { actorRoleCode: { not: 'SUPER_ADMIN' } }] }),
    );
    const root = setup();
    await root.service.list(q(), actorOf(AuthRole.SUPER_ADMIN));
    expect(JSON.stringify(where(root.prisma.securityEvent.findMany))).not.toContain('SUPER_ADMIN');
  });

  it('khoảng ngày > 90 → 1002; fromDate > toDate → 1002', async () => {
    const { service } = setup();
    for (const query of [
      q({ fromDate: '2026-01-01', toDate: '2026-06-01' }),
      q({ fromDate: '2026-06-01', toDate: '2026-01-01' }),
    ]) {
      await expect(service.list(query, actorOf(AuthRole.ADMIN))).rejects.toMatchObject({
        errorCode: ErrorCode.HTTP_BAD_REQUEST,
      });
    }
    await expect(
      service.list(q({ fromDate: '2026-01-01', toDate: '2026-03-31' }), actorOf(AuthRole.ADMIN)),
    ).resolves.toBeDefined();
  });

  it('lọc type[], outcome, actorId, ip; phân trang cursor lấy limit+1 và không lộ userAgent', async () => {
    const { service, prisma } = setup();
    await service.list(
      q({ type: ['AUTH.LOGIN_FAILED'], outcome: 'FAILED', actorId: 'a', ip: '1.1.1.1', limit: 20 }),
      actorOf(AuthRole.ADMIN),
    );
    const args = (prisma.securityEvent.findMany.mock.calls as Record<string, unknown>[][])[0][0];
    const text = JSON.stringify(args.where);
    expect(text).toContain('"type":{"in":["AUTH.LOGIN_FAILED"]}');
    expect(text).toContain('"outcome":"FAILED"');
    expect(text).toContain('"ipAddress":"1.1.1.1"');
    expect(args.take).toBe(21);
    expect(JSON.stringify(args.select)).not.toContain('userAgent');
  });
});
