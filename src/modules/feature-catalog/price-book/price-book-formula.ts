/** Công thức giá của bảng: giá gốc ± số tiền hoặc ± %. */
export interface FormulaTerms {
  op: '+' | '-';
  amount: number;
  unit: 'vnd' | '%';
}

/** Trần của cột `price` (Int 32-bit) — công thức nhân % không được tràn cột. */
const MAX_PRICE = 2_147_483_647;

/**
 * Giá mới theo công thức, làm tròn đồng, không âm, không vượt trần cột.
 * `%` → gốc × (1 ± amount/100); `vnd` → gốc ± amount. Giống `applyFormula` của mock FE.
 */
export function computeFormulaPrice(basePrice: number, f: FormulaTerms): number {
  const delta = f.unit === '%' ? (basePrice * f.amount) / 100 : f.amount;
  const raw = f.op === '+' ? basePrice + delta : basePrice - delta;
  return Math.min(MAX_PRICE, Math.max(0, Math.round(raw)));
}
