import { OrderChannel, OrderStatus } from '@prisma/client';
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
  };
  const transactions = { run: jest.fn((work: (c: typeof ctx) => unknown) => work(ctx)) };
  const stock = { restock: jest.fn() };
  const audit = { record: jest.fn() };
  const service = new OrderVoidAndPreviewService(
    orders as unknown as OrderRepository,
    transactions as never,
    stock as never,
    {} as never,
    audit as never,
    {} as never,
  );
  const recorded = () => {
    const [, actor, entries] = audit.record.mock.calls[0] as [unknown, AuditActor, AuditEntry[]];
    return { actor, entries };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    orders.claim.mockResolvedValue(1);
  });

  it('voidPaid ghi ORDER.VOID_PAID và PAYMENT.REFUNDED, amount = totalAmount, reason = dto.reason', async () => {
    orders.findHead.mockResolvedValue(head());
    await service.voidPaid('o1', { reason: 'Khách trả hàng' }, ss);

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

  it('voidPaid đơn 0đ: chỉ ORDER.VOID_PAID (không có tiền để hoàn)', async () => {
    orders.findHead.mockResolvedValue(head({ totalAmount: 0n }));
    await service.voidPaid('o1', { reason: 'Nhập nhầm' }, ss);
    expect(recorded().entries.map((entry) => entry.event)).toEqual(['ORDER.VOID_PAID']);
  });

  it('voidPaid đơn chưa thu → 1701, không ghi nhật ký', async () => {
    orders.findHead.mockResolvedValue(head({ status: OrderStatus.PENDING }));
    await expect(service.voidPaid('o1', { reason: 'x' }, ss)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
