import { Prisma } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import type { AuditActor } from './audit-actor';
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

const ACTOR: AuditActor = {
  userId: 'u1',
  type: 'USER',
  roleCode: 'PHARMACY_MANAGER',
  branchId: 'b0',
  ip: '1.2.3.4',
  requestId: '0190f5a0-0000-7000-8000-000000000001',
};

function setup() {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const tx = { auditLog: { createMany } } as unknown as Prisma.TransactionClient;
  const rows = () => (createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }])[0].data;
  return { createMany, tx, rows };
}

describe('AuditLogService.record', () => {
  const service = new AuditLogService();

  it('ghi 1 createMany cho nhiều entry', async () => {
    const { createMany, tx, rows } = setup();
    await service.record(tx, ACTOR, [
      { event: 'SUPPLIER.CREATED', entityType: 'suppliers', entityId: 's1', branchIds: [], after: { code: 'NCC1' } },
      { event: 'SUPPLIER.DELETED', entityType: 'suppliers', entityId: 's2', branchIds: [] },
    ]);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ before: Prisma.DbNull, after: { code: 'NCC1' }, metadata: Prisma.DbNull });
    expect(rows()[1]).toMatchObject({ after: Prisma.DbNull });
  });

  it('suy action, severity từ danh mục: ORDER.VOID_PAID → STATUS_CHANGE, 2', async () => {
    const { tx, rows } = setup();
    await service.record(tx, ACTOR, [
      { event: 'ORDER.VOID_PAID', entityType: 'orders', entityId: 'o1', branchIds: ['b1'], reason: 'Nhầm đơn' },
    ]);
    expect(rows()[0]).toMatchObject({ event: 'ORDER.VOID_PAID', action: 'STATUS_CHANGE', severity: 2 });
  });

  it('severity của entry chỉ được nâng, không hạ: DISPOSAL.CONFIRMED với severity 0 vẫn lưu 1', async () => {
    const { tx, rows } = setup();
    await service.record(tx, ACTOR, [
      { event: 'DISPOSAL.CONFIRMED', entityType: 'a', entityId: 'x', branchIds: [], reason: 'Hết hạn', severity: 0 },
      { event: 'STOCK_ADJUSTMENT.CONFIRMED', entityType: 'a', entityId: 'y', branchIds: [], severity: 1 },
    ]);
    expect(rows()[0].severity).toBe(1);
    expect(rows()[1].severity).toBe(1);
  });

  it('throw ErrorException 1002 khi event reasonRequired mà reason rỗng hoặc chỉ khoảng trắng', async () => {
    const { createMany, tx } = setup();
    const entry = { event: 'TRANSFER.SHIPPED', entityType: 't', entityId: 'x', branchIds: [], reason: '  ' } as const;
    const err = await service.record(tx, ACTOR, [entry]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrorException);
    expect((err as ErrorException).errorCode).toBe(ErrorCode.HTTP_BAD_REQUEST);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('bigint trong after/metadata lưu thành chuỗi; amount giữ bigint', async () => {
    const { tx, rows } = setup();
    await service.record(tx, ACTOR, [
      {
        event: 'ORDER.PAID',
        entityType: 'orders',
        entityId: 'o1',
        branchIds: ['b1'],
        after: { total: 12n } as never,
        metadata: { n: 5n } as never,
        amount: 9007199254740993n,
      },
    ]);
    expect(rows()[0]).toMatchObject({ after: { total: '12' }, metadata: { n: '5' }, amount: 9007199254740993n });
  });

  it('requestId không phải UUID thì lưu null', async () => {
    const { tx, rows } = setup();
    await service.record(tx, { ...ACTOR, requestId: 'req-1' }, [
      { event: 'ORDER.PAID', entityType: 'o', entityId: 'x', branchIds: [] },
    ]);
    expect(rows()[0].requestId).toBeNull();
  });

  it('branchId cũ = branchIds[0] khi đúng 1 phần tử, ngược lại null', async () => {
    const { tx, rows } = setup();
    const base = { event: 'ORDER.PAID', entityType: 'o', entityId: 'x' } as const;
    await service.record(tx, ACTOR, [
      { ...base, branchIds: ['b1'] },
      { ...base, branchIds: ['b1', 'b2'] },
      { ...base, branchIds: [] },
    ]);
    expect(rows().map((r) => r.branchId)).toEqual(['b1', null, null]);
    expect(rows()[1].branchIds).toEqual(['b1', 'b2']);
  });

  it('đặt searchText = foldVn(entityLabel + reason + searchTerms), cắt 500 ký tự', async () => {
    const { tx, rows } = setup();
    await service.record(tx, ACTOR, [
      {
        event: 'DISPOSAL.CREATED',
        entityType: 'a',
        entityId: 'x',
        branchIds: [],
        entityLabel: 'XH000001',
        reason: 'Thuốc Hết Hạn Đặc Biệt',
        searchTerms: ['Nguyễn Văn Á'],
      },
      { event: 'ORDER.PAID', entityType: 'o', entityId: 'y', branchIds: [], entityLabel: 'a'.repeat(900) },
      { event: 'ORDER.PAID', entityType: 'o', entityId: 'z', branchIds: [] },
    ]);
    expect(rows()[0].searchText).toBe('xh000001 thuoc het han dac biet nguyen van a');
    expect((rows()[1].searchText as string).length).toBe(500);
    expect(rows()[2].searchText).toBe('');
  });

  it('actor ghi một lần cho mọi entry: actorId, actorType, actorRoleCode, actorBranchId, ipAddress, requestId', async () => {
    const { tx, rows } = setup();
    await service.record(tx, ACTOR, [
      { event: 'ORDER.PAID', entityType: 'o', entityId: 'x', branchIds: [] },
      { event: 'ORDER.CREATED', entityType: 'o', entityId: 'y', branchIds: [] },
    ]);
    for (const row of rows()) {
      expect(row).toMatchObject({
        actorId: 'u1',
        actorType: 'USER',
        actorRoleCode: 'PHARMACY_MANAGER',
        actorBranchId: 'b0',
        ipAddress: '1.2.3.4',
        requestId: ACTOR.requestId,
      });
    }
  });

  it('không gọi DB khi entries rỗng', async () => {
    const { createMany, tx } = setup();
    await service.record(tx, ACTOR, []);
    expect(createMany).not.toHaveBeenCalled();
  });
});
