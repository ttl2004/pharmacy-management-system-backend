import { OrderChannel, OrderStatus, PaymentMethod, Prisma, RecordStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { AuditActor } from 'src/providers/audit-log/audit-actor';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import { OrderHead, OrderRepository } from './repositories/order.repository';
import { OrderService } from './order.service';
import { MAX_PENDING_POS_PER_STAFF } from '../core/sales.constants';

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
  completedAt: null,
  priceBookId: null,
  priceBookName: null,
  createdBy: 'u1',
  staffId: 'u1',
  staffName: 'Nhân viên A',
  discountAmount: 0n,
  lineCount: 1,
  prescriptionLineCount: 0,
  customerId: null,
  controlledLineCount: 0,
  interactionOverride: null,
  ...overrides,
});

const sellable = {
  id: 'pu1',
  conversionRate: 1,
  allowLooseSale: true,
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
    findPage: jest.fn().mockResolvedValue({ hits: [], total: 0 }),
    lockAndCountPendingPos: jest.fn().mockResolvedValue(0),
    findItemProductIds: jest.fn().mockResolvedValue(['p1']),
  };
  const transactions = { run: jest.fn((work: (c: typeof ctx) => unknown) => work(ctx)) };
  const stock = {
    reserve: jest.fn(),
    release: jest.fn(),
    discard: jest.fn(),
    consume: jest.fn(),
    lockForReplace: jest.fn().mockResolvedValue([]),
  };
  const codes = { next: jest.fn().mockResolvedValue('HD000001') };
  const audit = { record: jest.fn() };
  const priceBooks = { getUsableBook: jest.fn() };
  const rollup = { applyOrder: jest.fn() };
  const permissions = { getGrantedCodes: jest.fn() };
  const approval = {
    reason: 'Bác sĩ đã xác nhận phối hợp được',
    warningIds: ['ddi:DD1:DD2'],
    warningSummaries: ['Nghiêm trọng: A + B'],
    manual: false,
    byUserId: 'ph1',
    byUserName: 'Dược sĩ B',
    requestedBy: 'u1',
    at: '2026-11-21T00:00:00.000Z',
  };
  const safety = {
    approvalForOrder: jest.fn().mockReturnValue(null),
    precheck: jest.fn((productIds: string[]) =>
      Promise.resolve({ available: true, productIds, majorWarningIds: [], majorSummaries: [] }),
    ),
    assertPayAllowed: jest.fn(),
  };
  const service = new OrderService(
    orders as unknown as OrderRepository,
    transactions as never,
    stock as never,
    codes as never,
    audit as never,
    priceBooks as never,
    rollup as never,
    permissions as never,
    safety as never,
  );
  /** Lần gọi `record` đầu tiên: actor + các entry. */
  const recorded = () => ({ actor: argOf<AuditActor>(audit.record, 1), entries: argOf<AuditEntry[]>(audit.record, 2) });

  beforeEach(() => {
    jest.clearAllMocks();
    orders.claim.mockResolvedValue(1);
    orders.lockAndCountPendingPos.mockResolvedValue(0);
    permissions.getGrantedCodes.mockResolvedValue(new Set());
    orders.findItemProductIds.mockResolvedValue(['p1']);
    safety.approvalForOrder.mockReturnValue(null);
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

  // L12: một người lập đơn chờ thu liên tục sẽ giữ hết hàng, quầy khác thấy "hết hàng".
  it('createPos: nhân viên đã có 3 đơn chờ thu → 1002, không lập đơn, không giữ hàng', async () => {
    orders.lockAndCountPendingPos.mockResolvedValue(MAX_PENDING_POS_PER_STAFF);
    await expect(service.createPos({ items: [{ productUnitId: 'pu1', quantity: 1 }] }, ss)).rejects.toThrow(
      /3 đơn chờ thu/,
    );
    expect(orders.lockAndCountPendingPos).toHaveBeenCalledWith(tx, ss.user.userId);
    expect(orders.createHeader).not.toHaveBeenCalled();
    expect(stock.reserve).not.toHaveBeenCalled();
  });

  it('createPos: đang có 2 đơn chờ thu → vẫn lập được đơn thứ 3', async () => {
    orders.lockAndCountPendingPos.mockResolvedValue(MAX_PENDING_POS_PER_STAFF - 1);
    await service.createPos({ items: [{ productUnitId: 'pu1', quantity: 1 }] }, ss);
    expect(orders.createHeader).toHaveBeenCalled();
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

  it('createPos có phiếu duyệt: đối chiếu đúng người bán/chi nhánh/giỏ, lưu bản duyệt, ghi ORDER.INTERACTION_OVERRIDE', async () => {
    safety.approvalForOrder.mockReturnValue(approval);
    await service.createPos({ items: [{ productUnitId: 'pu1', quantity: 1 }], interactionApprovalToken: 'token' }, ss);
    expect(safety.approvalForOrder).toHaveBeenCalledWith('token', {
      actorId: 'u1',
      branchId: 'b1',
      productIds: ['p1'],
    });
    expect(orders.createHeader).toHaveBeenCalledWith(tx, expect.objectContaining({ interactionOverride: approval }));
    const { entries } = recorded();
    expect(entries.map((entry) => entry.event)).toEqual(['ORDER.CREATED', 'ORDER.INTERACTION_OVERRIDE']);
    expect(entries[1]).toMatchObject({
      reason: approval.reason,
      branchIds: ['b1'],
      entityLabel: 'HD000001',
      after: { approvedBy: { userId: 'ph1', fullName: 'Dược sĩ B' } },
    });
  });

  it('replacePosItems không gửi phiếu duyệt → xoá bản duyệt cũ của đơn', async () => {
    orders.findHead.mockResolvedValue(head());
    await service.replacePosItems('o1', { items: [{ productUnitId: 'pu1', quantity: 1 }] }, ss);
    const update = argOf<Record<string, unknown>>(orders.claim, 3);
    expect(update.interactionOverride).toBe(Prisma.DbNull);
  });

  it('payPos: kiểm tra tương tác trước transaction, rồi kiểm bản duyệt của đơn', async () => {
    orders.findHead.mockResolvedValue(head({ interactionOverride: approval }));
    await service.payPos('o1', { method: PaymentMethod.CASH }, ss);
    expect(safety.precheck).toHaveBeenCalledWith(['p1']);
    expect(safety.assertPayAllowed).toHaveBeenCalledWith(expect.objectContaining({ productIds: ['p1'] }), approval);
  });

  it('payPos: còn cảnh báo chưa duyệt → lỗi của gate, không ghi thanh toán, không trừ kho', async () => {
    orders.findHead.mockResolvedValue(head());
    safety.assertPayAllowed.mockImplementationOnce(() => {
      throw new Error('1804');
    });
    await expect(service.payPos('o1', { method: PaymentMethod.CASH }, ss)).rejects.toThrow('1804');
    expect(orders.createPayment).not.toHaveBeenCalled();
    expect(stock.consume).not.toHaveBeenCalled();
  });

  it('payPos: giỏ bị sửa giữa lúc kiểm tra và lúc thu → báo thử lại, không ghi thanh toán', async () => {
    orders.findHead.mockResolvedValue(head());
    orders.findItemProductIds.mockResolvedValueOnce(['p1']).mockResolvedValueOnce(['p1', 'p2']);
    await expect(service.payPos('o1', { method: PaymentMethod.CASH }, ss)).rejects.toThrow('vừa được sửa');
    expect(orders.createPayment).not.toHaveBeenCalled();
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
    stock.lockForReplace.mockImplementation(track('lock', ['locked']));
    stock.discard.mockImplementation(track('discard'));
    orders.deleteItems.mockImplementation(track('delete'));
    stock.reserve.mockImplementation(track('reserve'));
    await service.replacePosItems('o1', { items: [{ productUnitId: 'pu1', quantity: 3 }] }, ss);
    // B1: đúng MỘT lần khoá hợp lô cũ + mới, trước khi nhả/giữ; kết quả khoá truyền cho discard.
    expect(calls).toEqual(['claim', 'lock', 'discard', 'delete', 'reserve']);
    expect(stock.lockForReplace).toHaveBeenCalledTimes(1);
    expect(stock.discard).toHaveBeenCalledWith(expect.anything(), 'o1', expect.anything(), ['locked']);
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

  it('replacePosItems: đơn khách lẻ đổi sang thuốc kiểm soát → 400, không chiếm đơn, không đụng kho (M1)', async () => {
    orders.findHead.mockResolvedValue(head({ customerId: null }));
    orders.findSellableUnits.mockResolvedValueOnce([
      { ...sellable, product: { ...sellable.product, isControlled: true } },
    ]);
    await expect(
      service.replacePosItems('o1', { items: [{ productUnitId: 'pu1', quantity: 1 }] }, ss),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
    expect(orders.claim).not.toHaveBeenCalled();
    expect(stock.discard).not.toHaveBeenCalled();
  });

  it('replacePosItems: đơn đã có khách thì được thêm thuốc kiểm soát (M1)', async () => {
    orders.findHead.mockResolvedValue(head({ customerId: 'c1' }));
    orders.findSellableUnits.mockResolvedValueOnce([
      { ...sellable, product: { ...sellable.product, isControlled: true } },
    ]);
    await service.replacePosItems('o1', { items: [{ productUnitId: 'pu1', quantity: 1 }] }, ss);
    expect(stock.reserve).toHaveBeenCalled();
  });

  it('payPos: đơn khách lẻ có thuốc kiểm soát → 400, không ghi thanh toán, không trừ kho (M1)', async () => {
    orders.findHead.mockResolvedValue(head({ customerId: null, controlledLineCount: 1 }));
    await expect(service.payPos('o1', { method: PaymentMethod.CASH }, ss)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    expect(orders.createPayment).not.toHaveBeenCalled();
    expect(stock.consume).not.toHaveBeenCalled();
  });

  it('payPos: có thuốc kê đơn mà thiếu đơn thuốc → 1800, không ghi thanh toán', async () => {
    orders.findHead.mockResolvedValue(head({ prescriptionLineCount: 1 }));
    await expect(service.payPos('o1', { method: PaymentMethod.CASH }, ss)).rejects.toMatchObject({
      errorCode: ErrorCode.PRESCRIPTION_REQUIRED,
    });
    expect(orders.createPayment).not.toHaveBeenCalled();
    expect(rollup.applyOrder).not.toHaveBeenCalled();
  });

  it('payPos gọi applyOrder(tx, id, 1, totalAmount) trong cùng transaction, sau ghi thanh toán', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 8000n }));
    await service.payPos('o1', { method: PaymentMethod.CASH }, ss);
    expect(rollup.applyOrder).toHaveBeenCalledTimes(1);
    expect(rollup.applyOrder).toHaveBeenCalledWith(tx, 'o1', 1, 8000n);
    expect(orders.createPayment.mock.invocationCallOrder[0]).toBeLessThan(
      rollup.applyOrder.mock.invocationCallOrder[0],
    );
  });

  it('payPos: kho báo lỗi sau khi ghi thanh toán → không để lại lệnh cộng tổng hợp ngoài transaction lỗi', async () => {
    orders.findHead.mockResolvedValue(head());
    stock.consume.mockRejectedValueOnce(new Error('thiếu hàng'));
    await expect(service.payPos('o1', { method: PaymentMethod.CASH }, ss)).rejects.toThrow('thiếu hàng');
    expect(rollup.applyOrder).not.toHaveBeenCalled();
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
      { id: 'o1', code: 'HD000001', branchId: 'b1', status: OrderStatus.PENDING },
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

  it('expireAbandonedPos: hạn tính từ lúc LẬP đơn — chiếm bằng createdAt < cutoff (không dùng updatedAt); đơn đã thu/huỷ trước bị bỏ qua', async () => {
    const now = new Date('2026-10-16T02:00:00Z');
    orders.findAbandonedPos.mockResolvedValue([
      { id: 'o1', code: 'HD000001', branchId: 'b1', status: OrderStatus.PENDING },
      { id: 'o2', code: 'HD000002', branchId: 'b1', status: OrderStatus.PENDING },
    ]);
    orders.claim.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const cancelled = await service.expireAbandonedPos(now);
    const cutoff = new Date(now.getTime() - 30 * 60_000);
    expect(orders.findAbandonedPos).toHaveBeenCalledWith(cutoff, expect.any(Number));
    expect(cancelled).toBe(1);
    expect(argOf(orders.claim, 2)).toEqual({
      status: OrderStatus.PENDING,
      channel: OrderChannel.POS,
      createdAt: { lt: cutoff },
    });
    expect(stock.release).toHaveBeenCalledTimes(1);
  });

  // Đơn lập 31 phút trước nhưng sửa 1 phút trước: vẫn quá hạn — claim không còn phụ thuộc updatedAt nên không bị chặn.
  it('expireAbandonedPos: đơn lập 31 phút trước, sửa 1 phút trước vẫn bị huỷ', async () => {
    const now = new Date('2026-10-16T02:00:00Z');
    orders.findAbandonedPos.mockResolvedValue([
      { id: 'o1', code: 'HD000001', branchId: 'b1', status: OrderStatus.PENDING },
    ]);
    expect(await service.expireAbandonedPos(now)).toBe(1);
    expect(JSON.stringify(argOf(orders.claim, 2))).not.toContain('updatedAt');
    expect(stock.release).toHaveBeenCalledTimes(1);
    expect(recorded().entries[0]).not.toHaveProperty('metadata');
  });

  describe('đơn chờ của nhân viên khác (order:handle-others)', () => {
    const mine = () => head({ staffId: 'u1' });
    const others = () => head({ staffId: 'u9', createdBy: 'u9', staffName: 'Chị Lan' });
    const manager = actorOf(AuthRole.PHARMACY_MANAGER, 'b1');
    const grantHandleOthers = () => permissions.getGrantedCodes.mockResolvedValue(new Set(['order:handle-others']));
    const items = { items: [{ productUnitId: 'pu1', quantity: 1 }] };

    it('đơn của mình: không cần quyền, không tra quyền, audit không có onBehalfOf', async () => {
      orders.findHead.mockResolvedValue(mine());
      await service.payPos('o1', { method: PaymentMethod.CASH }, ss);
      expect(permissions.getGrantedCodes).not.toHaveBeenCalled();
      expect(recorded().entries[0]).not.toHaveProperty('metadata');
    });

    it.each([
      ['replacePosItems', () => service.replacePosItems('o1', items, ss)],
      ['payPos', () => service.payPos('o1', { method: PaymentMethod.CASH }, ss)],
      ['cancel', () => service.cancel('o1', { reason: 'x' }, ss)],
    ])('%s đơn người khác không có quyền → 1500, không chiếm đơn, không đụng kho', async (_name, call) => {
      orders.findHead.mockResolvedValue(others());
      await expect(call()).rejects.toMatchObject({
        response: { code: ErrorCode.PERMISSION_DENIED, message: 'Chỉ quản lý được xử lý đơn chờ của nhân viên khác' },
      });
      expect(orders.claim).not.toHaveBeenCalled();
      expect(stock.discard).not.toHaveBeenCalled();
      expect(stock.release).not.toHaveBeenCalled();
      expect(stock.consume).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('payPos đơn người khác có quyền → thu được, audit có onBehalfOf = người lập', async () => {
      grantHandleOthers();
      orders.findHead.mockResolvedValue(others());
      await service.payPos('o1', { method: PaymentMethod.CASH }, manager);
      expect(recorded().entries[0]).toMatchObject({
        event: 'ORDER.PAID',
        metadata: { onBehalfOf: { userId: 'u9', fullName: 'Chị Lan' } },
      });
    });

    it('cancel đơn người khác có quyền → huỷ được, audit có onBehalfOf', async () => {
      grantHandleOthers();
      orders.findHead.mockResolvedValue(others());
      await service.cancel('o1', { reason: 'x' }, manager);
      expect(stock.release).toHaveBeenCalled();
      expect(recorded().entries[0]).toMatchObject({
        event: 'ORDER.CANCELLED',
        metadata: { onBehalfOf: { userId: 'u9', fullName: 'Chị Lan' } },
      });
    });

    it('replacePosItems đơn người khác có quyền → sửa được, audit có onBehalfOf', async () => {
      grantHandleOthers();
      orders.findHead.mockResolvedValue(others());
      await service.replacePosItems('o1', items, manager);
      expect(recorded().entries[0]).toMatchObject({
        event: 'ORDER.ITEMS_REPLACED',
        metadata: { onBehalfOf: { userId: 'u9', fullName: 'Chị Lan' } },
      });
    });

    it('SUPER_ADMIN bỏ qua kiểm tra quyền', async () => {
      orders.findHead.mockResolvedValue(others());
      await service.cancel('o1', { reason: 'x' }, actorOf(AuthRole.SUPER_ADMIN, null));
      expect(permissions.getGrantedCodes).not.toHaveBeenCalled();
      expect(stock.release).toHaveBeenCalled();
    });

    it('thiếu staffId (dữ liệu cũ) dùng createdBy để xác định người lập', async () => {
      orders.findHead.mockResolvedValue(head({ staffId: null, createdBy: 'u1' }));
      await service.cancel('o1', { reason: 'x' }, ss);
      expect(stock.release).toHaveBeenCalled();
    });

    it('list: không có quyền → chỉ đơn chờ POS của mình, hoá đơn đã thu/huỷ không bị giới hạn', async () => {
      await service.list({ page: 1, limit: 20, status: OrderStatus.PENDING } as never, ss);
      const where = argOf<{ AND: unknown[] }>(orders.findPage, 0);
      expect(where.AND).toContainEqual({
        OR: [{ status: { not: OrderStatus.PENDING } }, { channel: { not: OrderChannel.POS } }, { staffId: 'u1' }],
      });
    });

    it('list: có quyền (quản lý) → thấy cả chi nhánh, không thêm điều kiện người lập', async () => {
      grantHandleOthers();
      await service.list({ page: 1, limit: 20, status: OrderStatus.PENDING } as never, manager);
      expect(JSON.stringify(argOf(orders.findPage, 0))).not.toContain('staffId');
    });
  });
});
