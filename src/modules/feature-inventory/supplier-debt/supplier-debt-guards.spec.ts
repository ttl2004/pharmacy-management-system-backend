import { ErrorCode } from 'src/common/types/error-code';
import { assertPaymentWithinDebt } from './supplier-debt-guards';

const A = 'branch-a';
const B = 'branch-b';

/** Nợ theo chi nhánh; `undefined` = toàn chuỗi (cộng các chi nhánh). */
function makeDebts(byBranch: Record<string, bigint>) {
  const chain = Object.values(byBranch).reduce((s, v) => s + v, 0n);
  return {
    debtOf: jest.fn((_s: string, branchId: string | undefined) =>
      Promise.resolve({ scoped: branchId ? (byBranch[branchId] ?? 0n) : chain, chain }),
    ),
  };
}

describe('assertPaymentWithinDebt — trần theo từng chi nhánh (N2)', () => {
  it('ADMIN: nợ chuỗi đủ nhưng chi nhánh A đã về 0 → chặn khoản trả vào phiếu của A', async () => {
    const debts = makeDebts({ [A]: 0n, [B]: 20_000_000n });
    await expect(
      assertPaymentWithinDebt(debts as never, {} as never, { kind: 'ALL' }, 's1', [
        { branchId: A, amount: 10_000_000n },
      ]),
    ).rejects.toMatchObject({ errorCode: ErrorCode.DEBT_EXCEEDED });
  });

  it('ADMIN: gộp theo chi nhánh — hai phiếu cùng chi nhánh A cộng dồn mới vượt', async () => {
    const debts = makeDebts({ [A]: 10n, [B]: 100n });
    await expect(
      assertPaymentWithinDebt(debts as never, {} as never, { kind: 'ALL' }, 's1', [
        { branchId: A, amount: 6n },
        { branchId: A, amount: 6n },
      ]),
    ).rejects.toMatchObject({ errorCode: ErrorCode.DEBT_EXCEEDED });
  });

  it('ADMIN: mỗi chi nhánh đủ nợ → qua', async () => {
    const debts = makeDebts({ [A]: 10n, [B]: 20n });
    await expect(
      assertPaymentWithinDebt(debts as never, {} as never, { kind: 'ALL' }, 's1', [
        { branchId: A, amount: 10n },
        { branchId: B, amount: 5n },
      ]),
    ).resolves.toBeUndefined();
  });

  it('quản lý chi nhánh: vẫn chặn khi vượt nợ chi nhánh mình', async () => {
    const debts = makeDebts({ [A]: 5n });
    await expect(
      assertPaymentWithinDebt(debts as never, {} as never, { kind: 'BRANCH', branchId: A }, 's1', [
        { branchId: A, amount: 6n },
      ]),
    ).rejects.toMatchObject({ errorCode: ErrorCode.DEBT_EXCEEDED });
  });
});
