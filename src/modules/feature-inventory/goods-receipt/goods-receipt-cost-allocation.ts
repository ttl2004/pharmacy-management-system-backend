/**
 * Phân bổ `adj` (âm = giảm giá phiếu, dương = chi phí) vào giá trị từng dòng theo tỷ lệ thành tiền.
 * Tổng thành tiền = 0 (hàng 0đ) → chia theo `zeroWeights` (số lượng cơ bản). Dòng cuối nhận phần lẻ.
 * Port nguyên `allocateLineValues` của FE (`lib/goods-receipt-amounts.ts`) để BE và mock cho cùng giá vốn.
 */
export function allocateLineValues(lineAmounts: number[], zeroWeights: number[], adj: number): number[] {
  const total = lineAmounts.reduce((sum, amount) => sum + amount, 0);
  const weights = total > 0 ? lineAmounts : zeroWeights;
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0 || adj === 0) return [...lineAmounts];
  let used = 0;
  return lineAmounts.map((amount, index) => {
    const share = index === lineAmounts.length - 1 ? adj - used : Math.round((adj * weights[index]) / weightSum);
    used += share;
    return Math.max(0, amount + share);
  });
}

export interface CostLine {
  totalPrice: bigint;
  baseQuantity: number;
}

/**
 * Giá vốn / đơn vị cơ bản của từng dòng sau khi phân bổ `supplierExpense + otherExpense − discount` (Q7).
 * VAT không vào giá vốn. `unitCost = round(giá trị dòng đã phân bổ / baseQuantity)`.
 */
export function allocateUnitCosts(lines: readonly CostLine[], adj: number): number[] {
  const values = allocateLineValues(
    lines.map((line) => Number(line.totalPrice)),
    lines.map((line) => line.baseQuantity),
    adj,
  );
  return values.map((value, index) => Math.round(value / lines[index].baseQuantity));
}
