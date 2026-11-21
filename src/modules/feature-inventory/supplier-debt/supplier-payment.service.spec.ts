import { PaymentMethod, ReceiptStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { SupplierPaymentService } from './supplier-payment.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUP = '33333333-3333-4333-8333-333333333333';

const actor = (role: AuthRole, branchId: string | null = null): RequestActor => ({
  user: { userId: `${role}-id`, sid: 's', email: null, role, branchId, roleLevel: 60 },
  ip: '127.0.0.1',
  userAgent: null,
  requestId: null,
});
const ADMIN = actor(AuthRole.ADMIN);

const paymentRow = {
  id: 'pay1',
  code: 'TTPN01',
  supplierId: SUP,
  branchId: A,
  amount: 1_000n,
  cancelledAt: null,
  allocations: [{ receiptId: 'r1', amount: 1_000n, receipt: { id: 'r1', code: 'PN01', branchId: A } }],
};

function makeService(debtOf: (branchId: string | undefined) => { scoped: bigint; chain: bigint }) {
  const payments = { findById: jest.fn().mockResolvedValue(paymentRow) };
  const debts = {
    lockSupplier: jest.fn().mockResolvedValue(true),
    branchUsable: jest.fn().mockResolvedValue(true),
    debtOf: jest.fn((_s: string, branchId: string | undefined) => Promise.resolve(debtOf(branchId))),
    findReceiptsForAllocation: jest.fn().mockResolvedValue([
      {
        id: 'r1',
        code: 'PN01',
        branchId: A,
        supplierId: SUP,
        status: ReceiptStatus.CONFIRMED,
        totalAmount: 10_000_000n,
        paidAmount: 0n,
      },
    ]),
  };
  const writer = {
    cancel: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'pay1', auditEntries: [] }),
  };
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx: {}, afterCommit: jest.fn() })) };
  const permissions = { getGrantedCodes: jest.fn().mockResolvedValue(new Set(['supplier-debt:write'])) };
  const audit = { record: jest.fn() };
  const service = new SupplierPaymentService(
    payments as never,
    debts as never,
    writer as never,
    transactions as never,
    permissions as never,
    audit as never,
  );
  return { service, payments, debts, writer };
}

describe('SupplierPaymentService.cancel — lock order (N1)', () => {
  it('khoá NCC TRƯỚC khi huỷ phiếu chi (đánh dấu huỷ / hoàn paidAmount phiếu nhập)', async () => {
    const { service, debts, writer } = makeService(() => ({ scoped: 0n, chain: 0n }));
    await service.cancel('pay1', {}, ADMIN);
    expect(debts.lockSupplier).toHaveBeenCalledWith({}, SUP);
    expect(debts.lockSupplier.mock.invocationCallOrder[0]).toBeLessThan(writer.cancel.mock.invocationCallOrder[0]);
  });

  it('phiếu chi không tồn tại → 1600, không khoá gì', async () => {
    const { service, payments, debts } = makeService(() => ({ scoped: 0n, chain: 0n }));
    payments.findById.mockResolvedValue(null);
    await expect(service.cancel('x', {}, ADMIN)).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
    expect(debts.lockSupplier).not.toHaveBeenCalled();
  });
});

describe('SupplierPaymentService.create — trần nợ từng chi nhánh (N2)', () => {
  const dto = {
    supplierId: SUP,
    branchId: B,
    paidAt: new Date().toISOString(),
    method: PaymentMethod.CASH,
    allocations: [{ receiptId: 'r1', amount: 10_000_000 }],
  };

  it('ADMIN: nợ chuỗi 20tr nhưng chi nhánh của phiếu nhập đã về 0 → 1714, không ghi phiếu chi', async () => {
    const { service, writer } = makeService((branchId) =>
      branchId === A ? { scoped: 0n, chain: 20_000_000n } : { scoped: 20_000_000n, chain: 20_000_000n },
    );
    await expect(service.create(dto as never, ADMIN)).rejects.toMatchObject({ errorCode: ErrorCode.DEBT_EXCEEDED });
    expect(writer.create).not.toHaveBeenCalled();
  });
});

describe('SupplierPaymentService.getDetail — phiếu chi nhiều chi nhánh (N7)', () => {
  const multi = {
    ...paymentRow,
    amount: 30_000_000n,
    allocations: [
      { receiptId: 'r1', amount: 10_000_000n, receipt: { id: 'r1', code: 'PN01', branchId: A } },
      { receiptId: 'r2', amount: 20_000_000n, receipt: { id: 'r2', code: 'PN02', branchId: B } },
    ],
  };

  it('quản lý chi nhánh A chỉ thấy dòng của A, amount = 10tr, partial = true, không canCancel', async () => {
    const { service, payments } = makeService(() => ({ scoped: 0n, chain: 0n }));
    payments.findById.mockResolvedValue(multi);
    const result = await service.getDetail('pay1', actor(AuthRole.PHARMACY_MANAGER, A));
    expect(result.allocations.map((a) => a.receiptId)).toEqual(['r1']);
    expect(result.amount).toBe(10_000_000);
    expect(result.partial).toBe(true);
    expect(result.canCancel).toBe(false);
  });

  it('ADMIN thấy đủ 30tr, partial = false', async () => {
    const { service, payments } = makeService(() => ({ scoped: 0n, chain: 0n }));
    payments.findById.mockResolvedValue(multi);
    const result = await service.getDetail('pay1', ADMIN);
    expect(result.allocations).toHaveLength(2);
    expect(result.amount).toBe(30_000_000);
    expect(result.partial).toBe(false);
  });

  it('phiếu một chi nhánh: quản lý thấy nguyên vẹn, partial = false', async () => {
    const { service } = makeService(() => ({ scoped: 0n, chain: 0n }));
    const result = await service.getDetail('pay1', actor(AuthRole.PHARMACY_MANAGER, A));
    expect(result).toMatchObject({ amount: 1_000, partial: false });
  });
});
