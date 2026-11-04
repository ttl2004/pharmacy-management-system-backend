import { PriceBookPolicy, RecordStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { PriceBookService } from './price-book.service';
import type { PriceBookRow } from './repositories/price-book.repository';

const ADMIN: RequestActor = {
  user: { userId: 'admin-1', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

const TX = { marker: 'tx' };

function bookRow(overrides: Partial<PriceBookRow> & { branchIds?: string[] } = {}): PriceBookRow {
  const { branchIds = ['b1'], ...rest } = overrides;
  return {
    id: 'book-1',
    name: 'Giá sỉ',
    startAt: new Date('2026-10-01T00:00:00Z'),
    endAt: new Date('2026-10-31T00:00:00Z'),
    status: RecordStatus.ACTIVE,
    outOfBookPolicy: PriceBookPolicy.ALLOW,
    formulaBase: null,
    formulaOp: null,
    formulaAmount: null,
    formulaUnit: null,
    branches: branchIds.map((branchId) => ({ branchId })),
    users: [],
    _count: { items: 0 },
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...rest,
  } as PriceBookRow;
}

const request = (overrides: Record<string, unknown> = {}) =>
  ({
    name: 'Giá sỉ',
    startAt: '2026-10-01T00:00:00Z',
    endAt: '2026-10-31T00:00:00Z',
    status: 'active',
    branchIds: ['b1'],
    userIds: [],
    outOfBookPolicy: 'allow',
    ...overrides,
  }) as never;

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    transaction: jest.fn().mockImplementation((work: (tx: unknown) => unknown) => work(TX)),
    findById: jest.fn().mockResolvedValue(bookRow()),
    findNameConflict: jest.fn().mockResolvedValue(null),
    countBranches: jest.fn().mockImplementation((ids: string[]) => Promise.resolve(ids.length)),
    findUsers: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue(bookRow()),
    update: jest.fn().mockResolvedValue(bookRow()),
    findDependents: jest.fn().mockResolvedValue([]),
    clearFormula: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    ...repositoryOverrides,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const items = { reapplyExisting: jest.fn() };
  return { service: new PriceBookService(repository as never, audit as never, items as never), repository, audit };
}

function entriesOf(audit: { record: jest.Mock }): Record<string, unknown>[] {
  expect(audit.record).toHaveBeenCalledTimes(1);
  return (audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]])[2];
}

describe('PriceBookService — nhật ký', () => {
  it('tạo ghi PRICE_BOOK.CREATED, branchIds = chi nhánh của bảng, nhãn = tên', async () => {
    const { service, audit, repository } = makeService({
      create: jest.fn().mockResolvedValue(bookRow({ branchIds: ['b1', 'b2'] })),
    });

    await service.create(request({ branchIds: ['b1', 'b2'] }), ADMIN);

    expect(repository.create).toHaveBeenCalledWith(TX, expect.anything(), 'admin-1');
    const [tx, actor] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(tx).toBe(TX);
    expect(actor).toMatchObject({ userId: 'admin-1', type: 'USER', ip: '10.0.0.1', requestId: 'req-1' });
    expect(entriesOf(audit)).toEqual([
      expect.objectContaining({
        event: 'PRICE_BOOK.CREATED',
        entityType: 'price_books',
        entityId: 'book-1',
        entityLabel: 'Giá sỉ',
        branchIds: ['b1', 'b2'],
      }),
    ]);
  });

  it('bảng áp toàn chuỗi → branchIds []', async () => {
    const { service, audit } = makeService({ create: jest.fn().mockResolvedValue(bookRow({ branchIds: [] })) });

    await service.create(request({ branchIds: [] }), ADMIN);

    expect(entriesOf(audit)[0]).toMatchObject({ event: 'PRICE_BOOK.CREATED', branchIds: [] });
  });

  it('PRICE_BOOK.UPDATED branchIds là hợp của chi nhánh trước và sau', async () => {
    const { service, audit } = makeService({
      findById: jest.fn().mockResolvedValue(bookRow({ branchIds: ['b1', 'b2'] })),
      update: jest.fn().mockResolvedValue(bookRow({ branchIds: ['b2', 'b3'], name: 'Giá sỉ mới' })),
    });

    await service.update('book-1', request({ branchIds: ['b2', 'b3'], name: 'Giá sỉ mới' }), ADMIN);

    const [entry] = entriesOf(audit);
    expect(entry).toMatchObject({
      event: 'PRICE_BOOK.UPDATED',
      entityType: 'price_books',
      entityId: 'book-1',
      entityLabel: 'Giá sỉ mới',
      before: { name: 'Giá sỉ', branchIds: ['b1', 'b2'] },
      after: { name: 'Giá sỉ mới', branchIds: ['b2', 'b3'] },
    });
    expect([...(entry.branchIds as string[])].sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('sửa từ toàn chuỗi sang một chi nhánh → branchIds là hợp thuần [b1]', async () => {
    const { service, audit } = makeService({
      findById: jest.fn().mockResolvedValue(bookRow({ branchIds: [] })),
      update: jest.fn().mockResolvedValue(bookRow({ branchIds: ['b1'] })),
    });

    await service.update('book-1', request(), ADMIN);

    expect(entriesOf(audit)[0]).toMatchObject({ event: 'PRICE_BOOK.UPDATED', branchIds: ['b1'] });
  });

  it('sửa từ một chi nhánh sang toàn chuỗi → branchIds là hợp thuần [b1]', async () => {
    const { service, audit } = makeService({
      findById: jest.fn().mockResolvedValue(bookRow({ branchIds: ['b1'] })),
      update: jest.fn().mockResolvedValue(bookRow({ branchIds: [] })),
    });

    await service.update('book-1', request({ branchIds: [] }), ADMIN);

    expect(entriesOf(audit)[0]).toMatchObject({ event: 'PRICE_BOOK.UPDATED', branchIds: ['b1'] });
  });

  it('toàn chuỗi → toàn chuỗi → branchIds []', async () => {
    const { service, audit } = makeService({
      findById: jest.fn().mockResolvedValue(bookRow({ branchIds: [] })),
      update: jest.fn().mockResolvedValue(bookRow({ branchIds: [], name: 'Giá sỉ mới' })),
    });

    await service.update('book-1', request({ branchIds: [], name: 'Giá sỉ mới' }), ADMIN);

    expect(entriesOf(audit)[0]).toMatchObject({ event: 'PRICE_BOOK.UPDATED', branchIds: [] });
  });

  it('chỉ đổi trạng thái ghi PRICE_BOOK.STATUS_CHANGED', async () => {
    const { service, audit } = makeService({
      update: jest.fn().mockResolvedValue(bookRow({ status: RecordStatus.INACTIVE })),
    });

    await service.update('book-1', request({ status: 'inactive' }), ADMIN);

    expect(entriesOf(audit)).toEqual([
      expect.objectContaining({
        event: 'PRICE_BOOK.STATUS_CHANGED',
        branchIds: ['b1'],
        before: { status: 'ACTIVE' },
        after: { status: 'INACTIVE' },
      }),
    ]);
  });

  it('sửa không đổi gì thì không ghi', async () => {
    const { service, audit } = makeService();
    await service.update('book-1', request(), ADMIN);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('xoá ghi PRICE_BOOK.DELETED + PRICE_BOOK.FORMULA_CLEARED cho từng bảng phụ thuộc, 1 lần record', async () => {
    const dependent = bookRow({
      id: 'book-2',
      name: 'Giá lẻ',
      branchIds: ['b2'],
      formulaBase: 'book-1',
      formulaOp: 'ADD' as never,
      formulaAmount: 1000 as never,
      formulaUnit: 'VND' as never,
    });
    const { service, audit } = makeService({ findDependents: jest.fn().mockResolvedValue([dependent]) });

    await service.remove('book-1', ADMIN);

    const entries = entriesOf(audit);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      event: 'PRICE_BOOK.DELETED',
      entityId: 'book-1',
      entityLabel: 'Giá sỉ',
      branchIds: ['b1'],
      before: expect.objectContaining({ name: 'Giá sỉ' }) as unknown,
    });
    expect(entries[1]).toMatchObject({
      event: 'PRICE_BOOK.FORMULA_CLEARED',
      entityId: 'book-2',
      entityLabel: 'Giá lẻ',
      branchIds: ['b2'],
      before: { formulaBase: 'book-1', formulaOp: 'ADD', formulaAmount: 1000, formulaUnit: 'VND' },
      after: { formulaBase: null, formulaOp: null, formulaAmount: null, formulaUnit: null },
    });
  });
});
