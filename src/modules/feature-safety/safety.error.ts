import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

export const safetyErrors = {
  /** 1804: còn cảnh báo nghiêm trọng chưa được dược sĩ duyệt. */
  approvalRequired: (summaries: string[]) =>
    new ErrorException({
      code: ErrorCode.INTERACTION_APPROVAL_REQUIRED,
      message: `Đơn có cảnh báo tương tác nghiêm trọng chưa được dược sĩ duyệt: ${summaries.join('; ')}`,
    }),

  /** 1804: không tra được dữ liệu tương tác mà đơn chưa có xác nhận kiểm tra thủ công. */
  manualCheckRequired: () =>
    new ErrorException({
      code: ErrorCode.INTERACTION_APPROVAL_REQUIRED,
      message: 'Không kiểm tra được tương tác thuốc — cần dược sĩ xác nhận đã kiểm tra thủ công trước khi thu tiền',
    }),

  /** 1805: phiếu duyệt sai chữ ký, hết hạn, hoặc không khớp giỏ hàng / người bán / chi nhánh. */
  approvalInvalid: (detail: string) =>
    new ErrorException({
      code: ErrorCode.INTERACTION_APPROVAL_INVALID,
      message: `Phiếu duyệt không hợp lệ: ${detail}`,
    }),

  /** 1806: sai tài khoản/mật khẩu dược sĩ hoặc người đó không có quyền duyệt (gộp một thông báo, không lộ lý do). */
  approverInvalid: () =>
    new ErrorException({
      code: ErrorCode.INTERACTION_APPROVER_INVALID,
      message: 'Tài khoản dược sĩ không đúng hoặc không có quyền duyệt cảnh báo tương tác',
    }),
};
