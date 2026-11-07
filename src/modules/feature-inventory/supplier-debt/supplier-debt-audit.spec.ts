import { PaymentMethod, ReceiptStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { SupplierDebtAdjustmentService } from './supplier-debt-adjustment.service';
import { SupplierPaymentService } from './supplier-payment.service';

const A = '11111111-1111-4111-8111-111111111111';
const PM_A: RequestActor = {
  user: { userId: 'pm-a', sid: 's', email: null, role: AuthRole.PHARMACY_MANAGER, branchId: A, roleLevel: 60 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: null,
};

type RecordCall = [unknown, Record<string, unknown>, Record<string, unknown>[]];
const transactions = () => ({ run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx: {} })) });

describe('SupplierDebtAdjustmentService — nhật ký', () => {
  const row = {
    id: 'adj1',
    code: 'DCN000001',
    supplierId: 's1',
    branchId: A,
    debtBefore: 10_000n,
    debtAfter: 7_000n,
    delta: -3_000n,
    cancelledAt: null,
  };

  function makeService() {
    const adjustments = {
      create: jest.fn().mockResolvedValue({ id: 'adj1' }),
      findById: jest.fn().mockResolvedValue(row),
      markCancelled: jest.fn().mockResolvedValue(1),
    };
    const debts = {
      lockSupplier: jest.fn().mockResolvedValue(true),
      branchUsable: jest.fn().mockResolvedValue(true),
      debtOf: jest.fn().mockResolvedValue({ scoped: 10_000n, chain: 10_000n }),
    };
    const codes = { next: jest.fn().mockResolvedValue('DCN000001') };
    const audit = { record: jest.fn() };
    const service = new SupplierDebtAdjustmentService(
      adjustments as never,
      debts as never,
      codes as never,
      transactions() as never,
      audit as never,
    );
    return { service, audit };
  }

  it('lập: SUPPLIER_DEBT.ADJUSTED, branchIds [chi nhánh], amount = delta (bigint, có dấu), nhãn = mã phiếu', async () => {
    const { service, audit } = makeService();
    await service.create(
      {
        supplierId: 's1',
        adjustedAt: new Date().toISOString(),
        expectedDebtBefore: 10_000,
        debtAfter: 7_000,
        note: 'Đối chiếu',
      } as never,
      PM_A,
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, auditActor, entries] = audit.record.mock.calls[0] as RecordCall;
    expect(auditActor).toMatchObject({ userId: 'pm-a', ip: '10.0.0.1' });
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'SUPPLIER_DEBT.ADJUSTED',
        entityType: 'supplier_debt_adjustments',
        entityId: 'adj1',
        entityLabel: 'DCN000001',
        branchIds: [A],
        searchTerms: ['DCN000001'],
        amount: -3_000n,
        after: expect.objectContaining({ debtBefore: '10000', debtAfter: '7000', delta: '-3000' }) as unknown,
      }),
    ]);
  });

  it('huỷ: SUPPLIER_DEBT.ADJUSTMENT_CANCELLED, amount = delta, lý do của lệnh huỷ', async () => {
    const { service, audit } = makeService();
    await service.cancel('adj1', { reason: ' Nhập nhầm ' }, PM_A);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'SUPPLIER_DEBT.ADJUSTMENT_CANCELLED',
        entityLabel: 'DCN000001',
        branchIds: [A],
        amount: -3_000n,
        reason: 'Nhập nhầm',
        before: { status: 'COMPLETED' },
        after: { status: 'CANCELLED' },
      }),
    ]);
  });
});

describe('SupplierPaymentService — nhật ký', () => {
  const paymentRow = {
    id: 'pay1',
    code: 'TTPN000001',
    branchId: A,
    amount: 5_000n,
    cancelledAt: null,
    allocations: [{ receiptId: 'r1', amount: 5_000n, receipt: { id: 'r1', code: 'PN000001', branchId: A } }],
  };

  function makeService() {
    const payments = { findById: jest.fn().mockResolvedValue(paymentRow) };
    const debts = {
      lockSupplier: jest.fn().mockResolvedValue(true),
      branchUsable: jest.fn().mockResolvedValue(true),
      findReceiptsForAllocation: jest.fn().mockResolvedValue([
        {
          id: 'r1',
          code: 'PN000001',
          status: ReceiptStatus.CONFIRMED,
          supplierId: 's1',
          branchId: A,
          totalAmount: 10_000n,
          paidAmount: 0n,
        },
      ]),
      debtOf: jest.fn().mockResolvedValue({ scoped: 10_000n, chain: 10_000n }),
    };
    const writer = {
      create: jest.fn().mockResolvedValue({
        id: 'pay1',
        code: 'TTPN000001',
        amount: 5_000n,
        auditEntries: [{ event: 'SUPPLIER_PAYMENT.CREATED' }, { event: 'GOODS_RECEIPT.PAYMENT_UPDATED' }],
      }),
      cancel: jest.fn().mockResolvedValue([{ event: 'SUPPLIER_PAYMENT.CANCELLED' }]),
    };
    const permissions = { getGrantedCodes: jest.fn().mockResolvedValue(new Set(['supplier-debt:write'])) };
    const audit = { record: jest.fn() };
    const service = new SupplierPaymentService(
      payments as never,
      debts as never,
      writer as never,
      transactions() as never,
      permissions as never,
      audit as never,
    );
    return { service, writer, audit };
  }

  it('lập phiếu chi: record MỘT lần với mọi entry writer trả về', async () => {
    const { service, writer, audit } = makeService();
    await service.create(
      {
        supplierId: 's1',
        paidAt: new Date().toISOString(),
        method: PaymentMethod.CASH,
        allocations: [{ receiptId: 'r1', amount: 5_000 }],
      } as never,
      PM_A,
    );
    expect(writer.create).toHaveBeenCalledWith({}, expect.anything(), { actorId: 'pm-a' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, auditActor, entries] = audit.record.mock.calls[0] as RecordCall;
    expect(auditActor).toMatchObject({ userId: 'pm-a', type: 'USER' });
    expect(entries.map((entry) => entry.event)).toEqual(['SUPPLIER_PAYMENT.CREATED', 'GOODS_RECEIPT.PAYMENT_UPDATED']);
  });

  it('huỷ phiếu chi: record MỘT lần với entry writer trả về', async () => {
    const { service, writer, audit } = makeService();
    await service.cancel('pay1', { reason: 'Chi nhầm' }, PM_A);
    expect(writer.cancel).toHaveBeenCalledWith({}, expect.objectContaining({ id: 'pay1' }), 'Chi nhầm', {
      actorId: 'pm-a',
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, , entries] = audit.record.mock.calls[0] as RecordCall;
    expect(entries).toEqual([{ event: 'SUPPLIER_PAYMENT.CANCELLED' }]);
  });
});
