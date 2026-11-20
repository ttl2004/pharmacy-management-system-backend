import type { AdjustmentDetail } from './repositories/adjustment.repository';

/**
 * Ẩn tiền của phiếu điều chỉnh với người không thấy được giá vốn (K8, nhân viên bán hàng): giá vốn từng dòng, giá
 * trả NCC, tiền hàng / chiết khấu / chi phí hoàn / tổng / NCC đã hoàn. Giữ số lượng, hàng, lô, NCC, trạng thái.
 * Trường vẫn có mặt trong JSON, giá trị = null (hình dạng response không đổi).
 */
const NO_MONEY = {
  goodsAmount: null,
  discountAmount: null,
  discountPercent: null,
  refundExpenseAmount: null,
  totalAmount: null,
  supplierPaid: null,
} as const;

export function maskAdjustmentRow<T extends object>(row: T) {
  return { ...row, ...NO_MONEY };
}

export function maskAdjustmentDetail(detail: AdjustmentDetail) {
  return {
    ...detail,
    ...NO_MONEY,
    refundExpenses: [],
    items: detail.items.map((item) => ({ ...item, unitCost: null, returnPrice: null })),
  };
}

/** Dòng tổng danh sách trả NCC. */
export const NO_RETURN_SUMMARY = {
  goodsAmount: null,
  discount: null,
  refundExpense: null,
  totalAmount: null,
  supplierPaid: null,
} as const;
