import { DosageForm } from '@prisma/client';

/**
 * Bảng từ khoá (đã bỏ dấu, chữ thường) -> dạng bào chế. Thứ tự là thứ tự ưu tiên:
 * "sủi" trước "viên nén"; "tiêm" trước "bột" (bột pha tiêm là thuốc tiêm); "bột" trước "dung dịch uống"
 * (bột pha dung dịch uống là thuốc bột). Không bao giờ trả OTHER: không khớp thì null để người dùng chọn.
 */
const KEYWORD_TABLE: ReadonlyArray<readonly [RegExp, DosageForm]> = [
  [/\bsui\b/, DosageForm.EFFERVESCENT],
  [/\btiem\b/, DosageForm.INJECTION],
  [/\bvien\s+nen\b/, DosageForm.TABLET],
  [/\bvien\s+nang\b/, DosageForm.CAPSULE],
  [/\b(bot|com)\b/, DosageForm.POWDER],
  [/\b(si\s*ro|dung\s+dich\s+uong)\b/, DosageForm.SYRUP],
  [/\bdat\b/, DosageForm.SUPPOSITORY],
  [/\b(nho\s+mat|nho\s+mui|nho\s+tai|giot)\b/, DosageForm.DROPS],
  [/\bxit\b/, DosageForm.SPRAY],
  [/\bkem\b/, DosageForm.CREAM],
  [/\bmo\b/, DosageForm.OINTMENT],
];

/** Bỏ dấu tiếng Việt, đ -> d, chữ thường. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

/** Đoán dạng bào chế từ chuỗi "Dạng bào chế" trên tờ HDSD; không khớp thì null. */
export function guessDosageForm(text: string | null): DosageForm | null {
  if (!text?.trim()) return null;
  const normalized = normalize(text);
  for (const [pattern, form] of KEYWORD_TABLE) {
    if (pattern.test(normalized)) return form;
  }
  return null;
}
