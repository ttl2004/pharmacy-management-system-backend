import { PriceBookPolicy, RecordStatus } from '@prisma/client';
import type { PriceBookRow } from '../repositories/price-book.repository';

/** Công thức giá — đúng `priceBookFormulaSchema` của FE. */
export interface PriceBookFormulaResponse {
  base: string;
  op: '+' | '-';
  amount: number;
  unit: 'vnd' | '%';
}

/**
 * Một bảng giá — đúng `priceBookSchema` của FE (enum trả chữ thường để FE khỏi map), cộng `editable`: người gọi
 * có được sửa bảng này không (quyết định D2). FE ẩn ô sửa khi `editable = false`.
 */
export interface PriceBookResponse {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  status: 'active' | 'inactive';
  branchIds: string[];
  userIds: string[];
  outOfBookPolicy: 'allow' | 'warn' | 'block';
  formula?: PriceBookFormulaResponse;
  createdAt: string;
  itemCount: number;
  editable: boolean;
}

/** Bảng đang áp dụng cho POS kèm toàn bộ giá — đúng `applicablePriceBookSchema` của FE. */
export interface ApplicablePriceBookResponse extends PriceBookResponse {
  items: { priceBookId: string; drugId: string; unitId: string; price: number }[];
}

export function toPriceBookResponse(row: PriceBookRow, editable: boolean): PriceBookResponse {
  const hasFormula = row.formulaBase && row.formulaOp && row.formulaAmount !== null && row.formulaUnit;
  return {
    id: row.id,
    name: row.name,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    status: row.status === RecordStatus.ACTIVE ? 'active' : 'inactive',
    branchIds: row.branches.map((b) => b.branchId),
    userIds: row.users.map((u) => u.userId),
    outOfBookPolicy: row.outOfBookPolicy.toLowerCase() as PriceBookResponse['outOfBookPolicy'],
    formula: hasFormula
      ? {
          base: row.formulaBase!,
          op: row.formulaOp as '+' | '-',
          amount: row.formulaAmount!,
          unit: row.formulaUnit as 'vnd' | '%',
        }
      : undefined,
    createdAt: row.createdAt.toISOString(),
    itemCount: row._count.items,
    editable,
  };
}

/** Enum FE (chữ thường) → enum DB. */
export const POLICY_TO_DB: Record<'allow' | 'warn' | 'block', PriceBookPolicy> = {
  allow: PriceBookPolicy.ALLOW,
  warn: PriceBookPolicy.WARN,
  block: PriceBookPolicy.BLOCK,
};
