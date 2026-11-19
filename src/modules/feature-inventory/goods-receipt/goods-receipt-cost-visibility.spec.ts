import { AuthRole } from 'src/common/types/common.enum';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { GoodsReceiptService } from './goods-receipt.service';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const actor = (role: AuthRole): RequestActor => ({
  user: { userId: 'u', sid: 's', email: null, role, branchId: BRANCH_A, roleLevel: 40 },
  ip: null,
  userAgent: null,
  requestId: null,
});

const detailRow = {
  id: 'r1',
  code: 'PN1',
  status: 'CONFIRMED',
  subtotalAmount: 100n,
  discountAmount: 10n,
  discountPercent: 5,
  vatAmount: 3n,
  supplierExpenseAmount: 2n,
  otherExpenseAmount: 1n,
  totalAmount: 96n,
  paidAmount: 50n,
  paymentStatus: 'PARTIAL',
  paymentMethod: 'CASH',
  expenses: [{ code: 'VC', amount: 2 }],
  supplier: { id: 's', code: 'S1', name: 'NCC' },
  items: [{ id: 'i1', quantity: 4, batchNumber: 'L1', importPrice: 25, unitDiscount: 1, totalPrice: 96n }],
};
const pageRow = { ...detailRow, items: undefined, totalQuantity: 4 };

const orderOf = (fn: jest.Mock) => (fn.mock.calls[0] as unknown[])[3];

function build(granted: string[]) {
  const receipts = {
    findDetail: jest.fn().mockResolvedValue(detailRow),
    findPage: jest.fn().mockResolvedValue({
      hits: [pageRow],
      summary: { totalAmount: 96n, subtotalAmount: 100n, discountAmount: 10n, paidAmount: 50n, totalQuantity: 4 },
      total: 1,
      page: 1,
      totalPages: 1,
      limit: 10,
    }),
  };
  const permissions = { getGrantedCodes: jest.fn().mockResolvedValue(new Set(granted)) };
  const service = new GoodsReceiptService(
    receipts as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    permissions as never,
  );
  return { service, receipts };
}

describe('GoodsReceiptService — ẩn tiền với người không thấy giá vốn (K8)', () => {
  const STAFF_GRANTS = ['goods-receipt:read', 'stock:read'];

  it('danh sách: nhân viên bán hàng → mọi cột tiền và summary tiền = null, số lượng / NCC / trạng thái giữ', async () => {
    const { service } = build(STAFF_GRANTS);
    const page = await service.list({ page: 1, limit: 10 } as never, actor(AuthRole.SALES_STAFF));
    expect(page.hits[0]).toMatchObject({
      code: 'PN1',
      status: 'CONFIRMED',
      totalQuantity: 4,
      paymentMethod: 'CASH',
      supplier: { name: 'NCC' },
      subtotalAmount: null,
      discountAmount: null,
      discountPercent: null,
      vatAmount: null,
      supplierExpenseAmount: null,
      otherExpenseAmount: null,
      totalAmount: null,
      paidAmount: null,
      paymentStatus: 'PARTIAL',
    });
    expect(page.summary).toEqual({
      totalAmount: null,
      subtotalAmount: null,
      discountAmount: null,
      paidAmount: null,
      totalQuantity: 4,
    });
  });

  it('danh sách: nhân viên sắp theo totalAmount bị bỏ qua (dùng mặc định), người thấy giá vốn thì sắp được', async () => {
    const staff = build(STAFF_GRANTS);
    await staff.service.list({ page: 1, limit: 10, sort: 'totalAmount:asc' } as never, actor(AuthRole.SALES_STAFF));
    expect(orderOf(staff.receipts.findPage)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);

    const pm = build(['goods-receipt:create']);
    await pm.service.list({ page: 1, limit: 10, sort: 'totalAmount:asc' } as never, actor(AuthRole.PHARMACY_MANAGER));
    expect(orderOf(pm.receipts.findPage)).toEqual([{ totalAmount: 'asc' }, { id: 'desc' }]);
  });

  it('chi tiết: nhân viên → giá nhập, chiết khấu, thành tiền, chi phí, tổng, đã trả = null; lô / số lượng giữ', async () => {
    const { service } = build(STAFF_GRANTS);
    const detail = await service.getDetail('r1', actor(AuthRole.SALES_STAFF));
    expect(detail).toMatchObject({ totalAmount: null, paidAmount: null, expenses: [], paymentStatus: 'PARTIAL' });
    expect(detail.items[0]).toEqual({
      id: 'i1',
      quantity: 4,
      batchNumber: 'L1',
      importPrice: null,
      unitDiscount: null,
      totalPrice: null,
    });
  });

  it('người có goods-receipt:create hoặc price-book:update, và SUPER_ADMIN: thấy đủ tiền', async () => {
    for (const [granted, role] of [
      [['goods-receipt:create'], AuthRole.PHARMACY_MANAGER],
      [['price-book:update'], AuthRole.ADMIN],
      [[], AuthRole.SUPER_ADMIN],
    ] as const) {
      const { service } = build([...granted]);
      const detail = await service.getDetail('r1', actor(role));
      expect(detail).toMatchObject({ totalAmount: 96n, paidAmount: 50n });
      expect(detail.items[0]).toMatchObject({ importPrice: 25, totalPrice: 96n });
      expect((await service.list({ page: 1, limit: 10 } as never, actor(role))).summary.totalAmount).toBe(96n);
    }
  });
});
