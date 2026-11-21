import { AdjustmentType } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AdjustmentService } from './adjustment.service';

const actor = (role: AuthRole): RequestActor => ({
  user: { userId: 'u', sid: 's', email: null, role, branchId: '11111111-1111-4111-8111-111111111111', roleLevel: 40 },
  ip: null,
  userAgent: null,
  requestId: null,
});

const header = {
  id: 'a1',
  code: 'THN1',
  type: 'RETURN_TO_SUPPLIER',
  goodsAmount: 100n,
  discountAmount: 5n,
  discountPercent: 5,
  refundExpenseAmount: 1n,
  totalAmount: 96n,
  supplierPaid: 40n,
  paymentMethod: 'CASH',
};
const detailRow = {
  ...header,
  refundExpenses: [{ code: 'VC' }],
  items: [{ id: 'i1', quantity: -3, unitCost: 700, returnPrice: 800, product: { name: 'P' } }],
};
const SUMMARY = {
  goodsAmount: 100n,
  discount: 5n,
  refundExpense: 1n,
  totalAmount: 96n,
  supplierPaid: 40n,
  totalQty: 3,
};

function build(granted: string[]) {
  const adjustments = {
    findPage: jest.fn().mockResolvedValue({ hits: [header], total: 1, page: 1, totalPages: 1, limit: 10 }),
    findDetail: jest.fn().mockResolvedValue(detailRow),
    returnSummary: jest.fn().mockResolvedValue(SUMMARY),
    itemTotals: jest.fn().mockResolvedValue(new Map([['a1', { quantity: 3, value: 2100 }]])),
  };
  const permissions = { getGrantedCodes: jest.fn().mockResolvedValue(new Set(granted)) };
  const none = {} as never;
  const service = new AdjustmentService(adjustments as never, none, none, none, none, none, none, permissions as never);
  return { service, adjustments };
}

describe('AdjustmentService — ẩn tiền với người không thấy giá vốn (K8)', () => {
  const STAFF = ['stock-adjustment:read'];

  it('danh sách trả NCC: cột tiền + summary tiền = null, số lượng giữ', async () => {
    const { service, adjustments } = build(STAFF);
    const page = await service.list(
      { page: 1, limit: 10, type: AdjustmentType.RETURN_TO_SUPPLIER } as never,
      actor(AuthRole.SALES_STAFF),
    );
    expect(page.hits[0]).toMatchObject({
      code: 'THN1',
      paymentMethod: 'CASH',
      goodsAmount: null,
      discountAmount: null,
      discountPercent: null,
      refundExpenseAmount: null,
      totalAmount: null,
      supplierPaid: null,
    });
    expect(page).toMatchObject({
      summary: { goodsAmount: null, discount: null, refundExpense: null, totalAmount: null, supplierPaid: null },
    });
    expect(adjustments.returnSummary).not.toHaveBeenCalled();
  });

  it('danh sách: totalQuantity luôn có; totalValue null khi bị ẩn giá vốn', async () => {
    const { service, adjustments } = build(STAFF);
    const page = await service.list({ page: 1, limit: 10 } as never, actor(AuthRole.SALES_STAFF));
    expect(page.hits[0]).toMatchObject({ totalQuantity: 3, totalValue: null });
    expect(adjustments.itemTotals).toHaveBeenCalledWith(['a1']);
  });

  it('danh sách: loại khác trả NCC lấy Σ SL × giá vốn; trả NCC lấy tổng tiền phiếu; phiếu không dòng = 0', async () => {
    const { service, adjustments } = build(['goods-receipt:create']);
    adjustments.findPage.mockResolvedValue({
      hits: [
        { ...header, id: 'a1', type: 'DISPOSE' },
        { ...header, id: 'a2', type: 'RETURN_TO_SUPPLIER' },
        { ...header, id: 'a3', type: 'DISPOSE' },
      ],
      total: 3,
      page: 1,
      totalPages: 1,
      limit: 10,
    });
    adjustments.itemTotals.mockResolvedValue(
      new Map([
        ['a1', { quantity: 3, value: 2100 }],
        ['a2', { quantity: 5, value: 9999 }],
      ]),
    );
    const page = await service.list({ page: 1, limit: 10 } as never, actor(AuthRole.PHARMACY_MANAGER));
    expect(page.hits.map((h) => [h.totalQuantity, h.totalValue])).toEqual([
      [3, 2100],
      [5, 96],
      [0, 0],
    ]);
  });

  describe('danh sách: số liệu giữ dấu của phiếu kiểm kê', () => {
    const stats = {
      quantity: 10,
      value: 4000,
      lineCount: 2,
      totalActual: 37,
      diffUp: 5,
      diffDown: 5,
      diffUpValue: 1500,
      diffDownValue: 2500,
    };
    const prime = (adjustments: ReturnType<typeof build>['adjustments']) => {
      adjustments.findPage.mockResolvedValue({
        hits: [
          { ...header, id: 'a1', type: 'STOCK_TAKE' },
          { ...header, id: 'a2', type: 'DISPOSE' },
          { ...header, id: 'a3', type: 'STOCK_TAKE' },
        ],
        total: 3,
        page: 1,
        totalPages: 1,
        limit: 10,
      });
      adjustments.itemTotals.mockResolvedValue(
        new Map([
          ['a1', stats],
          ['a2', stats],
        ]),
      );
    };

    it('chỉ dòng KIỂM KÊ có 6 trường mới; loại khác không có khoá; kiểm kê không dòng = 0', async () => {
      const { service, adjustments } = build(['goods-receipt:create']);
      prime(adjustments);
      const page = await service.list({ page: 1, limit: 10 } as never, actor(AuthRole.PHARMACY_MANAGER));
      const [take, other, empty] = page.hits as Record<string, unknown>[];
      expect(take).toMatchObject({
        totalQuantity: 10,
        totalValue: 4000,
        lineCount: 2,
        totalActual: 37,
        diffUp: 5,
        diffDown: 5,
        diffUpValue: 1500,
        diffDownValue: 2500,
      });
      for (const key of ['lineCount', 'totalActual', 'diffUp', 'diffDown', 'diffUpValue', 'diffDownValue']) {
        expect(other).not.toHaveProperty(key);
      }
      expect(empty).toMatchObject({
        lineCount: 0,
        totalActual: 0,
        diffUp: 0,
        diffDown: 0,
        diffUpValue: 0,
        diffDownValue: 0,
      });
    });

    it('không có quyền xem giá vốn: giá trị = null, số lượng giữ', async () => {
      const { service, adjustments } = build(STAFF);
      prime(adjustments);
      const page = await service.list({ page: 1, limit: 10 } as never, actor(AuthRole.SALES_STAFF));
      expect(page.hits[0]).toMatchObject({
        lineCount: 2,
        totalActual: 37,
        diffUp: 5,
        diffDown: 5,
        diffUpValue: null,
        diffDownValue: null,
      });
      expect(page.hits[2]).toMatchObject({ diffUp: 0, diffUpValue: null, diffDownValue: null });
    });
  });

  it('chi tiết: giá vốn dòng, giá trả, chi phí hoàn = null; số lượng giữ', async () => {
    const { service } = build(STAFF);
    const detail = await service.getDetail('a1', actor(AuthRole.SALES_STAFF));
    expect(detail).toMatchObject({ totalAmount: null, supplierPaid: null, refundExpenses: [] });
    expect(detail.items[0]).toMatchObject({ quantity: -3, unitCost: null, returnPrice: null });
  });

  it('có goods-receipt:create / SUPER_ADMIN: thấy đủ', async () => {
    for (const [granted, role] of [
      [['goods-receipt:create'], AuthRole.PHARMACY_MANAGER],
      [[], AuthRole.SUPER_ADMIN],
    ] as const) {
      const { service } = build([...granted]);
      const detail = await service.getDetail('a1', actor(role));
      expect(detail.items[0]).toMatchObject({ unitCost: 700, returnPrice: 800 });
      const page = await service.list(
        { page: 1, limit: 10, type: AdjustmentType.RETURN_TO_SUPPLIER } as never,
        actor(role),
      );
      expect(page).toMatchObject({ summary: SUMMARY, hits: [{ totalAmount: 96n }] });
    }
  });
});
