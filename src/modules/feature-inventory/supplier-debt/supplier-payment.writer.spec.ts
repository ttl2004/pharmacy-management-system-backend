import { PaymentMethod, SupplierPaymentSource } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { SupplierPaymentWriter } from './supplier-payment.writer';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function makeWriter(applied: Map<string, { paidAmount: bigint; branchId: string; code: string }>) {
  const payments = {
    create: jest.fn().mockResolvedValue({ id: 'pay1', amount: 7_000n }),
    markCancelled: jest.fn().mockResolvedValue(1),
    applyPaidDeltas: jest.fn().mockResolvedValue(applied),
    findActiveByReceipt: jest.fn(),
    findById: jest.fn(),
  };
  const codes = { next: jest.fn().mockResolvedValue('TTPN000001') };
  const writer = new SupplierPaymentWriter(payments as never, codes as never);
  return { writer, payments };
}

describe('SupplierPaymentWriter — entry nhật ký (caller gom và record một lần)', () => {
  it('create trả GOODS_RECEIPT.PAYMENT_UPDATED cho từng phiếu nhập (amount = delta) + SUPPLIER_PAYMENT.CREATED (amount = tổng)', async () => {
    const { writer } = makeWriter(
      new Map([
        ['r1', { paidAmount: 5_000n, branchId: A, code: 'PN000001' }],
        ['r2', { paidAmount: 2_000n, branchId: B, code: 'PN000002' }],
      ]),
    );

    const result = await writer.create(
      {} as never,
      {
        supplierId: 's1',
        branchId: A,
        paidAt: new Date(),
        method: PaymentMethod.CASH,
        note: null,
        source: SupplierPaymentSource.MANUAL,
        allocations: [
          { receiptId: 'r1', amount: 5_000n },
          { receiptId: 'r2', amount: 2_000n },
        ],
      },
      { actorId: 'u1' },
    );

    expect(result).toMatchObject({ id: 'pay1', code: 'TTPN000001', amount: 7_000n });
    expect(result.auditEntries).toEqual([
      expect.objectContaining({
        event: 'GOODS_RECEIPT.PAYMENT_UPDATED',
        entityType: 'goods_receipts',
        entityId: 'r1',
        entityLabel: 'PN000001',
        branchIds: [A],
        amount: 5_000n,
        searchTerms: ['PN000001', 'TTPN000001'],
        before: { paidAmount: '0' },
        after: { paidAmount: '5000' },
      }),
      expect.objectContaining({ entityId: 'r2', entityLabel: 'PN000002', branchIds: [B], amount: 2_000n }),
      expect.objectContaining({
        event: 'SUPPLIER_PAYMENT.CREATED',
        entityType: 'supplier_payments',
        entityId: 'pay1',
        entityLabel: 'TTPN000001',
        branchIds: [A],
        amount: 7_000n,
        searchTerms: ['TTPN000001', 'PN000001', 'PN000002'],
        after: expect.objectContaining({ code: 'TTPN000001', amount: '7000' }) as unknown,
      }),
    ]);
  });

  it('cancel trả SUPPLIER_PAYMENT.CANCELLED (amount = số tiền phiếu chi, có lý do) + PAYMENT_UPDATED delta âm', async () => {
    const { writer } = makeWriter(new Map([['r1', { paidAmount: 0n, branchId: A, code: 'PN000001' }]]));

    const entries = await writer.cancel(
      {} as never,
      {
        id: 'pay1',
        code: 'TTPN000001',
        branchId: A,
        amount: 5_000n,
        allocations: [{ receiptId: 'r1', amount: 5_000n, receipt: { id: 'r1', code: 'PN000001', branchId: A } }],
      },
      'Chi nhầm',
      { actorId: 'u1' },
    );

    expect(entries).toEqual([
      expect.objectContaining({
        event: 'GOODS_RECEIPT.PAYMENT_UPDATED',
        entityId: 'r1',
        amount: -5_000n,
        before: { paidAmount: '5000' },
        after: { paidAmount: '0' },
      }),
      expect.objectContaining({
        event: 'SUPPLIER_PAYMENT.CANCELLED',
        entityId: 'pay1',
        entityLabel: 'TTPN000001',
        branchIds: [A],
        amount: 5_000n,
        reason: 'Chi nhầm',
        before: { status: 'COMPLETED' },
        after: { status: 'CANCELLED' },
      }),
    ]);
  });

  it('huỷ phiếu chi đã huỷ → 1701, không trả entry', async () => {
    const { writer, payments } = makeWriter(new Map());
    payments.markCancelled.mockResolvedValue(0);
    await expect(
      writer.cancel({} as never, { id: 'pay1', code: 'TTPN000001', branchId: A, amount: 1n, allocations: [] }, null, {
        actorId: 'u1',
      }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_DOCUMENT_STATE });
  });

  it('releaseForReceiptCancel gom entry của mọi phiếu chi tự sinh bị huỷ theo', async () => {
    const { writer, payments } = makeWriter(new Map([['r1', { paidAmount: 0n, branchId: A, code: 'PN000001' }]]));
    payments.findActiveByReceipt.mockResolvedValue([
      { id: 'pay1', code: 'TTPN000001', source: SupplierPaymentSource.RECEIPT },
    ]);
    payments.findById.mockResolvedValue({
      id: 'pay1',
      code: 'TTPN000001',
      branchId: A,
      amount: 3_000n,
      allocations: [{ receiptId: 'r1', amount: 3_000n, receipt: { id: 'r1', code: 'PN000001', branchId: A } }],
    });

    const entries = await writer.releaseForReceiptCancel(
      {} as never,
      { id: 'r1', code: 'PN000001' },
      { actorId: 'u1' },
    );

    expect(entries.map((entry) => entry.event)).toEqual([
      'GOODS_RECEIPT.PAYMENT_UPDATED',
      'SUPPLIER_PAYMENT.CANCELLED',
    ]);
    expect(entries[1]).toMatchObject({ reason: 'Huỷ theo phiếu nhập PN000001', amount: 3_000n });
  });
});
