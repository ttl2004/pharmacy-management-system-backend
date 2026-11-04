import { Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogQueryService, buildScopeWhere } from './audit-log-query.service';
import { AuditLogQuery } from './dtos/audit-log.query';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';

function actorOf(role: AuthRole, branchId: string | null): RequestActor {
  return {
    user: { userId: 'u1', sid: 's', email: null, role, branchId, level: 60 },
    ip: null,
    userAgent: null,
    requestId: null,
  } as unknown as RequestActor;
}
const pm = actorOf(AuthRole.PHARMACY_MANAGER, BRANCH_A);
const admin = actorOf(AuthRole.ADMIN, null);

function q(partial: Partial<AuditLogQuery> = {}): AuditLogQuery {
  return Object.assign(new AuditLogQuery(), partial);
}

const firstArg = (fn: jest.Mock): Record<string, unknown> => (fn.mock.calls as Record<string, unknown>[][])[0][0];

function setup() {
  const prisma = {
    auditLog: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return { prisma, service: new AuditLogQueryService(prisma as never) };
}

describe('buildScopeWhere', () => {
  it('PM: where chứa branchIds has own, không có nhánh branchId null', () => {
    const where = buildScopeWhere(resolveBranchScope(pm.user), q());
    expect(where).toEqual({ AND: [{ branchIds: { has: BRANCH_A } }] });
    expect(JSON.stringify(where)).not.toContain('null');
  });

  it('PM lọc branchId chi nhánh khác → 1506', () => {
    expect.assertions(1);
    try {
      buildScopeWhere(resolveBranchScope(pm.user), q({ branchId: BRANCH_B }));
    } catch (e) {
      expect((e as { getResponse(): { code: number } }).getResponse().code).toBe(ErrorCode.BRANCH_ACCESS_DENIED);
    }
  });

  it('ADMIN: không lọc thì where rỗng phần scope', () => {
    expect(buildScopeWhere(resolveBranchScope(admin.user), q())).toEqual({ AND: [] });
  });

  it('ADMIN: branchIds → hasSome', () => {
    expect(buildScopeWhere({ kind: 'ALL' }, q({ branchIds: [BRANCH_A, BRANCH_B] }))).toEqual({
      AND: [{ branchIds: { hasSome: [BRANCH_A, BRANCH_B] } }],
    });
  });
});

describe('AuditLogQueryService.list', () => {
  it('search không kèm ngày → 1002; khoảng 91 ngày → 1002', async () => {
    const { service } = setup();
    await expect(service.list(q({ search: 'huy hang' }), admin)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    await expect(
      service.list(q({ search: 'huy hang', fromDate: '2026-01-01', toDate: '2026-04-02' }), admin),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('search 2 ký tự sau fold → 1002', async () => {
    const { service } = setup();
    await expect(
      service.list(q({ search: 'Đa ', fromDate: '2026-01-01', toDate: '2026-01-31' }), admin),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('không search: findMany thuần, không gọi $queryRaw; event/severity lọc đúng', async () => {
    const { prisma, service } = setup();
    await service.list(q({ event: ['ORDER.VOID_PAID', 'PAYMENT.REFUNDED'], severity: 1 }), pm);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    const where = firstArg(prisma.auditLog.findMany).where as { AND: unknown[] };
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { AND: [{ branchIds: { has: BRANCH_A } }] },
        { event: { in: ['ORDER.VOID_PAID', 'PAYMENT.REFUNDED'] } },
        { severity: { gte: 1 } },
      ]),
    );
  });

  it('câu raw chứa điều kiện phạm vi PM và khoảng ngày (snapshot SQL)', async () => {
    const { prisma, service } = setup();
    await service.list(q({ search: 'Hủy', fromDate: '2026-01-01', toDate: '2026-01-31', severity: 1 }), pm);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = firstArg(prisma.$queryRaw) as Prisma.Sql;
    expect(sql.sql).toContain('"branchIds" @>');
    expect(sql.sql).toContain('"createdAt" >=');
    expect(sql.sql).toContain('"createdAt" <');
    expect(sql.sql).toContain('"searchText" LIKE');
    expect(sql.sql).toContain('"severity" >=');
    expect(sql.sql).toContain('LIMIT');
    expect(sql.values).toEqual(expect.arrayContaining([BRANCH_A, '%huy%']));
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled(); // 0 id → không truy vấn thêm
  });

  it('kết quả không chứa searchText', async () => {
    const { prisma, service } = setup();
    await service.list(q({}), admin);
    const select = firstArg(prisma.auditLog.findMany).select as Record<string, unknown>;
    expect(select).not.toHaveProperty('searchText');
    expect(select).not.toHaveProperty('userAgent');
    expect(select).toMatchObject({ event: true, severity: true, amount: true, branchIds: true, requestId: true });
  });

  it('amount trả dạng chuỗi, traceId = requestId', async () => {
    const { prisma, service } = setup();
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a',
        createdAt: new Date(),
        entityType: 'orders',
        entityId: 'e',
        entityLabel: 'DH1',
        amount: 5000n,
        requestId: 'r',
      },
    ]);
    const res = await service.list(q({}), admin);
    expect(res.items[0]).toMatchObject({ amount: '5000', traceId: 'r' });
  });
});
