import { OrderChannel, OrderStatus, PaymentMethod, RecordStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { OrderHead, OrderRepository } from './repositories/order.repository';
import { OrderService } from './order.service';

const actorOf = (role: AuthRole, branchId: string | null): RequestActor =>
  ({ user: { userId: 'u1', role, branchId, roleLevel: 40 }, ip: '127.0.0.1' }) as unknown as RequestActor;
const ss = actorOf(AuthRole.SALES_STAFF, 'b1');
/** Tham số thứ `index` của lần gọi đầu tiên — mock.calls là `any`, ép kiểu một chỗ. */
const argOf = <T = unknown>(fn: jest.Mock, index: number): T => (fn.mock.calls[0] as unknown[])[index] as T;
const admin = actorOf(AuthRole.ADMIN, null);

const head = (overrides: Partial<OrderHead> = {}): OrderHead => ({
  id: 'o1',
  code: 'HD000001',
  branchId: 'b1',
  channel: OrderChannel.POS,
  status: OrderStatus.PENDING,
  totalAmount: 12000n,
  prescriptionCode: null,
  prescriberName: null,
  updatedAt: null,
  lineCount: 1,
  prescriptionLineCount: 0,
  ...overrides,
});

const sellable = {
  id: 'pu1',
  conversionRate: 1,
  salePrice: 1000,
  status: RecordStatus.ACTIVE,
  unit: { name: 'Viên' },
  product: { id: 'p1', name: 'Thuốc', status: RecordStatus.ACTIVE, requiresPrescription: false },
};

describe('OrderService', () => {
  const tx = {};
  const ctx = { tx, afterCommit: jest.fn() };
  const orders = {
    findHead: jest.fn(),
    findDetail: jest.fn().mockResolvedValue({ id: 'o1' }),
    findBranch: jest.fn().mockResolvedValue({ id: 'b1', status: RecordStatus.ACTIVE }),
    upsertWalkInCustomer: jest.fn(),
    findSellableUnits: jest.fn().mockResolvedValue([sellable]),
    createHeader: jest.fn().mockResolvedValue({ id: 'o1' }),
    createItems: jest.fn(),
    deleteItems: jest.fn(),
    claim: jest.fn().mockResolvedValue(1),
    createPayment: jest.fn(),
    findAbandonedPos: jest.fn(),
  };
  const transactions = { run: jest.fn((work: (c: typeof ctx) => unknown) => work(ctx)) };
  const stock = { reserve: jest.fn(), release: jest.fn(), discard: jest.fn(), consume: jest.fn() };
  const codes = { next: jest.fn().mockResolvedValue('HD000001') };
  const audit = { record: jest.fn() };
  const service = new OrderService(
    orders as unknown as OrderRepository,
    transactions as never,
    stock as never,
    codes as never,
    audit as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    orders.claim.mockResolvedValue(1);
  });

  it('createPos: SS lập ở chi nhánh mình, giữ hàng với id dòng tự sinh trùng id đã ghi', async () => {
    await service.createPos({ items: [{ productUnitId: 'pu1', quantity: 12 }] }, ss);
    expect(orders.createHeader).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ branchId: 'b1', staffId: 'u1', channel: OrderChannel.POS, totalAmount: 12000n }),
    );
    const rows = argOf<{ id: string }[]>(orders.createItems, 1);
    expect(stock.reserve).toHaveBeenCalledWith(ctx, {
      orderId: 'o1',
      branchId: 'b1',
      actorId: 'u1',
      items: [{ orderItemId: rows[0].id, productId: 'p1', baseQuantity: 12 }],
    });
  });

  it('createPos: ADMIN không chỉ định chi nhánh → 1002', async () => {
    await expect(service.createPos({ items: [{ productUnitId: 'pu1', quantity: 1 }] }, admin)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('createPos: SĐT thuộc nhân viên → 1602, không tạo đơn', async () => {
    orders.upsertWalkInCustomer.mockResolvedValue({
      id: 'staff',
      isCustomer: false,
      isDeleted: false,
      status: 'ACTIVE',
      created: false,
    });
    await expect(
      service.createPos({ customerPhone: '0912345678', items: [{ productUnitId: 'pu1', quantity: 1 }] }, ss),
    ).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
    expect(orders.createHeader).not.toHaveBeenCalled();
  });

  it('createPos: SĐT mới → hệ thống tạo hồ sơ tên mặc định, gắn vào đơn và ghi nhật ký tạo hồ sơ', async () => {
    orders.upsertWalkInCustomer.mockResolvedValue({
      id: 'c1',
      isCustomer: true,
      isDeleted: false,
      status: 'ACTIVE',
      created: true,
    });
    await service.createPos({ customerPhone: '0912345678', items: [{ productUnitId: 'pu1', quantity: 1 }] }, ss);
    expect(orders.upsertWalkInCustomer).toHaveBeenCalledWith(tx, {
      phoneNumber: '0912345678',
      fullName: 'Khách 0912345678',
      actorId: 'u1',
    });
    expect(orders.createHeader).toHaveBeenCalledWith(tx, expect.objectContaining({ customerId: 'c1' }));
    const entries = argOf<{ entityType: string }[]>(audit.record, 1);
    expect(entries.map((entry) => entry.entityType)).toEqual(['orders', 'users']);
  });

  it('replacePosItems: đơn online → 1701, không đụng kho', async () => {
    orders.findHead.mockResolvedValue(head({ channel: OrderChannel.ONLINE }));
    await expect(
      service.replacePosItems('o1', { items: [{ productUnitId: 'pu1', quantity: 1 }] }, ss),
    ).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_DOCUMENT_STATE });
    expect(stock.discard).not.toHaveBeenCalled();
  });

  it('replacePosItems: chiếm đơn TRƯỚC rồi mới nhả/xoá/giữ lại', async () => {
    orders.findHead.mockResolvedValue(head());
    const calls: string[] = [];
    const track = (name: string, result?: unknown) => () => (calls.push(name), Promise.resolve(result));
    orders.claim.mockImplementation(track('claim', 1));
    stock.discard.mockImplementation(track('discard'));
    orders.deleteItems.mockImplementation(track('delete'));
    stock.reserve.mockImplementation(track('reserve'));
    await service.replacePosItems('o1', { items: [{ productUnitId: 'pu1', quantity: 3 }] }, ss);
    expect(calls).toEqual(['claim', 'discard', 'delete', 'reserve']);
  });

  it('payPos: đọc lại đơn SAU khi chiếm và thu đúng tổng mới', async () => {
    orders.findHead
      .mockResolvedValueOnce(head({ totalAmount: 12000n }))
      .mockResolvedValueOnce(head({ totalAmount: 8000n }));
    await service.payPos('o1', { method: PaymentMethod.CASH }, ss);
    expect(orders.claim.mock.invocationCallOrder[0]).toBeLessThan(orders.findHead.mock.invocationCallOrder[1]);
    expect(orders.createPayment).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ amount: 8000n, status: 'SUCCESS' }),
    );
    expect(stock.consume).toHaveBeenCalledWith(ctx, 'o1', 'u1');
  });

  it('payPos: có thuốc kê đơn mà thiếu đơn thuốc → 1800, không ghi thanh toán', async () => {
    orders.findHead.mockResolvedValue(head({ prescriptionLineCount: 1 }));
    await expect(service.payPos('o1', { method: PaymentMethod.CASH }, ss)).rejects.toMatchObject({
      errorCode: ErrorCode.PRESCRIPTION_REQUIRED,
    });
    expect(orders.createPayment).not.toHaveBeenCalled();
  });

  it('cancel: đơn tại quầy đã COMPLETED → 1701', async () => {
    orders.findHead.mockResolvedValue(head({ status: OrderStatus.COMPLETED }));
    await expect(service.cancel('o1', { reason: 'x' }, ss)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
    expect(stock.release).not.toHaveBeenCalled();
  });

  it('expireAbandonedPos: chỉ huỷ đơn chưa bị sửa kể từ lúc đọc; đơn vừa sửa bị bỏ qua', async () => {
    const stale = new Date('2026-10-16T01:00:00Z');
    orders.findAbandonedPos.mockResolvedValue([
      { id: 'o1', branchId: 'b1', status: OrderStatus.PENDING, updatedAt: stale },
      { id: 'o2', branchId: 'b1', status: OrderStatus.PENDING, updatedAt: null },
    ]);
    orders.claim.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const cancelled = await service.expireAbandonedPos(new Date('2026-10-16T02:00:00Z'));
    expect(cancelled).toBe(1);
    expect(argOf(orders.claim, 2)).toEqual({ status: OrderStatus.PENDING, updatedAt: stale });
    expect(stock.release).toHaveBeenCalledTimes(1);
  });
});
