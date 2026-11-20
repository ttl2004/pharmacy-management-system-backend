/**
 * Tồn THUỐC (mọi lô) của chi nhánh ngay sau từng bút toán trong một trang sổ kho.
 *
 * Số dư sau bút toán m = tồn hiện tại − Σ số lượng các bút toán CÙNG (chi nhánh, sản phẩm) đứng sau m theo đúng
 * thứ tự của danh sách (`createdAt` DESC, `id` DESC). Các bút toán đứng sau m chia thành các "đoạn" không giao nhau
 * giữa hai dòng liền kề của trang → mỗi đoạn chỉ quét sổ kho một lần (không quét lại từ m tới hiện tại cho từng dòng).
 * File này là phần thuần (không DB): dựng đoạn và cộng dồn.
 */
export interface BalanceRow {
  id: string;
  createdAt: Date;
  branchId: string;
  productId: string;
  quantity: number;
}

/** Đoạn `(row, upper]` theo (createdAt, id): `upper` là dòng liền trước của cùng sản phẩm trong trang, null = tới hiện tại. */
export interface BalanceSegment {
  id: string;
  branchId: string;
  productId: string;
  createdAt: Date;
  upperCreatedAt: Date | null;
  upperId: string | null;
}

export interface SegmentSums {
  /** Tổng tồn hiện tại của (chi nhánh, sản phẩm). */
  onHand: number;
  /** Σ số lượng bút toán trong đoạn `(row, upper]`. */
  segment: number;
}

const keyOf = (row: Pick<BalanceRow, 'branchId' | 'productId'>) => `${row.branchId}:${row.productId}`;

/** `rows` theo thứ tự danh sách (mới → cũ). */
export function buildBalanceSegments(rows: readonly BalanceRow[]): BalanceSegment[] {
  const previous = new Map<string, BalanceRow>();
  return rows.map((row) => {
    const upper = previous.get(keyOf(row));
    previous.set(keyOf(row), row);
    return {
      id: row.id,
      branchId: row.branchId,
      productId: row.productId,
      createdAt: row.createdAt,
      upperCreatedAt: upper?.createdAt ?? null,
      upperId: upper?.id ?? null,
    };
  });
}

/** Map id dòng → tồn thuốc sau bút toán đó. `rows` theo thứ tự danh sách; `sums` có đủ mọi dòng. */
export function accumulateProductBalance(
  rows: readonly BalanceRow[],
  sums: ReadonlyMap<string, SegmentSums>,
): Map<string, number> {
  const after = new Map<string, number>();
  const result = new Map<string, number>();
  for (const row of rows) {
    const sum = sums.get(row.id);
    if (!sum) throw new Error(`Thiếu tổng đoạn cho bút toán ${row.id}`);
    // Sau bút toán m = tồn hiện tại − Σ bút toán đứng sau m; "đứng sau m" = các đoạn của m và của mọi dòng mới hơn.
    const suffix = (after.get(keyOf(row)) ?? 0) + sum.segment;
    after.set(keyOf(row), suffix);
    result.set(row.id, sum.onHand - suffix);
  }
  return result;
}
