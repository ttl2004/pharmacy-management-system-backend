import { ErrorCode } from '../types/error-code';

export class ErrorException extends Error {
  errorCode: ErrorCode;

  constructor({ code, message }: { code: ErrorCode; message: string }) {
    super(message);
    this.errorCode = code;
  }
}
