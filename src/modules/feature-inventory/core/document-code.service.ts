import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DOCUMENT_CODE_FORMATS, DocumentKind } from './inventory.constants';

/** Độ dài phần số của mã: `PN000001`. Vượt 999 999 thì mã tự dài thêm, không vỡ. */
const CODE_DIGITS = 6;

/**
 * Sinh mã chứng từ kho từ SEQUENCE của PostgreSQL — không dùng `MAX(code) + 1` (hai request song song ra cùng mã).
 * Số lấy ra không quay lại khi transaction rollback, nên mã có thể hụt số: chấp nhận được, mã chỉ cần duy nhất.
 */
@Injectable()
export class DocumentCodeService {
  async next(tx: Prisma.TransactionClient, kind: DocumentKind): Promise<string> {
    const { prefix, sequence } = DOCUMENT_CODE_FORMATS[kind];
    // Tên sequence lấy từ hằng số trong code, không bao giờ từ input — an toàn khi ghép vào SQL.
    const [row] = await tx.$queryRaw<{ value: bigint }[]>(
      Prisma.sql`SELECT nextval(${Prisma.raw(`'"${sequence}"'`)}) AS value`,
    );
    return `${prefix}${row.value.toString().padStart(CODE_DIGITS, '0')}`;
  }
}
