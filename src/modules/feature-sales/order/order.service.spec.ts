import { OrderChannel, OrderStatus, PaymentMethod, RecordStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { AuditActor } from 'src/providers/audit-log/audit-actor';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import { OrderHead, OrderRepository } from './repositories/order.repository';
import { OrderService } from './order.service';

const actorOf = (role: AuthRole, branchId: string | null): RequestActor =>
  ({
    user: { userId: 'u1', role, branchId, roleLevel: 40 },
    ip: '127.0.0.1',
    requestId: 'req-1',
  }) as unknown as RequestActor;
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
  priceBookId: null,
  priceBookName: null,
  createdBy: 'u1',
  discountAmount: 0n,
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
  const priceBooks = { getUsableBook: jest.fn() };
  const service = new OrderService(
    orders as unknown as OrderRepository,
    transactions as never,
    stock as never,
    codes as never,
    audit as never,
    priceBooks as never,
  );
  /** Lần gọi `record` đầu tiên: actor + các entry. */
  const recorded = () => ({ actor: argOf<AuditActor>(audit.record, 1), entries: argOf<AuditEntry[]>(audit.record, 2) });

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
    const { entries } = recorded();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(entries.map((entry) => entry.event)).toEqual(['ORDER.CREATED', 'CUSTOMER.CREATED']);
    expect(entries[0]).toMatchObject({
      entityType: 'orders',
      entityId: 'o1',
      entityLabel: 'HD000001',
      branchIds: ['b1'],
      searchTerms: ['HD000001'],
      amount: 1000n,
    });
  });

  it('createPos ghi ORDER.CREATED với actor USER, amount = totalAmount (bigint), không Number', async () => {
    await service.createPos({ items: [{ productUnitId: 'pu1', quantity: 12 }] }, ss);
    const { actor, entries } = recorded();
    expect(actor).toMatchObject({ userId: 'u1', type: 'USER', branchId: 'b1', ip: '127.0.0.1', requestId: 'req-1' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'ORDER.CREATED', amount: 12000n, branchIds: ['b1'] });
  });

  it('createPos: totalAmount = subtotal (giảm giá luôn 0), không phát ORDER.DISCOUNT_APPLIED', async () => {
    await service.createPos({ items: [{ productUnitId: 'pu1', quantity: 12 }] }, ss);
    expect(orders.createHeader).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ subtotalAmount: 12000n, discountAmount: 0n, totalAmount: 12000n }),
    );
    expect(recorded().entries.map((entry) => entry.event)).toEqual(['ORDER.CREATED']);
  });

  it('createPos có ghi đè cảnh báo tương tác ghi thêm ORDER.INTERACTION_OVERRIDE, lý do = lý do ghi đè', async () => {
    await service.createPos(
      {
        items: [{ productUnitId: 'pu1', quantity: 1 }],
        interactionOverride: { reason: 'Bác sĩ đã xác nhận', warningIds: ['w1'], warningSummaries: ['A + B'] },
      },
      ss,
    );
    const { entries } = recorded();
    expect(entries.map((entry) => entry.event)).toEqual(['ORDER.CREATED', 'ORDER.INTERACTION_OVERRIDE']);
    expect(entries[1]).toMatchObject({ reason: 'Bác sĩ đã xác nhận', branchIds: ['b1'], entityLabel: 'HD000001' });
  });

  it('dòng CUSTOMER.CREATED che SĐT còn 4 số cuối', async () => {
    orders.upsertWalkInCustomer.mockResolvedValue({
      id: 'c1',
      isCustomer: true,
      isDeleted: false,
      status: 'ACTIVE',
      created: true,
    });
    await service.createPos(
      { customerPhone: '0912345678', customerName: 'Nguyễn Văn A', items: [{ productUnitId: 'pu1', quantity: 1 }] },
      ss,
    );
    const customer = recorded().entries.find((entry) => entry.event === 'CUSTOMER.CREATED');
    expect(customer).toMatchObject({ entityType: 'users', entityId: 'c1', branchIds: ['b1'] });
    expect(customer?.after).toMatchObject({ phoneNumber: '******5678' });
    // Không bao giờ có tên/SĐT khách ở nhãn, từ khoá hay bất kỳ chỗ nào của dòng nhật ký.
    const serialized = JSON.stringify(recorded().entries, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).not.toContain('0912345678');
    expect(serialized).not.toContain('Nguyễn Văn A');
    for (const entry of recorded().entries) {
      expect(entry.entityLabel ?? '').not.toMatch(/5678|Nguyễn/);
      expect((entry.searchTerms ?? []).join(' ')).not.toMatch(/5678|Nguyễn/);
    }
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

  it('replacePosItems ghi ORDER.ITEMS_REPLACED amount = tổng mới', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 12000n, discountAmount: 0n }));
    await service.replacePosItems('o1', { items: [{ productUnitId: 'pu1', quantity: 3 }] }, ss);
    const { entries } = recorded();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(entries.map((entry) => entry.event)).toEqual(['ORDER.ITEMS_REPLACED']);
    expect(entries[0]).toMatchObject({ entityLabel: 'HD000001', branchIds: ['b1'], amount: 3000n });
    expect(entries[0].before).toMatchObject({ totalAmount: '12000' });
  });

  it('replacePosItems giữ discountAmount = 0 (kể cả đơn cũ còn giảm giá)', async () => {
    orders.findHead.mockResolvedValue(head({ discountAmount: 500n }));
    await service.replacePosItems('o1', { items: [{ productUnitId: 'pu1', quantity: 3 }] }, ss);
    expect(orders.claim).toHaveBeenCalledWith(
      tx,
      'o1',
      expect.anything(),
      expect.objectContaining({ discountAmount: 0n, totalAmount: 3000n }),
    );
    expect(recorded().entries.map((entry) => entry.event)).toEqual(['ORDER.ITEMS_REPLACED']);
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
    const { entries } = recorded();
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'ORDER.PAID',
        entityLabel: 'HD000001',
        branchIds: ['b1'],
        searchTerms: ['HD000001'],
        amount: 8000n,
      }),
    ]);
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

  it('cancel ghi ORDER.CANCELLED với lý do của người huỷ', async () => {
    orders.findHead.mockResolvedValue(head());
    await service.cancel('o1', { reason: 'Khách đổi ý' }, ss);
    const { actor, entries } = recorded();
    expect(actor.type).toBe('USER');
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'ORDER.CANCELLED',
        entityLabel: 'HD000001',
        branchIds: ['b1'],
        reason: 'Khách đổi ý',
      }),
    ]);
  });

  it('expireAbandonedPos ghi ORDER.AUTO_EXPIRED với actor.type JOB', async () => {
    orders.findAbandonedPos.mockResolvedValue([
      { id: 'o1', code: 'HD000001', branchId: 'b1', status: OrderStatus.PENDING, updatedAt: null },
    ]);
    await service.expireAbandonedPos(new Date('2026-10-16T02:00:00Z'));
    const { actor, entries } = recorded();
    expect(actor).toMatchObject({ type: 'JOB', ip: null, requestId: null });
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'ORDER.AUTO_EXPIRED',
        entityId: 'o1',
        entityLabel: 'HD000001',
        branchIds: ['b1'],
        reason: expect.stringContaining('Tự huỷ') as unknown,
      }),
    ]);
  });

  it('expireAbandonedPos: chỉ huỷ đơn chưa bị sửa kể từ lúc đọc; đơn vừa sửa bị bỏ qua', async () => {
    const stale = new Date('2026-10-16T01:00:00Z');
    orders.findAbandonedPos.mockResolvedValue([
      { id: 'o1', code: 'HD000001', branchId: 'b1', status: OrderStatus.PENDING, updatedAt: stale },
      { id: 'o2', code: 'HD000002', branchId: 'b1', status: OrderStatus.PENDING, updatedAt: null },
    ]);
    orders.claim.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const cancelled = await service.expireAbandonedPos(new Date('2026-10-16T02:00:00Z'));
    expect(cancelled).toBe(1);
    expect(argOf(orders.claim, 2)).toEqual({ status: OrderStatus.PENDING, updatedAt: stale });
    expect(stock.release).toHaveBeenCalledTimes(1);
  });
});
