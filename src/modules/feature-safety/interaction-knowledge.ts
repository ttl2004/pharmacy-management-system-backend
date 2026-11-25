import type { DiseaseRow, FoodRow, InteractionRow, MappingRow } from './interaction-knowledge.repository';
import type {
  DiseaseWarningItem,
  DrugWarnings,
  DrugWarningsResult,
  DuplicateIngredient,
  FoodWarningItem,
  InteractionCheckResult,
  InteractionDrugRef,
  InteractionPair,
  InteractionSeverity,
} from './interaction.types';

/*
 * Tra tương tác thuốc theo số đăng ký — bản chuyển từ service TTT-BE (Python, app/services/interaction_service.py,
 * drug_warning_service.py, app/knowledge/*) sang BE, đọc 4 bảng DDInter thay cho file CSV.
 * Kết quả phải GIỐNG HỆT TTT-BE (mã cảnh báo, thứ tự, notFound/incomplete) vì phiếu duyệt của dược sĩ đối chiếu theo mã.
 * Chỉ là hàm thuần trên các dòng mà `InteractionKnowledgeRepository` đọc về (một câu SQL cho cả giỏ).
 */

const SEVERITY_RANK: Record<InteractionSeverity, number> = { major: 3, moderate: 2, minor: 1, unknown: 0 };
const SEVERITIES = new Set<string>(Object.keys(SEVERITY_RANK));

interface Ingredient {
  ddinterId: string | null;
  ddinterName: string | null;
}

interface MappedIngredient {
  ddinterId: string;
  ddinterName: string;
}

interface KnowledgeDrug {
  registrationNumber: string;
  name: string;
  ingredients: Ingredient[];
}

interface InteractionDetail {
  severity: InteractionSeverity;
  description: string;
  management: string;
}

/** Kết quả rỗng khi không cần tra (giỏ dưới 2 thuốc khác nhau). */
export function emptyCheckResult(): InteractionCheckResult {
  return { interactions: [], duplicates: [], hasMajor: false, notFound: [], incomplete: [] };
}

/** `registrationNumbers`: số đăng ký theo thứ tự giỏ; `mapping`/`interactionRows`: dòng DB của đúng các số đó. */
export function buildInteractionCheck(
  registrationNumbers: string[],
  mapping: MappingRow[],
  interactionRows: InteractionRow[],
): InteractionCheckResult {
  const { drugs, notFound } = findDrugs(registrationNumbers, toDrugs(mapping));
  const interactions = findInteractionPairs(drugs, toInteractionMap(interactionRows));
  return {
    interactions,
    duplicates: findDuplicateIngredients(drugs),
    hasMajor: interactions.some((pair) => pair.severity === 'major'),
    notFound,
    incomplete: drugs.filter((drug) => !isFullyMapped(drug)).map((drug) => drug.registrationNumber),
  };
}

export function buildDrugWarnings(
  registrationNumbers: string[],
  mapping: MappingRow[],
  diseaseRows: DiseaseRow[],
  foodRows: FoodRow[],
): DrugWarningsResult {
  const { drugs, notFound } = findDrugs(registrationNumbers, toDrugs(mapping));
  const diseasesById = groupBy(diseaseRows, (row) => row.drugId.trim());
  const foodsById = groupBy(foodRows, (row) => row.drugId.trim());
  return {
    drugs: drugs.map((drug) => drugWarnings(drug, diseasesById, foodsById)),
    notFound,
  };
}

/** DDInter ghi 'Major' / 'Moderate' / 'Minor' / 'Unknown'. Giá trị lạ coi là chưa rõ. */
export function parseSeverity(value: string | null | undefined): InteractionSeverity {
  const normalized = (value ?? '').trim().toLowerCase();
  return SEVERITIES.has(normalized) ? (normalized as InteractionSeverity) : 'unknown';
}

/** Khoá không phụ thuộc thứ tự: (A, B) và (B, A) là cùng một cặp. So sánh chuỗi như Python. */
export function pairKey(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** DDInter ghi 'None' hoặc '-' khi không có nội dung. */
function cleanText(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  return text === 'None' || text === '-' ? '' : text;
}

function toDrugs(mapping: MappingRow[]): Map<string, KnowledgeDrug> {
  const drugs = new Map<string, KnowledgeDrug>();
  for (const row of mapping) {
    const registrationNumber = row.registrationNumber.trim();
    if (!registrationNumber) continue;
    let drug = drugs.get(registrationNumber);
    if (!drug) {
      drug = { registrationNumber, name: row.drugName.trim(), ingredients: [] };
      drugs.set(registrationNumber, drug);
    }
    if (!row.ingredientOrder) continue; // dòng 'no_ingredient': thuốc không ghi thành phần
    const ddinterId = (row.ddinterId ?? '').trim() || null;
    drug.ingredients.push({ ddinterId, ddinterName: ddinterId ? (row.ddinterDrug ?? '').trim() : null });
  }
  return drugs;
}

function toInteractionMap(rows: InteractionRow[]): Map<string, InteractionDetail> {
  const details = new Map<string, InteractionDetail>();
  for (const row of rows) {
    details.set(pairKey(row.ddinterIdA.trim(), row.ddinterIdB.trim()).join('|'), {
      severity: parseSeverity(row.level),
      description: cleanText(row.interaction),
      management: cleanText(row.management),
    });
  }
  return details;
}

/** Bỏ số đăng ký trùng (giữ thứ tự gửi lên); tra theo bản đã cắt khoảng trắng, `notFound` trả nguyên văn. */
function findDrugs(registrationNumbers: string[], known: Map<string, KnowledgeDrug>) {
  const drugs: KnowledgeDrug[] = [];
  const notFound: string[] = [];
  for (const registrationNumber of new Set(registrationNumbers)) {
    const drug = known.get(registrationNumber.trim());
    if (drug) drugs.push(drug);
    else notFound.push(registrationNumber);
  }
  return { drugs, notFound };
}

function mappedIngredients(drug: KnowledgeDrug): MappedIngredient[] {
  return drug.ingredients.filter((i): i is MappedIngredient => !!i.ddinterId);
}

/** false khi thuốc không có hoạt chất nào hoặc còn hoạt chất chưa map → kết quả kiểm tra có thể thiếu. */
function isFullyMapped(drug: KnowledgeDrug): boolean {
  return drug.ingredients.length > 0 && drug.ingredients.every((i) => !!i.ddinterId);
}

function toDrugRef(drug: KnowledgeDrug): InteractionDrugRef {
  return { registrationNumber: drug.registrationNumber, name: drug.name };
}

/** So từng cặp thuốc khác nhau, rồi từng cặp hoạt chất của hai thuốc đó. */
function findInteractionPairs(drugs: KnowledgeDrug[], details: Map<string, InteractionDetail>): InteractionPair[] {
  const pairs: InteractionPair[] = [];
  drugs.forEach((first, index) => {
    for (const second of drugs.slice(index + 1)) {
      for (const firstIngredient of mappedIngredients(first)) {
        for (const secondIngredient of mappedIngredients(second)) {
          // Cùng hoạt chất không phải tương tác — đã báo ở phần trùng hoạt chất
          if (firstIngredient.ddinterId === secondIngredient.ddinterId) continue;
          const [low, high] = pairKey(firstIngredient.ddinterId, secondIngredient.ddinterId);
          const detail = details.get(`${low}|${high}`);
          if (!detail) continue;
          pairs.push({
            id: `ddi:${low}:${high}`,
            severity: detail.severity,
            drug1: toDrugRef(first),
            drug2: toDrugRef(second),
            ingredient1: firstIngredient.ddinterName,
            ingredient2: secondIngredient.ddinterName,
            description: detail.description,
            management: detail.management,
          });
        }
      }
    }
  });
  // Nặng trước; cùng mức thì giữ thứ tự thuốc gửi lên (sort của JS là ổn định)
  return pairs.sort(bySeverityDesc);
}

/** Gom thuốc theo hoạt chất; hoạt chất nào có từ 2 thuốc trở lên là trùng. */
function findDuplicateIngredients(drugs: KnowledgeDrug[]): DuplicateIngredient[] {
  const drugsByIngredient = new Map<string, KnowledgeDrug[]>();
  const ingredientNames = new Map<string, string>();
  for (const drug of drugs) {
    for (const ingredient of mappedIngredients(drug)) {
      const same = drugsByIngredient.get(ingredient.ddinterId) ?? [];
      if (!same.includes(drug)) same.push(drug);
      drugsByIngredient.set(ingredient.ddinterId, same);
      ingredientNames.set(ingredient.ddinterId, ingredient.ddinterName);
    }
  }
  return [...drugsByIngredient.entries()]
    .filter(([, same]) => same.length >= 2)
    .map(([ddinterId, same]) => ({
      id: `dup:${ddinterId}`,
      ingredient: ingredientNames.get(ddinterId)!,
      drugs: same.map(toDrugRef),
    }));
}

function drugWarnings(
  drug: KnowledgeDrug,
  diseasesById: Map<string, DiseaseRow[]>,
  foodsById: Map<string, FoodRow[]>,
): DrugWarnings {
  const diseases: DiseaseWarningItem[] = [];
  const foods: FoodWarningItem[] = [];
  for (const ingredient of mappedIngredients(drug)) {
    for (const row of diseasesById.get(ingredient.ddinterId) ?? []) {
      diseases.push({
        ingredient: ingredient.ddinterName,
        severity: parseSeverity(row.severity),
        diseaseName: row.diseaseName.trim(),
        description: cleanText(row.description),
      });
    }
    for (const row of foodsById.get(ingredient.ddinterId) ?? []) {
      foods.push({
        ingredient: ingredient.ddinterName,
        severity: parseSeverity(row.severity),
        foodName: row.foodName.trim(),
        description: cleanText(row.description),
        management: cleanText(row.management),
      });
    }
  }
  return {
    registrationNumber: drug.registrationNumber,
    isFullyMapped: isFullyMapped(drug),
    diseases: diseases.sort(bySeverityDesc),
    foods: foods.sort(bySeverityDesc),
  };
}

function bySeverityDesc(a: { severity: InteractionSeverity }, b: { severity: InteractionSeverity }): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const list = groups.get(k) ?? [];
    list.push(row);
    groups.set(k, list);
  }
  return groups;
}
