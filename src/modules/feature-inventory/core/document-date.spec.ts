import { ErrorCode } from 'src/common/types/error-code';
import { assertDocumentDate, DOCUMENT_BACKDATE_DAYS } from './document-date';

// 18/11/2026 10:00 giờ VN
const NOW = new Date('2026-11-18T03:00:00.000Z');
const vn = (iso: string) => new Date(`${iso}+07:00`);

describe('assertDocumentDate (L9): không ở tương lai, lùi tối đa 7 ngày', () => {
  it('cho phép: bây giờ, sáng nay, đúng 7 ngày trước (00:00 ngày 11/11 giờ VN), lệch đồng hồ ≤ 60 giây', () => {
    expect(DOCUMENT_BACKDATE_DAYS).toBe(7);
    for (const date of [NOW, vn('2026-11-18T00:00:00'), vn('2026-11-11T00:00:00'), new Date(NOW.getTime() + 59_000)]) {
      expect(() => assertDocumentDate(date, 'Ngày chi', NOW)).not.toThrow();
    }
  });

  it('chặn: 23:59 ngày 10/11 giờ VN (quá 7 ngày), năm 2020, tương lai > 60 giây, năm 2062', () => {
    for (const date of [
      vn('2026-11-10T23:59:59'),
      vn('2020-01-01T00:00:00'),
      new Date(NOW.getTime() + 61_000),
      vn('2062-11-18T10:00:00'),
    ]) {
      expect(() => assertDocumentDate(date, 'Ngày chi', NOW)).toThrow(
        expect.objectContaining({ errorCode: ErrorCode.HTTP_BAD_REQUEST }) as Error,
      );
    }
  });

  it('thông điệp nêu rõ tên trường', () => {
    expect(() => assertDocumentDate(vn('2020-01-01T00:00:00'), 'Ngày chứng từ', NOW)).toThrow(/Ngày chứng từ.*7 ngày/);
    expect(() => assertDocumentDate(vn('2062-01-01T00:00:00'), 'Ngày chứng từ', NOW)).toThrow(
      /Ngày chứng từ.*tương lai/,
    );
  });
});
