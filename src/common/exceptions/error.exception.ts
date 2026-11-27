import { ErrorCode } from '../types/error-code';

export class ErrorException extends Error {
  errorCode: ErrorCode;
  /** Dữ liệu kèm lỗi cho FE (vd. danh sách thuốc trùng số đăng ký). Chỉ có trong body lỗi khi được đặt. */
  details?: Record<string, unknown>;

  constructor({ code, message, details }: { code: ErrorCode; message: string; details?: Record<string, unknown> }) {
    super(message);
    this.errorCode = code;
    if (details !== undefined) this.details = details;
  }
}
