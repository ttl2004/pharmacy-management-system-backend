import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { foldVn } from 'src/common/utils/vn-fold.util';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { AuditLogQueryService } from './audit-log-query.service';
import { AuditLogQuery } from './dtos/audit-log.query';

/** Đọc nhật ký THẬT trên schema `audit_db_test`: phạm vi `branchIds`, tìm kiếm trigram, hồi quy `searchIds`. */
describe('audit đọc (db)', () => {
  let prisma: PrismaClient;
  let service: AuditLogQueryService;
  let actorId: string;
  let branchA: string;
  let branchB: string;

  const asActor = (role: AuthRole, branchId: string | null) =>
    ({
      user: { userId: actorId, role, branchId, email: null, sid: 's' },
      ip: null,
      userAgent: null,
      requestId: null,
    }) as unknown as RequestActor;
  const q = (p: Partial<AuditLogQuery> = {}) => Object.assign(new AuditLogQuery(), p);

  beforeAll(async () => {
    prisma = await createTestPrisma();
    service = new AuditLogQueryService(prisma as never);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    actorId = (await prisma.user.create({ data: { fullName: 'Người dùng', roleId: role.id } })).id;
    branchA = (await prisma.branch.create({ data: { code: 'CN01', name: 'CN 1', phone: '0900000001', address: 'HN' } }))
      .id;
    branchB = (await prisma.branch.create({ data: { code: 'CN02', name: 'CN 2', phone: '0900000002', address: 'HN' } }))
      .id;
  });

  function row(over: {
    branchIds: string[];
    createdAt?: Date;
    entityLabel?: string;
    reason?: string;
    entityType?: string;
    event?: string;
  }) {
    const label = over.entityLabel ?? 'Dòng';
    return {
      id: randomUUID(),
      createdAt: over.createdAt ?? new Date('2026-01-15T05:00:00Z'),
      actorId,
      action: 'UPDATE' as const,
      event: over.event ?? 'PRICE_BOOK.UPDATED',
      entityType: over.entityType ?? 'price_books',
      entityId: randomUUID(),
      entityLabel: label,
      branchIds: over.branchIds,
      branchId: over.branchIds.length === 1 ? over.branchIds[0] : null,
      reason: over.reason ?? null,
      searchText: foldVn([label, over.reason].filter(Boolean).join(' ')),
    };
  }

  it('PM chi nhánh A không thấy dòng branchIds=[] và dòng chỉ áp cho B; ADMIN thấy cả hai', async () => {
    await prisma.auditLog.createMany({
      data: [
        row({ branchIds: [branchA], entityLabel: 'Bảng giá A' }),
        row({ branchIds: [branchA, branchB], entityLabel: 'Bảng giá A+B' }),
        row({ branchIds: [branchB], entityLabel: 'Bảng giá B' }),
        row({ branchIds: [], entityLabel: 'Nhà cung cấp toàn chuỗi' }),
      ],
    });
    const pm = await service.list(q(), asActor(AuthRole.PHARMACY_MANAGER, branchA));
    expect(pm.items.map((r) => r.entityLabel).sort()).toEqual(['Bảng giá A', 'Bảng giá A+B']);
    const admin = await service.list(q(), asActor(AuthRole.ADMIN, null));
    expect(admin.items).toHaveLength(4);
    const adminB = await service.list(q({ branchId: branchB }), asActor(AuthRole.ADMIN, null));
    expect(adminB.items.map((r) => r.entityLabel).sort()).toEqual(['Bảng giá A+B', 'Bảng giá B']);
    expect(admin.items[0]).not.toHaveProperty('searchText');
  });

  it('search không dấu khớp reason có dấu, phạm vi PM áp cho cả đường search', async () => {
    await prisma.auditLog.createMany({
      data: [
        row({ branchIds: [branchA], reason: 'huỷ hàng hỏng' }),
        row({ branchIds: [branchB], reason: 'huỷ hàng hỏng' }),
        row({ branchIds: [branchA], reason: 'lý do khác' }),
      ],
    });
    const range = { fromDate: '2026-01-01', toDate: '2026-01-31' };
    const pm = await service.list(q({ search: 'Hủy', ...range }), asActor(AuthRole.PHARMACY_MANAGER, branchA));
    expect(pm.items).toHaveLength(1);
    expect(pm.items[0].reason).toBe('huỷ hàng hỏng');
    const admin = await service.list(q({ search: 'hủy hàng', ...range }), asActor(AuthRole.ADMIN, null));
    expect(admin.items).toHaveLength(2);
  });

  it('2.100 dòng khớp mới hơn khoảng ngày lọc vẫn trả đúng dòng cũ (hồi quy searchIds)', async () => {
    const old = row({ branchIds: [branchA], reason: 'huỷ hàng hỏng', createdAt: new Date('2026-01-10T05:00:00Z') });
    const newer = Array.from({ length: 2100 }, (_, i) =>
      row({
        branchIds: [branchA],
        reason: 'huỷ hàng hỏng',
        createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i % 60, i)),
      }),
    );
    await prisma.auditLog.createMany({ data: [old, ...newer] });
    const res = await service.list(
      q({ search: 'huy hang', fromDate: '2026-01-01', toDate: '2026-01-31' }),
      asActor(AuthRole.ADMIN, null),
    );
    expect(res.items.map((r) => r.id)).toEqual([old.id]);
  });

  it('search phân trang bằng cursor, không trùng không sót', async () => {
    await prisma.auditLog.createMany({
      data: Array.from({ length: 5 }, (_, i) =>
        row({ branchIds: [branchA], reason: 'huỷ đơn', createdAt: new Date(Date.UTC(2026, 0, 10, 1, i)) }),
      ),
    });
    const base = { search: 'huy don', fromDate: '2026-01-01', toDate: '2026-01-31', limit: 2 };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await service.list(q({ ...base, cursor }), asActor(AuthRole.ADMIN, null));
      seen.push(...page.items.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('detail và entity history tôn trọng phạm vi', async () => {
    const own = row({ branchIds: [branchA] });
    const other = row({ branchIds: [branchB] });
    await prisma.auditLog.createMany({ data: [own, other] });
    const pm = asActor(AuthRole.PHARMACY_MANAGER, branchA);
    expect((await service.get(own.id, pm)).id).toBe(own.id);
    await expect(service.get(other.id, pm)).rejects.toMatchObject({ status: 404 });
    expect((await service.get(other.id, asActor(AuthRole.ADMIN, null))).id).toBe(other.id);
    const hist = await service.listByEntity('price_books', other.entityId, q(), asActor(AuthRole.ADMIN, null));
    expect(hist.items.map((r) => r.id)).toEqual([other.id]);
    expect((await service.listByEntity('price_books', other.entityId, q(), pm)).items).toHaveLength(0);
  });
});
