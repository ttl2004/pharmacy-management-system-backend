import type { DosageForm } from '@prisma/client';
import { guessDosageForm } from './dosage-form-keywords';

/** 16 trường OCR, đúng thứ tự bảng ánh xạ trong design §5.5. */
export const OCR_FIELD_KEYS = [
  'so_dang_ky',
  'ten_thuoc',
  'hoat_chat_ham_luong',
  'dang_bao_che',
  'quy_cach_dong_goi',
  'chi_dinh',
  'chong_chi_dinh',
  'lieu_dung_cach_dung',
  'tac_dung_khong_mong_muon',
  'than_trong',
  'bao_quan',
  'nha_san_xuat',
  'tuong_tac_thuoc',
  'phu_nu_co_thai_cho_con_bu',
  'qua_lieu',
  'han_dung',
] as const;

export type OcrFieldKey = (typeof OCR_FIELD_KEYS)[number];

/** Các trường thuốc điền từ tờ HDSD (tên cột trên `Drug`). */
export type LeafletDrugFields = {
  registrationNumber: string | null;
  name: string | null;
  ingredients: string | null;
  strength: string | null;
  dosageFormText: string | null;
  packagingSpec: string | null;
  indications: string | null;
  contraindications: string | null;
  dosage: string | null;
  sideEffects: string | null;
  warnings: string | null;
  storage: string | null;
  manufacturerName: string | null;
  interactions: string | null;
  pregnancyLactation: string | null;
  overdose: string | null;
  shelfLife: string | null;
};

export type OcrStructuredIngredient = { ten: string; ham_luong: number | null; don_vi: string | null };

/** Phần `result` của extraction đã thành công. */
export type OcrResult = {
  fields: Partial<Record<OcrFieldKey, { value?: string | null }>>;
  structured?: { hoat_chat_ham_luong?: OcrStructuredIngredient[] | null } | null;
};

/** Khoá OCR <-> cột form, dùng cho cả hai chiều ánh xạ (trừ `hoat_chat_ham_luong` xử lý riêng). */
const SIMPLE_FIELD_MAP: ReadonlyArray<readonly [OcrFieldKey, keyof LeafletDrugFields]> = [
  ['so_dang_ky', 'registrationNumber'],
  ['ten_thuoc', 'name'],
  ['dang_bao_che', 'dosageFormText'],
  ['quy_cach_dong_goi', 'packagingSpec'],
  ['chi_dinh', 'indications'],
  ['chong_chi_dinh', 'contraindications'],
  ['lieu_dung_cach_dung', 'dosage'],
  ['tac_dung_khong_mong_muon', 'sideEffects'],
  ['than_trong', 'warnings'],
  ['bao_quan', 'storage'],
  ['nha_san_xuat', 'manufacturerName'],
  ['tuong_tac_thuoc', 'interactions'],
  ['phu_nu_co_thai_cho_con_bu', 'pregnancyLactation'],
  ['qua_lieu', 'overdose'],
  ['han_dung', 'shelfLife'],
];

const SEPARATOR = '; ';

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Số hàm lượng bỏ ".0" thừa: 500 -> "500", 2.5 -> "2.5". */
function formatNumber(value: number): string {
  return String(Number(value));
}

function formatStrength(item: OcrStructuredIngredient): string {
  if (item.ham_luong === null || item.ham_luong === undefined || !Number.isFinite(Number(item.ham_luong))) return '';
  return [formatNumber(item.ham_luong), item.don_vi?.trim()].filter(Boolean).join(' ');
}

/** Ánh xạ kết quả OCR sang trường form; trường trống hoặc OCR không có thì null. */
export function toLeafletDraftForm(result: OcrResult | null | undefined): {
  drug: LeafletDrugFields;
  dosageForm: DosageForm | null;
  raw: Record<OcrFieldKey, string>;
} {
  const raw = {} as Record<OcrFieldKey, string>;
  for (const key of OCR_FIELD_KEYS) raw[key] = result?.fields?.[key]?.value?.trim() ?? '';

  const drug: LeafletDrugFields = {
    registrationNumber: null,
    name: null,
    ingredients: null,
    strength: null,
    dosageFormText: null,
    packagingSpec: null,
    indications: null,
    contraindications: null,
    dosage: null,
    sideEffects: null,
    warnings: null,
    storage: null,
    manufacturerName: null,
    interactions: null,
    pregnancyLactation: null,
    overdose: null,
    shelfLife: null,
  };
  for (const [key, column] of SIMPLE_FIELD_MAP) drug[column] = blankToNull(raw[key]);

  const parsed = result?.structured?.hoat_chat_ham_luong;
  if (parsed && parsed.length > 0) {
    drug.ingredients = blankToNull(parsed.map((item) => item.ten.trim()).join(SEPARATOR));
    // Giữ ô trống cho hoạt chất thiếu hàm lượng để thứ tự vẫn khớp với `ingredients`.
    const strengths = parsed.map(formatStrength);
    drug.strength = strengths.some(Boolean) ? strengths.join(SEPARATOR) : null;
  } else {
    drug.ingredients = blankToNull(raw.hoat_chat_ham_luong);
  }

  return { drug, dosageForm: guessDosageForm(drug.dosageFormText), raw };
}

/** Ánh xạ ngược form -> 16 key để dựng `final_fields` gửi feedback; null thành "". */
export function toFinalFields(drug: LeafletDrugFields): Record<OcrFieldKey, string> {
  const final = {} as Record<OcrFieldKey, string>;
  for (const key of OCR_FIELD_KEYS) final[key] = '';
  for (const [key, column] of SIMPLE_FIELD_MAP) final[key] = drug[column]?.trim() ?? '';

  const ingredients = drug.ingredients?.trim() ?? '';
  const strength = drug.strength?.trim() ?? '';
  const names = ingredients ? ingredients.split(SEPARATOR) : [];
  const strengths = strength ? strength.split(SEPARATOR) : [];
  if (names.length > 0 && names.length === strengths.length) {
    final.hoat_chat_ham_luong = names.map((name, i) => `${name} ${strengths[i]}`.trim()).join(SEPARATOR);
  } else {
    final.hoat_chat_ham_luong = [ingredients, strength].filter(Boolean).join(' ');
  }
  return final;
}
