import { PriceBookPolicy, RecordStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { ADMIN_ACTOR, actorOf, entriesOf } from 'src/test-support/audit-harness';
import { PriceBookItemsService } from './price-book-items.service';
import type { PriceBookRow } from './repositories/price-book.repository';

const TX = { marker: 'tx' };

function book(over: Partial<PriceBookRow> = {}): PriceBookRow {
  return {
    id: 'book-1',
    name: 'Giá sỉ',
    startAt: new Date('2026-10-01T00:00:00Z'),
    endAt: null,
    status: RecordStatus.ACTIVE,
    outOfBookPolicy: PriceBookPolicy.ALLOW,
    formulaBase: 'general',
    formulaOp: '-',
    formulaAmount: '10',
    formulaUnit: '%',
    branches: [{ branchId: 'b1' }, { branchId: 'b2' }],
    users: [],
    ...over,
  } as unknown as PriceBookRow;
}

const audit = { record: jest.fn() };
beforeEach(() => audit.record.mockClear());

function makeService(bookRow: PriceBookRow = book(), rawRows: unknown[] = []) {
  const rowsRepository = {
    findProductUnit: jest.fn().mockResolvedValue({ id: 'pu-1' }),
    setItem: jest.fn().mockResolvedValue(undefined),
    findAll: jest.fn().mockResolvedValue(rawRows),
    upsertItems: jest.fn().mockResolvedValue(undefined),
    findBookPrices: jest.fn().mockResolvedValue([]),
    findItemUnitIds: jest.fn().mockResolvedValue(['pu-1']),
  };
  const bookRepository = {
    findById: jest.fn().mockResolvedValue(bookRow),
    transaction: jest.fn((work: (tx: unknown) => unknown) => work(TX)),
  };
  const service = new PriceBookItemsService(rowsRepository as never, bookRepository as never, audit as never);
  return { service, rowsRepository, bookRepository };
}

describe('PriceBookItemsService — nhật ký', () => {
  it('setItem ghi ITEMS_SET với branchIds của bảng, price bigint dạng chuỗi, cùng tx với ghi dòng giá', async () => {
    const { service, rowsRepository } = makeService();

    await service.setItem('book-1', { drugId: 'd1', unitId: 'u1', price: 125000 }, ADMIN_ACTOR);

    expect(rowsRepository.setItem).toHaveBeenCalledWith('book-1', 'pu-1', 125000, TX);
    expect((audit.record.mock.calls as unknown[][])[0][0]).toBe(TX);
    expect(entriesOf(audit)).toEqual([
      {
        event: 'PRICE_BOOK.ITEMS_SET',
        entityType: 'price_books',
        entityId: 'book-1',
        entityLabel: 'Giá sỉ',
        branchIds: ['b1', 'b2'],
        metadata: { productUnitId: 'pu-1', price: '125000' },
        amount: 125000n,
      },
    ]);
  });

  it('setItem price null (bỏ hàng khỏi bảng) ghi price null, không có amount', async () => {
    const { service } = makeService();

    await service.setItem('book-1', { drugId: 'd1', unitId: 'u1', price: null }, ADMIN_ACTOR);

    const [entry] = entriesOf(audit);
    expect(entry).toMatchObject({ event: 'PRICE_BOOK.ITEMS_SET', metadata: { productUnitId: 'pu-1', price: null } });
    expect(entry).not.toHaveProperty('amount');
  });

  it('applyFormula 300 dòng chỉ ghi 1 entry FORMULA_APPLIED với count 300', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      productUnitId: `pu-${i}`,
      generalPrice: 1000 + i,
      avgCost: 0,
      lastPurchaseCost: 0,
    }));
    const { service, rowsRepository } = makeService(book(), rows);

    await expect(service.applyFormulaToFilter('book-1', {} as never, ADMIN_ACTOR)).resolves.toEqual({ count: 300 });

    expect(rowsRepository.upsertItems).toHaveBeenCalledTimes(1);
    expect(entriesOf(audit)).toEqual([
      {
        event: 'PRICE_BOOK.FORMULA_APPLIED',
        entityType: 'price_books',
        entityId: 'book-1',
        entityLabel: 'Giá sỉ',
        branchIds: ['b1', 'b2'],
        metadata: { count: 300, formula: { base: 'general', op: '-', amount: '10', unit: '%' } },
      },
    ]);
  });

  it('applyFormula không có dòng nào khớp thì không ghi entry', async () => {
    const { service } = makeService(book(), []);

    await expect(service.applyFormulaToFilter('book-1', {} as never, ADMIN_ACTOR)).resolves.toEqual({ count: 0 });

    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('PriceBookItemsService — kiểm lại giá gốc lúc áp công thức (S2)', () => {
  const PM_A = actorOf({
    userId: 'pm-a',
    sid: 's',
    email: null,
    role: AuthRole.PHARMACY_MANAGER,
    branchId: 'bA',
    roleLevel: 60,
  });
  const rawRows = [{ productUnitId: 'pu-1' }];

  function setup(baseBranches: string[]) {
    const own = book({ id: 'book-1', formulaBase: 'base-b', branches: [{ branchId: 'bA' }] as never });
    const base = book({ id: 'base-b', branches: baseBranches.map((branchId) => ({ branchId })) as never });
    const made = makeService(own, rawRows);
    made.bookRepository.findById.mockImplementation((id: string) => Promise.resolve(id === 'book-1' ? own : base));
    return made;
  }

  it('apply-formula: base đã bị đổi phạm vi sang chỉ B → 403 1506, không ghi giá', async () => {
    const { service, rowsRepository } = setup(['bB']);
    await expect(service.applyFormulaToFilter('book-1', {} as never, PM_A)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
    expect(rowsRepository.upsertItems).not.toHaveBeenCalled();
  });

  it('apply-formula: base toàn chuỗi → áp được', async () => {
    const { service, rowsRepository } = setup([]);
    rowsRepository.findBookPrices.mockResolvedValue([{ productUnitId: 'pu-1', price: 1000 }]);
    await expect(service.applyFormulaToFilter('book-1', {} as never, PM_A)).resolves.toEqual({ count: 1 });
  });

  it('reapplyExisting: base ngoài phạm vi đọc → 403, không ghi giá', async () => {
    const { service, rowsRepository } = setup(['bB']);
    const own = book({ id: 'book-1', formulaBase: 'base-b', branches: [{ branchId: 'bA' }] as never });
    await expect(
      service.reapplyExisting({} as never, own, undefined, { kind: 'BRANCH', branchId: 'bA' }),
    ).rejects.toMatchObject({ response: { code: ErrorCode.BRANCH_ACCESS_DENIED } });
    expect(rowsRepository.upsertItems).not.toHaveBeenCalled();
  });
});
