import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { PriceBookRowsService } from './price-book-rows.service';

const ADMIN: RequestActor = {
  user: { userId: 'admin-1', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

const TX = { marker: 'tx' };

function makeService(unit: Record<string, unknown> | null) {
  const rowsRepository = {
    findProductUnit: jest.fn().mockResolvedValue(unit),
    setGeneralPrice: jest.fn().mockResolvedValue(undefined),
  };
  const bookRepository = { transaction: jest.fn().mockImplementation((work: (tx: unknown) => unknown) => work(TX)) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const permissions = { getGrantedCodes: jest.fn().mockResolvedValue(new Set<string>()) };
  const service = new PriceBookRowsService(
    rowsRepository as never,
    bookRepository as never,
    audit as never,
    permissions as never,
  );
  return { service, rowsRepository, audit, permissions };
}

describe('PriceBookRowsService — sửa giá chung', () => {
  const unit = { id: 'pu-1', salePrice: 500, product: { code: 'SP0001', name: 'Paracetamol' } };

  it('ghi PRODUCT.PRICE_CHANGED, amount = giá mới (bigint), nhãn = mã sản phẩm, branchIds []', async () => {
    const { service, rowsRepository, audit } = makeService(unit);

    await service.setGeneralPrice({ drugId: 'prod-1', unitId: 'unit-1', price: 650 }, ADMIN);

    expect(rowsRepository.setGeneralPrice).toHaveBeenCalledWith(TX, 'pu-1', 650, 'admin-1');
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [tx, actor, entries] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>, unknown[]];
    expect(tx).toBe(TX);
    expect(actor).toMatchObject({ userId: 'admin-1', ip: '10.0.0.1', requestId: 'req-1' });
    expect(entries).toEqual([
      {
        event: 'PRODUCT.PRICE_CHANGED',
        entityType: 'products',
        entityId: 'prod-1',
        entityLabel: 'SP0001',
        branchIds: [],
        before: { unitId: 'unit-1', salePrice: 500 },
        after: { unitId: 'unit-1', salePrice: 650 },
        amount: 650n,
        searchTerms: ['SP0001', 'Paracetamol'],
      },
    ]);
  });

  it('giá không đổi thì không ghi', async () => {
    const { service, audit } = makeService(unit);
    await service.setGeneralPrice({ drugId: 'prod-1', unitId: 'unit-1', price: 500 }, ADMIN);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('PriceBookRowsService — danh sách dòng giá: giá vốn và cỡ trang', () => {
  const ROW = {
    productId: 'p1',
    unitId: 'u1',
    productUnitId: 'pu1',
    code: 'SP01',
    name: 'Panadol',
    unitName: 'Hộp',
    factor: 10,
    avgCost: 3000,
    lastPurchaseCost: 3200,
    generalPrice: 4500,
  };
  const userOf = (role: AuthRole) =>
    ({
      userId: 'u',
      sid: 's',
      email: null,
      role,
      branchId: role === AuthRole.SALES_STAFF || role === AuthRole.PHARMACY_MANAGER ? 'b1' : null,
      roleLevel: 80,
    }) as never;

  function setup(granted: string[]) {
    const made = makeService(null);
    made.permissions.getGrantedCodes.mockResolvedValue(new Set(granted));
    Object.assign(made.rowsRepository, {
      findPage: jest.fn().mockResolvedValue({ items: [ROW], total: 1 }),
      findReadableBookIds: jest.fn().mockResolvedValue([]),
      findBookPrices: jest.fn().mockResolvedValue([]),
    });
    return made;
  }
  const findPageFilter = (repo: object) =>
    (repo as { findPage: jest.Mock }).findPage.mock.calls[0] as [Record<string, unknown>, number, number];

  it('nhân viên bán hàng: giá vốn và giá nhập cuối = null, giá chung vẫn thấy', async () => {
    const { service } = setup(['product:read', 'goods-receipt:read']);

    const result = await service.listRows({}, userOf(AuthRole.SALES_STAFF));

    expect(result.items[0]).toMatchObject({ avgCost: null, lastPurchaseCost: null, generalPrice: 4500 });
  });

  it('nhân viên bán hàng: lọc theo giá vốn bị bỏ qua', async () => {
    const { service, rowsRepository } = setup(['product:read']);

    await service.listRows({ priceOp: 'lt', priceCompare: 'avgCost' }, userOf(AuthRole.SALES_STAFF));

    const [filter] = findPageFilter(rowsRepository);
    expect(filter.priceOp).toBeUndefined();
    expect(filter.priceCompare).toBeUndefined();
  });

  it('quản lý (goods-receipt:create / price-book:update): thấy giá vốn và lọc được', async () => {
    const { service, rowsRepository } = setup(['product:read', 'goods-receipt:create']);

    const result = await service.listRows(
      { priceOp: 'lt', priceCompare: 'avgCost' },
      userOf(AuthRole.PHARMACY_MANAGER),
    );

    expect(result.items[0]).toMatchObject({ avgCost: 3000, lastPurchaseCost: 3200 });
    expect(findPageFilter(rowsRepository)[0]).toMatchObject({ priceOp: 'lt', priceCompare: 'avgCost' });
  });

  it('SUPER_ADMIN luôn thấy giá vốn, không tra quyền', async () => {
    const { service, permissions } = setup([]);

    const result = await service.listRows({ pageSize: 100_000 }, userOf(AuthRole.SUPER_ADMIN));

    expect(result.items[0].avgCost).toBe(3000);
    expect(permissions.getGrantedCodes).not.toHaveBeenCalled();
  });

  it('không có quyền xuất file: pageSize > 500 bị 400; 500 trở xuống vẫn được', async () => {
    const { service } = setup(['product:read']);

    await expect(service.listRows({ pageSize: 501 }, userOf(AuthRole.SALES_STAFF))).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    await expect(service.listRows({ pageSize: 500 }, userOf(AuthRole.SALES_STAFF))).resolves.toMatchObject({
      pageSize: 500,
    });
  });

  it('có price-book:update: giữ trần 100.000 để xuất file', async () => {
    const { service } = setup(['product:read', 'price-book:update']);

    await expect(service.listRows({ pageSize: 100_000 }, userOf(AuthRole.ADMIN))).resolves.toMatchObject({
      pageSize: 100_000,
    });
  });
});
