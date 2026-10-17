import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { documentErrors } from 'src/modules/feature-inventory/core/inventory.error';

export type SalesErrorCode = ErrorCode.PRESCRIPTION_REQUIRED | ErrorCode.PRODUCT_NOT_SELLABLE;

const salesMessages: Record<SalesErrorCode, string> = {
  [ErrorCode.PRESCRIPTION_REQUIRED]: 'Đơn có thuốc kê đơn — cần mã đơn thuốc và tên bác sĩ kê đơn',
  [ErrorCode.PRODUCT_NOT_SELLABLE]: 'Sản phẩm hoặc đơn vị bán đã ngừng kinh doanh',
};

/** Lỗi nghiệp vụ bán hàng — cùng khuôn với `inventoryError`: mã cố định, `detail` nói rõ dòng nào. */
export function salesError(code: SalesErrorCode, detail?: string): ErrorException {
  const base = salesMessages[code];
  return new ErrorException({ code, message: detail ? `${base}: ${detail}` : base });
}

/** "Đơn hàng không tồn tại" (1600) và "sai trạng thái" (1701). */
export const orderErrors = documentErrors('Đơn hàng');
