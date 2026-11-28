import type { GoodsReceiptDetail, ReceiptPage } from './repositories/goods-receipt.repository';

/**
 * Ẩn tiền của phiếu nhập với người không thấy được giá vốn (K8, nhân viên bán hàng): đơn giá, thành tiền, chiết
 * khấu, chi phí, tổng, đã trả. Giữ nguyên số lượng, hàng, lô, ngày, NCC, trạng thái phiếu và trạng thái thanh toán
 * (không phải giá). Trường số vẫn có mặt trong JSON, giá trị = null; danh sách chi phí = [] (FE `.map` không vỡ).
 */
const NO_MONEY = {
  subtotalAmount: null,
  discountAmount: null,
  discountPercent: null,
  vatAmount: null,
  supplierExpenseAmount: null,
  otherExpenseAmount: null,
  totalAmount: null,
  paidAmount: null,
} as const;

export function maskReceiptPage(page: ReceiptPage) {
  return {
    ...page,
    hits: page.hits.map((row) => ({ ...row, ...NO_MONEY })),
    summary: { ...page.summary, totalAmount: null, subtotalAmount: null, discountAmount: null, paidAmount: null },
  };
}

export function maskReceiptDetail(detail: GoodsReceiptDetail) {
  return {
    ...detail,
    ...NO_MONEY,
    returnedAmount: null,
    expenses: [],
    items: detail.items.map((item) => ({ ...item, importPrice: null, unitDiscount: null, totalPrice: null })),
  };
}
