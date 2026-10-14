import { PaymentStatus } from '@prisma/client';

/** Trần của cột `int` PostgreSQL — số lượng quy về đơn vị cơ bản không được vượt. */
export const PG_INT_MAX = 2_147_483_647;

export interface LineInput {
  quantity: number;
  conversionRate: number;
  importPrice: number;
}

export interface LineAmounts {
  baseQuantity: number;
  totalPrice: bigint;
  /** Giá vốn trên một đơn vị cơ bản, làm tròn về đồng (K1). */
  unitCost: number;
}

/**
 * Tiền và số lượng của một dòng phiếu nhập. `totalPrice` là `bigint` vì 500 hộp × 5 triệu đã vượt trần `int`.
 * Trả `null` khi số lượng quy đổi vượt trần cột `int` — caller báo lỗi 1002 cho đúng dòng.
 */
export function computeLine(line: LineInput): LineAmounts | null {
  const baseQuantity = line.quantity * line.conversionRate;
  if (baseQuantity > PG_INT_MAX) return null;
  return {
    baseQuantity,
    totalPrice: BigInt(line.quantity) * BigInt(line.importPrice),
    unitCost: unitCostPerBase(line.importPrice, line.conversionRate),
  };
}

/**
 * K1: giá vốn / đơn vị cơ bản lưu `int`, làm tròn nửa lên. Hộp 30 viên 35.000đ → 1.167đ/viên (sai số ≤ 0,5đ/viên,
 * ghi rõ trong spec). Giá trị kho chính xác tuyệt đối thì tính lại từ `goods_receipt_items.totalPrice`.
 */
export function unitCostPerBase(importPrice: number, conversionRate: number): number {
  return Math.round(importPrice / conversionRate);
}

export interface ReceiptTotals {
  subtotalAmount: bigint;
  discountAmount: bigint;
  vatAmount: bigint;
  totalAmount: bigint;
  paidAmount: bigint;
  paymentStatus: PaymentStatus;
}

export type TotalsError = 'DISCOUNT_EXCEEDS_SUBTOTAL' | 'PAID_EXCEEDS_TOTAL';

/** Tổng phiếu = Σ dòng − chiết khấu + VAT. Trùng công thức với CHECK trong DB. */
export function computeTotals(
  lineTotals: readonly bigint[],
  input: { discountAmount?: number; vatAmount?: number; paidAmount?: number },
): ReceiptTotals | TotalsError {
  const subtotalAmount = lineTotals.reduce((sum, value) => sum + value, 0n);
  const discountAmount = BigInt(input.discountAmount ?? 0);
  const vatAmount = BigInt(input.vatAmount ?? 0);
  const paidAmount = BigInt(input.paidAmount ?? 0);
  if (discountAmount > subtotalAmount) return 'DISCOUNT_EXCEEDS_SUBTOTAL';
  const totalAmount = subtotalAmount - discountAmount + vatAmount;
  if (paidAmount > totalAmount) return 'PAID_EXCEEDS_TOTAL';
  return {
    subtotalAmount,
    discountAmount,
    vatAmount,
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
