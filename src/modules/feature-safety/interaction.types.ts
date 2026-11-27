/**
 * Kết quả tra tương tác thuốc theo **số đăng ký lưu hành** — giữ ĐÚNG hình dạng mà service TTT-BE trả trước đây
 * (đã chuyển vào BE, đọc 4 bảng DDInter trong Postgres).
 */

export type InteractionSeverity = 'major' | 'moderate' | 'minor' | 'unknown';

export interface InteractionDrugRef {
  registrationNumber: string;
  name: string;
}

/** Một cặp hoạt chất tương tác giữa hai thuốc khác nhau trong danh sách gửi lên. */
export interface InteractionPair {
  /** `ddi:<mã nhỏ>:<mã lớn>` (so sánh chuỗi) — cố định theo cặp hoạt chất, dùng đối chiếu khi duyệt. */
  id: string;
  severity: InteractionSeverity;
  /** Thuốc đứng trước trong danh sách gửi lên. */
  drug1: InteractionDrugRef;
  drug2: InteractionDrugRef;
  /** Tên hoạt chất (DDInter) của drug1. */
  ingredient1: string;
  ingredient2: string;
  /** Cơ chế (tiếng Anh), rỗng nếu DDInter không có. */
  description: string;
  /** Cách xử trí, rỗng nếu DDInter không có. */
  management: string;
}

/** Nhiều thuốc có cùng một hoạt chất (nguy cơ quá liều). `id` = `dup:<mã DDInter>`. */
export interface DuplicateIngredient {
  id: string;
  ingredient: string;
  drugs: InteractionDrugRef[];
}

export interface InteractionCheckResult {
  /** Nặng trước; cùng mức thì giữ thứ tự thuốc gửi lên. */
  interactions: InteractionPair[];
  duplicates: DuplicateIngredient[];
  hasMajor: boolean;
  /** Số đăng ký không có trong dữ liệu — KHÔNG kiểm tra được. */
  notFound: string[];
  /** Thuốc không ghi thành phần hoặc còn hoạt chất chưa map sang DDInter — kết quả có thể thiếu. */
  incomplete: string[];
}

export interface DiseaseWarningItem {
  ingredient: string;
  severity: InteractionSeverity;
  diseaseName: string;
  description: string;
}

export interface FoodWarningItem {
  ingredient: string;
  severity: InteractionSeverity;
  foodName: string;
  description: string;
  management: string;
}

export interface DrugWarnings {
  registrationNumber: string;
  isFullyMapped: boolean;
  /** Nặng trước. */
  diseases: DiseaseWarningItem[];
  /** Nặng trước. */
  foods: FoodWarningItem[];
}

export interface DrugWarningsResult {
  drugs: DrugWarnings[];
  notFound: string[];
}
