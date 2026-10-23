import { PaymentStatus } from '@prisma/client';
import type { ExpenseKind, ExpenseValueType } from './dtos/goods-receipt-expense.request';

/** Trần của cột `int` PostgreSQL — số lượng quy về đơn vị cơ bản không được vượt. */
export const PG_INT_MAX = 2_147_483_647;

export interface LineInput {
  quantity: number;
  conversionRate: number;
  importPrice: number;
  /** Giảm giá trên MỖI đơn vị nhập. Caller đã kiểm ≤ importPrice. */
  unitDiscount: number;
}

export interface LineAmounts {
  baseQuantity: number;
  /** = quantity × (importPrice − unitDiscount), khớp CHECK của DB. */
  totalPrice: bigint;
}

/**
 * Tiền và số lượng của một dòng phiếu nhập. `totalPrice` là `bigint` vì 500 hộp × 5 triệu đã vượt trần `int`.
 * Trả `null` khi số lượng quy đổi vượt trần cột `int` — caller báo lỗi 1002 cho đúng dòng.
 * Giá vốn / đơn vị cơ bản KHÔNG tính ở đây: phải phân bổ giảm giá phiếu + chi phí lúc xác nhận (`allocateUnitCosts`).
 */
export function computeLine(line: LineInput): LineAmounts | null {
  const baseQuantity = line.quantity * line.conversionRate;
  if (baseQuantity > PG_INT_MAX) return null;
  return {
    baseQuantity,
    totalPrice: BigInt(line.quantity) * BigInt(line.importPrice - line.unitDiscount),
  };
}

export interface ExpenseInput {
  code: string;
  name: string;
  kind: ExpenseKind;
  valueType: ExpenseValueType;
  value: number;
}

/** Bản chụp chi phí lưu JSONB: đầu vào + `amount` do server tính. */
export type ExpenseSnapshot = ExpenseInput & { amount: number };

export interface ReceiptTotals {
  subtotalAmount: bigint;
  discountAmount: bigint;
  discountPercent: number | null;
  vatAmount: bigint;
  supplierExpenseAmount: bigint;
  otherExpenseAmount: bigint;
  /** null khi phiếu không có chi phí. */
  expenses: ExpenseSnapshot[] | null;
  totalAmount: bigint;
  paidAmount: bigint;
  paymentStatus: PaymentStatus;
}

export type TotalsError =
  | 'DISCOUNT_EXCEEDS_SUBTOTAL'
  | 'DISCOUNT_BOTH_KINDS'
  | 'EXPENSE_VALUE_INVALID'
  | 'PAID_EXCEEDS_TOTAL';

/** `base × value / 100`, làm tròn nửa lên, hoàn toàn bằng số nguyên (value tối đa 2 số lẻ). */
function percentOf(base: bigint, value: number): bigint {
  const hundredths = BigInt(Math.round(value * 100));
  return (base * hundredths * 2n + 10_000n) / 20_000n;
}

/**
 * Tổng phiếu theo đúng công thức FE (`receiptAmounts`):
 * giảm giá = % × tiền hàng (hoặc VND, ≤ tiền hàng) → chi phí % tính trên (tiền hàng − giảm giá)
 * → Cần trả = tiền hàng − giảm giá + VAT + chi phí NCC. Chi phí "khác" không vào Cần trả.
 * Trùng công thức với CHECK trong DB.
 */
export function computeTotals(
  lineTotals: readonly bigint[],
  input: {
    discountAmount?: number;
    discountPercent?: number;
    vatAmount?: number;
    paidAmount?: number;
    expenses?: readonly ExpenseInput[];
  },
): ReceiptTotals | TotalsError {
  const subtotalAmount = lineTotals.reduce((sum, value) => sum + value, 0n);
  const hasPercent = input.discountPercent !== undefined;
  if (hasPercent && (input.discountAmount ?? 0) > 0) return 'DISCOUNT_BOTH_KINDS';
  const discountAmount = hasPercent
    ? percentOf(subtotalAmount, input.discountPercent as number)
    : BigInt(input.discountAmount ?? 0);
  if (discountAmount > subtotalAmount) return 'DISCOUNT_EXCEEDS_SUBTOTAL';

  const base = subtotalAmount - discountAmount;
  const snapshots: ExpenseSnapshot[] = [];
  let supplierExpenseAmount = 0n;
  let otherExpenseAmount = 0n;
  for (const expense of input.expenses ?? []) {
    if (expense.valueType === 'PCT' && expense.value > 100) return 'EXPENSE_VALUE_INVALID';
    if (expense.valueType === 'VND' && !Number.isInteger(expense.value)) return 'EXPENSE_VALUE_INVALID';
    const amount = expense.valueType === 'PCT' ? percentOf(base, expense.value) : BigInt(expense.value);
    if (expense.kind === 'SUPPLIER') supplierExpenseAmount += amount;
    else otherExpenseAmount += amount;
    snapshots.push({ ...expense, amount: Number(amount) });
  }

  const vatAmount = BigInt(input.vatAmount ?? 0);
  const paidAmount = BigInt(input.paidAmount ?? 0);
  const totalAmount = base + vatAmount + supplierExpenseAmount;
  if (paidAmount > totalAmount) return 'PAID_EXCEEDS_TOTAL';
  return {
    subtotalAmount,
    discountAmount,
    discountPercent: hasPercent ? (input.discountPercent as number) : null,
    vatAmount,
    supplierExpenseAmount,
    otherExpenseAmount,
    expenses: snapshots.length ? snapshots : null,
    totalAmount,
    paidAmount,
    paymentStatus: paymentStatusOf(paidAmount, totalAmount),
  };
}

/** Server tự suy trạng thái thanh toán — client không được gửi. Phiếu 0đ coi như đã trả đủ. */
export function paymentStatusOf(paid: bigint, total: bigint): PaymentStatus {
  if (paid >= total) return PaymentStatus.PAID;
  if (paid === 0n) return PaymentStatus.UNPAID;
  return PaymentStatus.PARTIAL;
}
