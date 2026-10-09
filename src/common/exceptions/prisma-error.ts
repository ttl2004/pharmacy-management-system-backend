import { Prisma } from '@prisma/client';
import { ErrorCode } from '../types/error-code';
import { ErrorException } from './error.exception';

/**
 * Dịch lỗi vi phạm ràng buộc duy nhất của Prisma thành mã nghiệp vụ.
 *
 * Bắt `P2002` tại chỗ ghi thay vì kiểm tra tồn tại trước: hai request chạy song song vẫn cùng vượt
 * qua được bước kiểm tra rồi cùng ghi.
 */
export function rethrowDuplicate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'trường duy nhất';
    throw new ErrorException({
      code: ErrorCode.DUPLICATE_CODE,
      message: `Giá trị đã tồn tại: ${target}. Lưu ý bản ghi bị xoá mềm vẫn giữ giá trị duy nhất.`,
    });
  }
  throw error;
}
