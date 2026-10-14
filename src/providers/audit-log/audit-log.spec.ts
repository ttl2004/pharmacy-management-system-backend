import { AuditAction, Prisma } from '@prisma/client';
import { diffFields, pickAuditFields, toAuditJson } from './audit-diff';
import { AuditLogService } from './audit-log.service';

describe('toAuditJson', () => {
  it('Date → ISO, bigint → chuỗi, undefined → null, đi sâu vào object và mảng', () => {
    expect(
      toAuditJson({ at: new Date('2026-10-14T00:00:00.000Z'), total: 12n, missing: undefined, list: [1n] }),
    ).toEqual({ at: '2026-10-14T00:00:00.000Z', total: '12', missing: null, list: ['1'] });
  });
});

describe('diffFields', () => {
  const before = { name: 'NCC A', phone: '0900', status: 'ACTIVE', updatedAt: null as Date | null };

  it('chỉ giữ trường thực sự đổi', () => {
    expect(diffFields(before, { name: 'NCC B', phone: '0900' }, ['name', 'phone', 'status'])).toEqual({
      before: { name: 'NCC A' },
      after: { name: 'NCC B' },
    });
  });

  it('trường không nằm trong danh sách theo dõi thì bỏ qua (updatedAt)', () => {
    expect(diffFields(before, { updatedAt: new Date() }, ['name'])).toBeNull();
  });

  it('không có gì đổi thì trả null để caller không ghi dòng rỗng', () => {
    expect(diffFields(before, { status: 'ACTIVE' }, ['status'])).toBeNull();
  });
});

describe('pickAuditFields', () => {
  it('chụp đúng tập trường, chuẩn hoá kiểu', () => {
    expect(pickAuditFields({ code: 'PN000001', totalAmount: 5n, note: null }, ['code', 'totalAmount'])).toEqual({
      code: 'PN000001',
      totalAmount: '5',
    });
  });
});

describe('AuditLogService.record', () => {
  it('ghi cả lô bằng một câu createMany, before/after rỗng thành DbNull', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 2 });
    const tx = { auditLog: { createMany } } as unknown as Prisma.TransactionClient;

    await new AuditLogService().record(tx, [
      { actorId: 'u1', action: AuditAction.CREATE, entityType: 'suppliers', entityId: 's1', after: { code: 'NCC1' } },
      { actorId: 'u1', action: AuditAction.DELETE, entityType: 'suppliers', entityId: 's2', ipAddress: '1.2.3.4' },
    ]);

    expect(createMany).toHaveBeenCalledTimes(1);
    const [{ data }] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(data[0]).toMatchObject({ before: Prisma.DbNull, after: { code: 'NCC1' }, branchId: null });
    expect(data[1]).toMatchObject({ before: Prisma.DbNull, after: Prisma.DbNull, ipAddress: '1.2.3.4' });
  });

  it('không có entry thì không gọi DB', async () => {
    const createMany = jest.fn();
    await new AuditLogService().record({ auditLog: { createMany } } as never, []);
    expect(createMany).not.toHaveBeenCalled();
  });
});
