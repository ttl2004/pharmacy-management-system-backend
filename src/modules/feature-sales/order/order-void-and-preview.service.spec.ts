import { OrderChannel, OrderStatus, PaymentMethod, TransactionStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { AuditActor } from 'src/providers/audit-log/audit-actor';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import { OrderVoidAndPreviewService } from './order-void-and-preview.service';
import { OrderHead, OrderRepository } from './repositories/order.repository';

const ss = {
  user: { userId: 'u1', role: AuthRole.SALES_STAFF, branchId: 'b1', roleLevel: 40 },
  ip: '127.0.0.1',
  requestId: 'req-1',
} as unknown as RequestActor;

const head = (overrides: Partial<OrderHead> = {}): OrderHead => ({
  id: 'o1',
  code: 'HD000001',
  branchId: 'b1',
  channel: OrderChannel.POS,
  status: OrderStatus.COMPLETED,
  totalAmount: 12000n,
  discountAmount: 0n,
  prescriptionCode: null,
  prescriberName: null,
  updatedAt: null,
  priceBookId: null,
  priceBookName: null,
  createdBy: 'u1',
  lineCount: 1,
  prescriptionLineCount: 0,
  ...overrides,
});

describe('OrderVoidAndPreviewService', () => {
  const tx = {};
  const ctx = { tx, afterCommit: jest.fn() };
  const orders = {
    findHead: jest.fn(),
    findDetail: jest.fn().mockResolvedValue({ id: 'o1' }),
    claim: jest.fn().mockResolvedValue(1),
    createPayment: jest.fn().mockResolvedValue({ id: 'p1' }),
  };
  const transactions = { run: jest.fn((work: (c: typeof ctx) => unknown) => work(ctx)) };
  const stock = { restock: jest.fn() };
  const audit = { record: jest.fn() };
  const rollup = { applyOrder: jest.fn() };
  const service = new OrderVoidAndPreviewService(
    orders as unknown as OrderRepository,
    transactions as never,
    stock as never,
    {} as never,
    audit as never,
    {} as never,
    rollup as never,
  );
  const recorded = () => {
    const [, actor, entries] = audit.record.mock.calls[0] as [unknown, AuditActor, AuditEntry[]];
    return { actor, entries };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    orders.claim.mockResolvedValue(1);
  });

  const full = { reason: 'Khách trả hàng', refundAmount: 12000, refundMethod: PaymentMethod.CASH };

  it('voidPaid ghi ORDER.VOID_PAID và PAYMENT.REFUNDED, amount = refundAmount, reason = dto.reason', async () => {
    orders.findHead.mockResolvedValue(head());
    await service.voidPaid('o1', full, ss);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const { actor, entries } = recorded();
    expect(actor).toMatchObject({ userId: 'u1', type: 'USER', requestId: 'req-1' });
    expect(entries.map((entry) => entry.event)).toEqual(['ORDER.VOID_PAID', 'PAYMENT.REFUNDED']);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        entityId: 'o1',
        entityLabel: 'HD000001',
        branchIds: ['b1'],
        searchTerms: ['HD000001'],
        amount: 12000n,
        reason: 'Khách trả hàng',
      });
    }
  });

  it('đơn 100k: refundAmount 100000 CASH → payment REFUND 100000; audit PAYMENT.REFUNDED 100000n, severity 1', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 100000n }));
    await service.voidPaid('o1', { reason: 'Khách trả', refundAmount: 100000, refundMethod: PaymentMethod.CASH }, ss);

    expect(orders.createPayment).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orderId: 'o1',
        kind: 'REFUND',
        method: PaymentMethod.CASH,
        amount: 100000n,
        status: TransactionStatus.SUCCESS,
        createdBy: 'u1',
      }),
    );
    const refund = recorded().entries.find((entry) => entry.event === 'PAYMENT.REFUNDED');
    expect(refund).toMatchObject({ amount: 100000n, metadata: { totalAmount: '100000', refundAmount: '100000' } });
    expect(refund?.severity).toBe(1);
    expect(refund?.metadata).not.toHaveProperty('partialRefund');
  });

  it('đơn 100k hoàn 60000 → payment REFUND 60000; severity 2, metadata.partialRefund true, totalAmount "100000"', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 100000n }));
    await service.voidPaid(
      'o1',
      { reason: 'Khách trả', refundAmount: 60000, refundMethod: PaymentMethod.BANK_TRANSFER },
      ss,
    );

    expect(orders.createPayment).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ kind: 'REFUND', amount: 60000n, method: PaymentMethod.BANK_TRANSFER }),
    );
    const refund = recorded().entries.find((entry) => entry.event === 'PAYMENT.REFUNDED');
    expect(refund).toMatchObject({
      amount: 60000n,
      severity: 2,
      metadata: { totalAmount: '100000', refundAmount: '60000', partialRefund: true },
    });
  });

  it.each([
    [100000, 100000n],
    [60000, 60000n],
  ])('voidPaid đơn 100k hoàn %i → applyOrder(tx, id, -1, -%sn)', async (refundAmount, refund) => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 100000n }));
    await service.voidPaid('o1', { reason: 'Khách trả', refundAmount, refundMethod: PaymentMethod.CASH }, ss);
    expect(rollup.applyOrder).toHaveBeenCalledTimes(1);
    expect(rollup.applyOrder).toHaveBeenCalledWith(tx, 'o1', -1, -refund);
    expect(orders.createPayment.mock.invocationCallOrder[0]).toBeLessThan(
      rollup.applyOrder.mock.invocationCallOrder[0],
    );
  });

  it('voidPaid đơn 0đ → applyOrder(tx, id, -1, 0n)', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 0n }));
    await service.voidPaid('o1', { reason: 'Nhập nhầm' }, ss);
    expect(rollup.applyOrder).toHaveBeenCalledWith(tx, 'o1', -1, 0n);
  });

  it.each([
    ['thiếu refundAmount', { reason: 'x', refundMethod: PaymentMethod.CASH }],
    ['refundAmount 0', { reason: 'x', refundAmount: 0, refundMethod: PaymentMethod.CASH }],
    ['refundAmount 100001', { reason: 'x', refundAmount: 100001, refundMethod: PaymentMethod.CASH }],
    ['thiếu refundMethod', { reason: 'x', refundAmount: 100000 }],
  ])('đơn 100k %s → 1002', async (_name, dto) => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 100000n }));
    await expect(service.voidPaid('o1', dto, ss)).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('đơn 0đ: không gửi refundAmount → không tạo payment, chỉ ORDER.VOID_PAID', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 0n }));
    await service.voidPaid('o1', { reason: 'Nhập nhầm' }, ss);
    expect(orders.createPayment).not.toHaveBeenCalled();
    expect(recorded().entries.map((entry) => entry.event)).toEqual(['ORDER.VOID_PAID']);
  });

  it('đơn 0đ: gửi refundAmount 5000 → 1002', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 0n }));
    await expect(
      service.voidPaid('o1', { reason: 'x', refundAmount: 5000, refundMethod: PaymentMethod.CASH }, ss),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('kiểm tiền xảy ra TRƯỚC khi chiếm đơn và trả hàng về kho', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 100000n }));
    await expect(service.voidPaid('o1', { reason: 'x' }, ss)).rejects.toBeDefined();
    expect(orders.claim).not.toHaveBeenCalled();
    expect(stock.restock).not.toHaveBeenCalled();
    expect(orders.createPayment).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('voidPaid đơn chưa thu → 1701, không ghi nhật ký', async () => {
    orders.findHead.mockResolvedValue(head({ status: OrderStatus.PENDING }));
    await expect(service.voidPaid('o1', full, ss)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
