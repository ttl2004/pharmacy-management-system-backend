import { AuthRole } from 'src/common/types/common.enum';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { SupplierListService } from './supplier-list.service';

const actor = (role: AuthRole): RequestActor => ({
  user: {
    userId: 'u1',
    sid: 's',
    email: null,
    role,
    branchId: role === AuthRole.SALES_STAFF ? 'b1' : null,
    roleLevel: 60,
  },
  ip: null,
  userAgent: null,
  requestId: null,
});

const SUPPLIER = {
  id: 's1',
  code: 'NCC001',
  name: 'Dược TW1',
  phone: '0901234567',
  email: 'ncc@example.com',
  taxCode: '0101234567',
  idNumber: '012345678901',
};

function makeService(granted: string[]) {
  const totals = {
    findPage: jest.fn().mockResolvedValue({
      rows: [{ id: 's1', totalPurchase: 10, currentDebt: 5 }],
      total: 1,
      summary: { totalPurchase: 10, currentDebt: 5 },
    }),
  };
  const suppliers = { findManyByIds: jest.fn().mockResolvedValue([SUPPLIER]) };
  const permissions = { getGrantedCodes: jest.fn().mockResolvedValue(new Set(granted)) };
  const service = new SupplierListService(totals as never, suppliers as never, permissions as never);
  return { service, totals };
}

const QUERY = { page: 1, limit: 20, search: '0101', sort: 'taxCode:asc' } as never;

describe('SupplierListService — dữ liệu định danh (N6)', () => {
  it('không có supplier:update: idNumber/email = null, mã số thuế (công khai) vẫn thấy', async () => {
    const { service, totals } = makeService(['supplier:read']);
    const list = await service.list(QUERY, actor(AuthRole.SALES_STAFF));
    expect(list.hits[0]).toMatchObject({ idNumber: null, email: null, taxCode: '0101234567', name: 'Dược TW1' });
    expect(totals.findPage).toHaveBeenCalledWith(expect.objectContaining({ canSeeSensitive: false }));

    const detail = await service.getDetail('s1', actor(AuthRole.SALES_STAFF));
    expect(detail).toMatchObject({ idNumber: null, email: null, taxCode: '0101234567' });
  });

  it('có supplier:update: thấy đủ; SUPER_ADMIN luôn thấy đủ', async () => {
    const withUpdate = makeService(['supplier:read', 'supplier:update']);
    expect((await withUpdate.service.list(QUERY, actor(AuthRole.ADMIN))).hits[0]).toMatchObject({
      idNumber: '012345678901',
      email: 'ncc@example.com',
      taxCode: '0101234567',
    });
    const root = makeService([]);
    expect((await root.service.getDetail('s1', actor(AuthRole.SUPER_ADMIN))).idNumber).toBe('012345678901');
  });
});

describe('SupplierListService — ẩn tổng mua với người không thấy giá vốn (K8)', () => {
  it('nhân viên bán hàng: totalPurchase = null, bỏ lọc/sắp theo tổng mua; PM có goods-receipt:create thấy', async () => {
    const staff = makeService(['supplier:read']);
    const query = { page: 1, limit: 20, purchaseMin: 1, purchaseMax: 9, sort: 'totalPurchase:desc' } as never;
    const list = await staff.service.list(query, actor(AuthRole.SALES_STAFF));
    expect(list.hits[0].totalPurchase).toBeNull();
    expect(list.summary.totalPurchase).toBeNull();
    expect(staff.totals.findPage).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseMin: undefined, purchaseMax: undefined, sort: undefined }),
    );
    expect((await staff.service.getDetail('s1', actor(AuthRole.SALES_STAFF))).totalPurchase).toBeNull();

    const pm = makeService(['supplier:read', 'goods-receipt:create']);
    const full = await pm.service.list(query, actor(AuthRole.ADMIN));
    expect(full.hits[0].totalPurchase).toBe(10);
    expect(full.summary.totalPurchase).toBe(10);
    expect(pm.totals.findPage).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseMin: 1, purchaseMax: 9, sort: 'totalPurchase:desc' }),
    );
  });
});
