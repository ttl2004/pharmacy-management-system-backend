import { Injectable } from '@nestjs/common';
import { ProductType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { invalidReference } from 'src/modules/feature-inventory/core/inventory.error';
import {
  DrugWarningsResult,
  InteractionCheckResult,
  InteractionServiceClient,
  InteractionSeverity,
} from './interaction-service.client';
import type { ProductRef, SafetyCheckResult, SafetyWarning, UncheckedProduct } from './safety.types';

const SEVERITY_RANK: Record<InteractionSeverity, number> = { major: 3, moderate: 2, minor: 1, unknown: 0 };
const SEVERITY_LABEL: Record<InteractionSeverity, string> = {
  major: 'Nghiêm trọng',
  moderate: 'Trung bình',
  minor: 'Nhẹ',
  unknown: 'Chưa rõ mức độ',
};

/** Hàng thuốc trong giỏ kèm số đăng ký của thuốc trong danh mục. Hàng thường (GOODS) không tra tương tác. */
interface CartDrug extends ProductRef {
  registrationNumber: string | null;
}

/**
 * Kiểm tra an toàn cho giỏ hàng: hàng hoá → thuốc trong danh mục (số đăng ký) → service tương tác (TTT-BE).
 * Kết quả trả theo **hàng hoá** của BE, không lộ số đăng ký cho FE phải tự ghép.
 */
@Injectable()
export class SafetyCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: InteractionServiceClient,
  ) {}

  async check(productIds: string[]): Promise<SafetyCheckResult> {
    const drugs = await this.loadCartDrugs(productIds);
    const withNumber = drugs.filter((drug) => drug.registrationNumber);
    const productsByNumber = groupByRegistrationNumber(withNumber);

    // Dưới 2 thuốc khác nhau thì không thể có cặp tương tác: không gọi service, để đơn 1 thuốc vẫn bán được khi service tắt.
    const result =
      productsByNumber.size >= 2
        ? await this.client.checkInteractions([...productsByNumber.keys()])
        : emptyCheckResult();

    const warnings = [
      ...drugDrugWarnings(result, productsByNumber),
      ...duplicateWarnings(result, productsByNumber),
      ...sameDrugWarnings(productsByNumber),
    ].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

    const majorWarningIds = warnings.filter((w) => w.severity === 'major').map((w) => w.id);
    return {
      warnings,
      hasMajor: majorWarningIds.length > 0,
      majorWarningIds,
      unchecked: uncheckedProducts(drugs, result, productsByNumber),
      checkedAt: new Date().toISOString(),
    };
  }

  /** Lưu ý bệnh lý / thức ăn theo từng hàng thuốc — chỉ để tham khảo, không chặn bán. */
  async drugWarnings(productIds: string[]) {
    const drugs = await this.loadCartDrugs(productIds);
    const numbers = [...new Set(drugs.map((d) => d.registrationNumber).filter((n): n is string => !!n))];
    const result: DrugWarningsResult = numbers.length
      ? await this.client.getDrugWarnings(numbers)
      : { drugs: [], notFound: [] };
    const byNumber = new Map(result.drugs.map((drug) => [drug.registrationNumber, drug]));

    return drugs.map((drug) => {
      const found = drug.registrationNumber ? byNumber.get(drug.registrationNumber) : undefined;
      return {
        productId: drug.productId,
        name: drug.name,
        hasData: !!found,
        diseases: found?.diseases ?? [],
        foods: found?.foods ?? [],
      };
    });
  }

  private async loadCartDrugs(productIds: string[]): Promise<CartDrug[]> {
    const uniqueIds = [...new Set(productIds)];
    const products = await this.prisma.product.findMany({
      where: { id: { in: uniqueIds }, isDeleted: false },
      select: { id: true, name: true, type: true, drug: { select: { registrationNumber: true } } },
    });
    if (products.length !== uniqueIds.length) throw invalidReference('có hàng hoá không tồn tại');

    // Giữ thứ tự giỏ hàng để cảnh báo hiện "thuốc thêm trước + thuốc thêm sau".
    const byId = new Map(products.map((product) => [product.id, product]));
    return uniqueIds
      .map((id) => byId.get(id)!)
      .filter((product) => product.type === ProductType.DRUG)
      .map((product) => ({
        productId: product.id,
        name: product.name,
        registrationNumber: product.drug?.registrationNumber?.trim() || null,
      }));
  }
}

function emptyCheckResult(): InteractionCheckResult {
  return { interactions: [], duplicates: [], hasMajor: false, notFound: [], incomplete: [] };
}

function groupByRegistrationNumber(drugs: CartDrug[]): Map<string, ProductRef[]> {
  const groups = new Map<string, ProductRef[]>();
  for (const drug of drugs) {
    const list = groups.get(drug.registrationNumber!) ?? [];
    list.push({ productId: drug.productId, name: drug.name });
    groups.set(drug.registrationNumber!, list);
  }
  return groups;
}

function productsOf(numbers: string[], productsByNumber: Map<string, ProductRef[]>): ProductRef[] {
  return numbers.flatMap((number) => productsByNumber.get(number) ?? []);
}

/** Cặp tương tác. Cùng một cặp hoạt chất có thể đến từ nhiều cặp thuốc (3 thuốc trở lên) → gộp theo `id`. */
function drugDrugWarnings(
  result: InteractionCheckResult,
  productsByNumber: Map<string, ProductRef[]>,
): SafetyWarning[] {
  const byId = new Map<string, SafetyWarning>();
  for (const pair of result.interactions) {
    const products = productsOf([pair.drug1.registrationNumber, pair.drug2.registrationNumber], productsByNumber);
    const existing = byId.get(pair.id);
    if (existing) {
      existing.products = uniqueProducts([...existing.products, ...products]);
      continue;
    }
    byId.set(pair.id, {
      id: pair.id,
      kind: 'DRUG_DRUG',
      severity: pair.severity,
      products,
      ingredients: [pair.ingredient1, pair.ingredient2],
      description: pair.description,
      management: pair.management,
      summary: `${SEVERITY_LABEL[pair.severity]}: ${products.map((p) => p.name).join(' + ')} (${pair.ingredient1} – ${pair.ingredient2})`,
    });
  }
  return [...byId.values()];
}

/** Nhiều thuốc khác nhau cùng một hoạt chất (vd Panadol + Panadol Extra) — nguy cơ quá liều, không chặn bán. */
function duplicateWarnings(
  result: InteractionCheckResult,
  productsByNumber: Map<string, ProductRef[]>,
): SafetyWarning[] {
  return result.duplicates.map((duplicate) => {
    const products = productsOf(
      duplicate.drugs.map((drug) => drug.registrationNumber),
      productsByNumber,
    );
    return {
      id: duplicate.id,
      kind: 'DUPLICATE_INGREDIENT',
      severity: 'moderate',
      products,
      ingredients: [duplicate.ingredient],
      description: '',
      management: '',
      summary: `Trùng hoạt chất ${duplicate.ingredient}: ${products.map((p) => p.name).join(' + ')}`,
    };
  });
}

/** Hai hàng hoá khác nhau cùng trỏ tới MỘT thuốc (cùng số đăng ký) — service không thấy vì chỉ nhận số đăng ký. */
function sameDrugWarnings(productsByNumber: Map<string, ProductRef[]>): SafetyWarning[] {
  return [...productsByNumber.entries()]
    .filter(([, products]) => products.length >= 2)
    .map(([number, products]) => ({
      id: `same-drug:${number}`,
      kind: 'DUPLICATE_INGREDIENT',
      severity: 'moderate',
      products,
      ingredients: [],
      description: '',
      management: '',
      summary: `Trùng thuốc (cùng số đăng ký ${number}): ${products.map((p) => p.name).join(' + ')}`,
    }));
}

function uncheckedProducts(
  drugs: CartDrug[],
  result: InteractionCheckResult,
  productsByNumber: Map<string, ProductRef[]>,
): UncheckedProduct[] {
  const noNumber: UncheckedProduct[] = drugs
    .filter((drug) => !drug.registrationNumber)
    .map((drug) => ({ productId: drug.productId, name: drug.name, reason: 'NO_REGISTRATION_NUMBER' }));
  const notFound: UncheckedProduct[] = productsOf(result.notFound, productsByNumber).map((product) => ({
    ...product,
    reason: 'NOT_IN_INTERACTION_DATA',
  }));
  const incomplete: UncheckedProduct[] = productsOf(result.incomplete, productsByNumber).map((product) => ({
    ...product,
    reason: 'INCOMPLETE_DATA',
  }));
  return [...noNumber, ...notFound, ...incomplete];
}

function uniqueProducts(products: ProductRef[]): ProductRef[] {
  return [...new Map(products.map((product) => [product.productId, product])).values()];
}
