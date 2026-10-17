import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

export type InventoryErrorCode =
  | ErrorCode.INSUFFICIENT_STOCK
  | ErrorCode.INVALID_DOCUMENT_STATE
  | ErrorCode.BATCH_EXPIRED
  | ErrorCode.BATCH_EXPIRY_MISMATCH
  | ErrorCode.BATCH_NOT_AVAILABLE
  | ErrorCode.TRANSFER_SAME_BRANCH
  | ErrorCode.BRANCH_INACTIVE
  | ErrorCode.BATCH_ALREADY_MOVED
  | ErrorCode.DOCUMENT_LINE_LIMIT
  | ErrorCode.PRODUCT_HAS_STOCK
  | ErrorCode.SUPPLIER_INACTIVE
  | ErrorCode.STOCK_TAKE_PENDING
  | ErrorCode.RECALL_ADMIN_ONLY;

const inventoryMessages: Record<InventoryErrorCode, string> = {
  [ErrorCode.INSUFFICIENT_STOCK]: 'Tồn kho của lô không đủ',
  [ErrorCode.INVALID_DOCUMENT_STATE]: 'Chứng từ không ở trạng thái cho phép thao tác này',
  [ErrorCode.BATCH_EXPIRED]: 'Lô đã hết hạn sử dụng',
  [ErrorCode.BATCH_EXPIRY_MISMATCH]: 'Số lô đã tồn tại với hạn dùng khác',
  [ErrorCode.BATCH_NOT_AVAILABLE]: 'Lô đang bị khoá, bị thu hồi hoặc đã hết hạn',
  [ErrorCode.TRANSFER_SAME_BRANCH]: 'Chi nhánh nhận phải khác chi nhánh gửi',
  [ErrorCode.BRANCH_INACTIVE]: 'Chi nhánh đã ngừng hoạt động',
  [ErrorCode.BATCH_ALREADY_MOVED]: 'Lô đã phát sinh xuất kho, không thể huỷ phiếu nhập',
  [ErrorCode.DOCUMENT_LINE_LIMIT]: 'Chứng từ vượt quá số dòng cho phép',
  [ErrorCode.PRODUCT_HAS_STOCK]: 'Sản phẩm đã phát sinh tồn kho hoặc chứng từ kho',
  [ErrorCode.SUPPLIER_INACTIVE]: 'Nhà cung cấp đã ngừng hợp tác',
  [ErrorCode.STOCK_TAKE_PENDING]: 'Lô đang có phiếu kiểm kê nháp chưa xác nhận hoặc huỷ',
  [ErrorCode.RECALL_ADMIN_ONLY]: 'Chỉ ADMIN được mở khoá hoặc hạ mức lô đã thu hồi',
};

/**
 * Lỗi nghiệp vụ kho. Dùng `ErrorException` (HTTP 400) như các module CRUD; `detail` nối thêm vào thông báo để
 * người dùng biết dòng/lô nào gây lỗi, mã lỗi vẫn cố định cho giao diện bắt.
 */
export function inventoryError(code: InventoryErrorCode, detail?: string): ErrorException {
  const base = inventoryMessages[code];
  return new ErrorException({ code, message: detail ? `${base}: ${detail}` : base });
}

/** "Tham chiếu không hợp lệ" (1602): id trỏ tới bản ghi không có hoặc không thuộc phạm vi thao tác. */
export function invalidReference(detail: string): ErrorException {
  return new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: `Tham chiếu không hợp lệ: ${detail}` });
}

/** Dữ liệu gửi lên sai (1002) mà DTO không tự kiểm được — vd. bắt buộc tuỳ loại phiếu. */
export function badRequest(message: string): ErrorException {
  return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
}

/** Lỗi chung của một loại chứng từ kho; chỉ khác tên chứng từ trong thông báo "không tồn tại". */
export function documentErrors(documentName: string) {
  return {
    notFound: (): ErrorException =>
      new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: `${documentName} không tồn tại` }),
    /** Không có `status`: phiếu vừa bị request khác chiếm (bấm đúp) — điều kiện chuyển trạng thái trả về 0 dòng. */
    wrongState: (status?: string): ErrorException =>
      inventoryError(
        ErrorCode.INVALID_DOCUMENT_STATE,
        status ? `phiếu đang ở trạng thái ${status}` : 'phiếu vừa được người khác xử lý',
      ),
  };
}

/** Một lô chỉ được xuất hiện một lần trong chứng từ (ledger và intake cần mỗi lô một dòng). */
export function assertNoDuplicateBatches(batchIds: readonly string[]): void {
  if (new Set(batchIds).size !== batchIds.length) {
    throw badRequest('Một lô chỉ được xuất hiện một lần trong phiếu');
  }
}
