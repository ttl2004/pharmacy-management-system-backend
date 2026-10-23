import { ReceiptStatus } from '@prisma/client';
import { LedgerKind } from './dtos/supplier-debt.query';

export interface LedgerReceiptSource {
  id: string;
  code: string;
  status: ReceiptStatus;
  confirmedAt: Date | null;
  totalAmount: bigint;
}

export interface LedgerPaymentSource {
  id: string;
  code: string;
  paidAt: Date;
  createdAt: Date;
  cancelledAt: Date | null;
  allocations: { amount: bigint; receipt: { id: string; branchId: string; confirmedAt: Date | null } }[];
}

export interface LedgerAdjustmentSource {
  id: string;
  code: string;
  branchId: string;
  adjustedAt: Date;
  createdAt: Date;
  delta: bigint;
  cancelledAt: Date | null;
}

export interface LedgerRow {
  kind: LedgerKind;
  id: string;
  code: string;
  at: Date;
  amount: number;
  balanceAfter: number;
  status: 'COMPLETED' | 'CANCELLED';
}

interface Draft extends Omit<LedgerRow, 'balanceAfter'> {
  /** Mốc xếp — khác mốc hiển thị `at` để thanh toán không đứng trước phiếu nhập nó trả. */
  sortAt: number;
  /** Lúc lập chứng từ: xếp phụ khi trùng mốc (giờ nhập tay chỉ tới phút). */
  created: number;
}

/**
 * Sổ nợ NCC dựng từ chứng từ (port `supplierLedger` của mock): số dư tính lại mỗi lần đọc nên huỷ chứng từ là số
 * tự đúng lại. Trả mới nhất trước; dòng huỷ giữ nguyên số dư.
 * - Phiếu nhập: CONFIRMED hoặc đã huỷ sau khi xác nhận (dòng CANCELLED), đã lọc theo phạm vi ở truy vấn.
 * - Thanh toán: −Σ phân bổ vào phiếu trong phạm vi (`inScope`); mốc xếp không sớm hơn lúc xác nhận các phiếu được trả
 *   và lúc lập các điều chỉnh có trước nó.
 * - Điều chỉnh: gắn chi nhánh lập, chỉ hiện điều chỉnh của chi nhánh trong phạm vi (`inScope`); xếp theo LÚC LẬP vì
 *   delta tính theo nợ CỦA CHI NHÁNH tại lúc lập.
 */
export function buildLedger(input: {
  receipts: LedgerReceiptSource[];
  payments: LedgerPaymentSource[];
  adjustments: LedgerAdjustmentSource[];
  inScope: (branchId: string) => boolean;
}): LedgerRow[] {
  const drafts: Draft[] = [];
  const adjustments = input.adjustments.filter((d) => input.inScope(d.branchId));
  const time = (value: Date | null) => value?.getTime() ?? 0;

  for (const r of input.receipts) {
    const at = r.confirmedAt ?? new Date(0);
    drafts.push({
      kind: 'RECEIPT', id: r.id, code: r.code, at, amount: Number(r.totalAmount),
      status: r.status === ReceiptStatus.CANCELLED ? 'CANCELLED' : 'COMPLETED',
      sortAt: at.getTime(), created: at.getTime(),
    });
  }

  for (const p of input.payments) {
    const scoped = p.allocations.filter((a) => input.inScope(a.receipt.branchId));
    const amount = scoped.reduce((sum, a) => sum + Number(a.amount), 0);
    if (amount <= 0) continue;
    const floors = [
      p.paidAt.getTime(),
      ...scoped.map((a) => time(a.receipt.confirmedAt)),
      ...adjustments.filter((d) => d.createdAt < p.createdAt).map((d) => d.createdAt.getTime()),
    ];
    drafts.push({
      kind: 'PAYMENT', id: p.id, code: p.code, at: p.paidAt, amount: -amount,
      status: p.cancelledAt ? 'CANCELLED' : 'COMPLETED',
      sortAt: Math.max(...floors), created: p.createdAt.getTime(),
    });
  }

  for (const d of adjustments) {
    drafts.push({
      kind: 'ADJUSTMENT', id: d.id, code: d.code, at: d.adjustedAt, amount: Number(d.delta),
      status: d.cancelledAt ? 'CANCELLED' : 'COMPLETED',
      sortAt: d.createdAt.getTime(), created: d.createdAt.getTime(),
    });
  }

  drafts.sort((a, b) => a.sortAt - b.sortAt || a.created - b.created || a.code.localeCompare(b.code));
  let balance = 0;
  return drafts
    .map(({ sortAt: _sortAt, created: _created, ...row }) => {
      if (row.status === 'COMPLETED') balance += row.amount;
      return { ...row, balanceAfter: balance };
    })
    .reverse();
}
