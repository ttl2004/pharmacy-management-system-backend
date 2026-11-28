import { ReceiptStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { GoodsReceiptLocker } from './goods-receipt-locker';
import { GoodsReceiptMetaService } from './goods-receipt-meta.service';
import { GoodsReceiptPaymentService } from './goods-receipt-payment.service';

const A = '11111111-1111-4111-8111-111111111111';
const PM_A: RequestActor = {
  user: { userId: 'pm-a', sid: 's', email: null, role: AuthRole.PHARMACY_MANAGER, branchId: A, roleLevel: 60 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: null,
};
type RecordCall = [unknown, Record<string, unknown>, Record<string, unknown>[]];

const head = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  code: 'PN000001',
  status: ReceiptStatus.DRAFT,
  branchId: A,
  supplierId: 's1',
  receiverId: 'u-old',
  receivedAt: null,
  note: null,
  paymentMethod: null,
  totalAmount: 10_000n,
  paidAmount: 2_000n,
  ...overrides,
});

function setup(receiptHead: ReturnType<typeof head>, returned = 0n) {
  const receipts = {
    findStatus: jest.fn().mockResolvedValue(receiptHead),
    findStatusForUpdate: jest.fn().mockResolvedValue(receiptHead),
    transition: jest.fn().mockResolvedValue(1),
    findDetail: jest.fn().mockResolvedValue({ id: 'r1' }),
    isValidReceiver: jest.fn().mockResolvedValue(true),
    returnedAmountOf: jest.fn().mockResolvedValue(returned),
  };
  const debts = {
    lockSupplier: jest.fn().mockResolvedValue(true),
    debtOf: jest.fn().mockResolvedValue({ scoped: 100_000n, chain: 100_000n }),
  };
  const locker = new GoodsReceiptLocker(receipts as never, debts as never);
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx: {} })) };
  const audit = { record: jest.fn() };
  return { receipts, debts, locker, transactions, audit };
}

describe('GoodsReceiptPaymentService — nhật ký', () => {
  function makeService(receiptHead: ReturnType<typeof head>, returned = 0n) {
    const deps = setup(receiptHead, returned);
    const supplierPayments = {
      createForReceipt: jest.fn().mockResolvedValue({
        id: 'pay1',
        code: 'TTPN000001',
        amount: 3_000n,
        auditEntries: [{ event: 'GOODS_RECEIPT.PAYMENT_UPDATED' }, { event: 'SUPPLIER_PAYMENT.CREATED' }],
      }),
    };
    const permissions = {
      getGrantedCodes: jest.fn().mockResolvedValue(new Set(['supplier-debt:write', 'goods-receipt:create'])),
    };
    const service = new GoodsReceiptPaymentService(
      deps.receipts as never,
      deps.locker,
      deps.debts as never,
      supplierPayments as never,
      permissions as never,
      deps.transactions as never,
      deps.audit as never,
    );
    return { service, supplierPayments, audit: deps.audit, receipts: deps.receipts };
  }

  it('phiếu nháp: GOODS_RECEIPT.PAYMENT_UPDATED, amount = paidAmount mới (bigint)', async () => {
    const { service, audit } = makeService(head());
    await service.updatePayment('r1', { paidAmount: 5_000 } as never, PM_A);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, auditActor, entries] = audit.record.mock.calls[0] as RecordCall;
    expect(auditActor).toMatchObject({ userId: 'pm-a' });
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'GOODS_RECEIPT.PAYMENT_UPDATED',
        entityType: 'goods_receipts',
        entityId: 'r1',
        entityLabel: 'PN000001',
        branchIds: [A],
        searchTerms: ['PN000001'],
        amount: 5_000n,
        before: { paidAmount: '2000' },
        after: { paidAmount: '5000', paymentStatus: 'PARTIAL' },
      }),
    ]);
  });

  it('phiếu đã xác nhận tăng số đã trả: record MỘT lần các entry phiếu chi tự sinh', async () => {
    const { service, supplierPayments, audit } = makeService(head({ status: ReceiptStatus.CONFIRMED }));
    await service.updatePayment('r1', { paidAmount: 5_000 } as never, PM_A);
    expect(supplierPayments.createForReceipt).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ id: 'r1' }),
      3_000n,
      expect.anything(),
      { actorId: 'pm-a' },
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries.map((entry) => entry.event)).toEqual(['GOODS_RECEIPT.PAYMENT_UPDATED', 'SUPPLIER_PAYMENT.CREATED']);
  });

  it('phiếu đã xác nhận có trả hàng NCC: vượt nợ thật (tổng − trả hàng) bị từ chối, bằng nợ thật thì lập phiếu chi đúng số', async () => {
    const confirmed = head({ status: ReceiptStatus.CONFIRMED, totalAmount: 10_000n, paidAmount: 2_000n });
    const over = makeService(confirmed, 4_000n);
    await expect(over.service.updatePayment('r1', { paidAmount: 6_001 } as never, PM_A)).rejects.toThrow(
      'Tổng đã trả vượt số nợ của phiếu (đã trừ trả hàng): tối đa 6000',
    );
    expect(over.supplierPayments.createForReceipt).not.toHaveBeenCalled();

    const atNet = makeService(confirmed, 4_000n);
    await atNet.service.updatePayment('r1', { paidAmount: 6_000 } as never, PM_A);
    expect(atNet.supplierPayments.createForReceipt).toHaveBeenCalledWith(
      {},
      expect.anything(),
      4_000n,
      expect.anything(),
      { actorId: 'pm-a' },
    );
  });

  it('nợ thật âm hoặc bằng số đã trả: tăng bị chặn và báo tối đa 0; số không đổi không bị chặn bởi trần', async () => {
    const confirmed = head({ status: ReceiptStatus.CONFIRMED, totalAmount: 10_000n, paidAmount: 10_000n });
    const a = makeService(confirmed, 12_000n);
    await expect(a.service.updatePayment('r1', { paidAmount: 10_000 } as never, PM_A)).resolves.toBeDefined();
    const b = makeService(head({ status: ReceiptStatus.CONFIRMED, totalAmount: 10_000n, paidAmount: 9_000n }), 12_000n);
    await expect(b.service.updatePayment('r1', { paidAmount: 9_500 } as never, PM_A)).rejects.toThrow('tối đa 0');
  });

  it('giảm số đã trả: báo "huỷ phiếu chi" trước, không xét trần trả hàng', async () => {
    const { service, receipts } = makeService(
      head({ status: ReceiptStatus.CONFIRMED, totalAmount: 10_000n, paidAmount: 8_000n }),
      9_000n,
    );
    await expect(service.updatePayment('r1', { paidAmount: 5_000 } as never, PM_A)).rejects.toThrow('huỷ phiếu chi');
    expect(receipts.returnedAmountOf).not.toHaveBeenCalled();
  });

  it('người không thấy giá vốn → 403, không khoá/ghi gì', async () => {
    const deps = setup(head({ status: ReceiptStatus.CONFIRMED }));
    const service = new GoodsReceiptPaymentService(
      deps.receipts as never,
      deps.locker,
      deps.debts as never,
      {} as never,
      { getGrantedCodes: jest.fn().mockResolvedValue(new Set(['supplier-debt:write'])) } as never,
      deps.transactions as never,
      deps.audit as never,
    );
    await expect(service.updatePayment('r1', { paidAmount: 5_000 } as never, PM_A)).rejects.toBeDefined();
    expect(deps.transactions.run).not.toHaveBeenCalled();
  });

  it('phiếu nháp không tra trả hàng (chưa thể có phiếu trả)', async () => {
    const { service, receipts } = makeService(head(), 4_000n);
    await service.updatePayment('r1', { paidAmount: 10_000 } as never, PM_A);
    expect(receipts.returnedAmountOf).not.toHaveBeenCalled();
  });

  it('không đổi số đã trả → không ghi', async () => {
    const { service, audit } = makeService(head());
    await service.updatePayment('r1', { paidAmount: 2_000 } as never, PM_A);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('GoodsReceiptMetaService — nhật ký', () => {
  it('GOODS_RECEIPT.META_UPDATED, branchIds [chi nhánh], nhãn mã phiếu, ngày dạng ISO', async () => {
    const deps = setup(head({ status: ReceiptStatus.CONFIRMED }));
    const service = new GoodsReceiptMetaService(
      deps.receipts as never,
      deps.locker,
      deps.transactions as never,
      deps.audit as never,
    );
    await service.updateMeta('r1', { receivedAt: '2026-11-01T03:00:00.000Z', note: 'Giao trễ' } as never, PM_A);
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const [, , entries] = deps.audit.record.mock.calls[0] as RecordCall;
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'GOODS_RECEIPT.META_UPDATED',
        entityId: 'r1',
        entityLabel: 'PN000001',
        branchIds: [A],
        searchTerms: ['PN000001'],
        before: { receiverId: 'u-old', receivedAt: null, note: null },
        after: { receiverId: 'u-old', receivedAt: '2026-11-01T03:00:00.000Z', note: 'Giao trễ' },
      }),
    ]);
  });
});
