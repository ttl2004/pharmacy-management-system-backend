import { DosageForm, Prisma, ProductType, RecordStatus } from '@prisma/client';
import { addDaysToDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { containsPattern } from 'src/common/utils/like-pattern.util';

/** Id chi nhánh, hoặc `'ALL'` = mọi chi nhánh. */
type LotScope = string;

/** Khớp `NO_LOCATION` của DTO (không import ngược để file SQL không phụ thuộc lớp DTO). */
const NO_LOCATION = 'none';

/** Bộ lọc hàng hoá không phụ thuộc chi nhánh, đã chuẩn hoá (mảng thật, chuỗi đã trim). */
export interface ProductListFilter {
  q?: string;
  searchField: 'code_name' | 'registration' | 'generic' | 'manufacturer';
  categoryIds: string[];
  dosageForms: DosageForm[];
  statuses: RecordStatus[];
  types: ProductType[];
  /** YYYY-MM-DD giờ VN, hai đầu tính trọn ngày. */
  createdFrom?: string;
  createdTo?: string;
  /** Có thể chứa `'none'` = hàng chưa gắn vị trí. */
  locationIds: string[];
  qCodeName?: string;
  qBarcode?: string;
  qRegistration?: string;
  qLot?: string;
  qGeneric?: string;
  qManufacturer?: string;
  qNote?: string;
  requiresPrescription?: boolean;
  trackBatches?: boolean;
  /** Bộ lọc cũ của `GET /product` (một giá trị) — vẫn nhận để tương thích ngược. */
  categoryId?: string;
  manufacturerId?: string;
  baseUnitId?: string;
}

/**
 * Bảng phụ mà điều kiện lọc cần: thuốc liên kết (`d`) và hãng (`m`). Bí danh hàng hoá luôn là `p`. Mỗi hàng hoá tối
 * đa một thuốc và một hãng nên LEFT JOIN không nhân dòng.
 */
export const PRODUCT_FILTER_JOINS = Prisma.sql`
  LEFT JOIN "drugs" d ON d."id" = p."drugId"
  LEFT JOIN "manufacturers" m ON m."id" = p."manufacturerId"`;

const anyIlike = (columns: Prisma.Sql[], text: string): Prisma.Sql => {
  const pattern = containsPattern(text);
  return Prisma.sql`(${Prisma.join(
    columns.map((c) => Prisma.sql`${c} ILIKE ${pattern}`),
    ' OR ',
  )})`;
};

/**
 * Cột chữ tiếng Việt (tên, hoạt chất, hãng, ghi chú): so sau khi BỎ DẤU cả hai vế, không phân biệt hoa thường — gõ
 * "khau trang" thấy "Khẩu trang", gõ "Hộp" thấy cả "Hợp". `f_unaccent` = `unaccent` bọc IMMUTABLE (migration
 * tim_kiem_khong_dau). Không dùng được index trigram (OR nhiều cột + EXISTS) nhưng bảng hàng hoá chỉ vài nghìn–vài chục
 * nghìn dòng nên quét tuần tự vẫn trong ngân sách (đo bằng `branch-product-list.perf.db-spec.ts`). Mã / mã vạch / số
 * đăng ký / số lô không có dấu → giữ `ILIKE` thường (rẻ hơn).
 */
const foldLike = (columns: Prisma.Sql[], text: string): Prisma.Sql => {
  const pattern = Prisma.sql`f_unaccent(${containsPattern(text)})`;
  return Prisma.sql`(${Prisma.join(
    columns.map((c) => Prisma.sql`f_unaccent(${c}) ILIKE ${pattern}`),
    ' OR ',
  )})`;
};

/** Mã vạch đơn vị bán (chưa xoá) khớp — quét bằng máy đọc mã vạch thường ra mã của hộp/vỉ. */
const unitBarcodeLike = (text: string) => Prisma.sql`EXISTS (
  SELECT 1 FROM "product_units" pu_bc
  WHERE pu_bc."productId" = p."id" AND pu_bc."isDeleted" = false AND pu_bc."barcode" ILIKE ${containsPattern(text)})`;

/** "31/12/2026" → "2026-12-31" để tìm hạn dùng theo cách người dùng gõ; chuỗi khác giữ nguyên. */
function toIsoDateText(text: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : text;
}

/**
 * Lô CÒN TỒN có số lô hoặc hạn dùng khớp. `lotBranchId` = chi nhánh đang xem; `'ALL'` = mọi chi nhánh.
 * Hạn dùng so ở dạng văn bản `YYYY-MM-DD` (người dùng gõ `DD/MM/YYYY` được đổi trước).
 */
function lotLike(text: string, lotBranchId: LotScope): Prisma.Sql {
  const branch = lotBranchId === 'ALL' ? Prisma.empty : Prisma.sql`AND lot."branchId" = ${lotBranchId}::uuid`;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "stock_batches" lot
    WHERE lot."productId" = p."id" AND lot."isDeleted" = false AND lot."quantityOnHand" > 0 ${branch}
      AND (lot."batchNumber" ILIKE ${containsPattern(text)}
           OR to_char(lot."expiryDate", 'YYYY-MM-DD') ILIKE ${containsPattern(toIsoDateText(text))}))`;
}

/** Ô tìm nhanh theo trường đã chọn. Mặc định: dược sĩ hay tra bằng mã, tên, mã vạch, hoạt chất hoặc số đăng ký. */
function quickSearch(q: string, field: ProductListFilter['searchField']): Prisma.Sql {
  switch (field) {
    case 'registration':
      return anyIlike([Prisma.sql`d."registrationNumber"`], q);
    case 'generic':
      return foldLike([Prisma.sql`d."ingredients"`, Prisma.sql`d."strength"`], q);
    case 'manufacturer':
      return foldLike([Prisma.sql`m."name"`, Prisma.sql`d."manufacturerName"`], q);
    default:
      return Prisma.sql`(${anyIlike(
        [Prisma.sql`p."code"`, Prisma.sql`p."barcode"`, Prisma.sql`d."registrationNumber"`],
        q,
      )} OR ${foldLike([Prisma.sql`p."name"`, Prisma.sql`p."shortName"`, Prisma.sql`d."ingredients"`], q)} OR ${unitBarcodeLike(q)})`;
  }
}

/**
 * Điều kiện WHERE trên hàng hoá `p` (cần `PRODUCT_FILTER_JOINS`). KHÔNG gồm điều kiện xoá mềm — người gọi tự quyết
 * (danh mục có chế độ xem hàng đã xoá). Mảng rỗng = không lọc. Cột chữ tiếng Việt so KHÔNG phân biệt dấu (`foldLike`), mã/mã vạch `ILIKE`.
 *
 * @param lotBranchId phạm vi lô cho ô `qLot`: chi nhánh đang xem, hoặc `'ALL'` (danh mục / toàn chuỗi).
 */
export function productFilterConditions(f: ProductListFilter, lotBranchId: LotScope): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  if (f.categoryIds.length) {
    // Chọn nhóm cha → gồm mọi nhóm con cháu (cây nhóm hàng nông, vài trăm dòng).
    c.push(Prisma.sql`p."categoryId" IN (
      WITH RECURSIVE tree AS (
        SELECT c0."id" FROM "categories" c0 WHERE c0."id" = ANY(${f.categoryIds}::uuid[])
        UNION
        SELECT ch."id" FROM "categories" ch JOIN tree t ON ch."parentId" = t."id"
      ) SELECT tree."id" FROM tree)`);
  }
  if (f.categoryId) c.push(Prisma.sql`p."categoryId" = ${f.categoryId}::uuid`);
  if (f.manufacturerId) c.push(Prisma.sql`p."manufacturerId" = ${f.manufacturerId}::uuid`);
  if (f.baseUnitId) c.push(Prisma.sql`p."baseUnitId" = ${f.baseUnitId}::uuid`);
  // So trên kiểu enum (không ép cột sang text) để planner dùng được thống kê cột — ước lượng sai số dòng ở đây làm
  // planner chọn nested loop cho các phép nối phía sau (đã đo: 490 ms thay vì 10 ms).
  if (f.dosageForms.length) c.push(Prisma.sql`p."dosageForm" = ANY(${f.dosageForms}::"DosageForm"[])`);
  if (f.statuses.length) c.push(Prisma.sql`p."status" = ANY(${f.statuses}::"RecordStatus"[])`);
  if (f.types.length) c.push(Prisma.sql`p."type" = ANY(${f.types}::"ProductType"[])`);
  if (f.requiresPrescription !== undefined) c.push(Prisma.sql`p."requiresPrescription" = ${f.requiresPrescription}`);
  if (f.trackBatches !== undefined) c.push(Prisma.sql`p."trackBatches" = ${f.trackBatches}`);
  if (f.createdFrom) c.push(Prisma.sql`p."createdAt" >= ${vietnamDayStartUtc(f.createdFrom)}`);
  if (f.createdTo) c.push(Prisma.sql`p."createdAt" < ${vietnamDayStartUtc(addDaysToDateOnly(f.createdTo, 1))}`);
  if (f.locationIds.length) {
    const ids = f.locationIds.filter((id) => id !== NO_LOCATION);
    const parts: Prisma.Sql[] = [];
    if (ids.length) {
      parts.push(Prisma.sql`EXISTS (SELECT 1 FROM "product_locations" pl
        WHERE pl."productId" = p."id" AND pl."locationId" = ANY(${ids}::uuid[]))`);
    }
    if (ids.length !== f.locationIds.length) {
      parts.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "product_locations" pl WHERE pl."productId" = p."id")`);
    }
    c.push(Prisma.sql`(${Prisma.join(parts, ' OR ')})`);
  }
  if (f.q) c.push(quickSearch(f.q, f.searchField));
  // Tìm nâng cao: các ô kết hợp AND, trong một ô là OR giữa các trường.
  if (f.qCodeName) {
    c.push(
      Prisma.sql`(${anyIlike([Prisma.sql`p."code"`], f.qCodeName)} OR ${foldLike(
        [Prisma.sql`p."name"`, Prisma.sql`p."shortName"`],
        f.qCodeName,
      )})`,
    );
  }
  if (f.qBarcode)
    c.push(Prisma.sql`(p."barcode" ILIKE ${containsPattern(f.qBarcode)} OR ${unitBarcodeLike(f.qBarcode)})`);
  if (f.qRegistration) c.push(anyIlike([Prisma.sql`d."registrationNumber"`], f.qRegistration));
  if (f.qLot) c.push(lotLike(f.qLot, lotBranchId));
  if (f.qGeneric) c.push(foldLike([Prisma.sql`d."ingredients"`, Prisma.sql`d."strength"`], f.qGeneric));
  if (f.qManufacturer) c.push(foldLike([Prisma.sql`m."name"`, Prisma.sql`d."manufacturerName"`], f.qManufacturer));
  if (f.qNote) c.push(foldLike([Prisma.sql`p."description"`, Prisma.sql`p."orderNote"`], f.qNote));
  return c;
}

/** Khoá sắp xếp không phụ thuộc chi nhánh (cột Danh mục hàng hoá cho bấm tiêu đề). */
export const CATALOG_SORT_KEYS = ['favourite', 'code', 'name', 'shortName', 'price', 'createdAt'] as const;
export type CatalogSortKey = (typeof CATALOG_SORT_KEYS)[number];

/** Giá bán chung của đơn vị cơ bản (chưa xoá) — cột "Giá bán". */
export const BASE_PRICE_SQL = Prisma.sql`(
  SELECT pu_bp."salePrice" FROM "product_units" pu_bp
  WHERE pu_bp."productId" = p."id" AND pu_bp."isBaseUnit" = true AND pu_bp."isDeleted" = false
  LIMIT 1)`;

/** Biểu thức sắp xếp của khoá danh mục. */
export function catalogSortExpr(key: CatalogSortKey): Prisma.Sql {
  switch (key) {
    case 'favourite':
      return Prisma.sql`p."isFavourite"`;
    case 'code':
      return Prisma.sql`p."code"`;
    case 'name':
      return Prisma.sql`p."name"`;
    case 'shortName':
      return Prisma.sql`p."shortName"`;
    case 'price':
      return BASE_PRICE_SQL;
    default:
      return Prisma.sql`p."createdAt"`;
  }
}

/**
 * Mệnh đề ORDER BY: khoá chính (giá trị trống luôn xuống cuối, bất kể chiều) rồi thứ tự mặc định "hàng tạo trước đứng
 * trước" và `id` — thứ tự xác định duy nhất nên phân trang OFFSET không lặp/sót dòng.
 */
export function orderBySql(primary: Prisma.Sql | null, dir: 'asc' | 'desc'): Prisma.Sql {
  const tail = Prisma.sql`p."createdAt" ASC, p."id" ASC`;
  if (!primary) return tail;
  const direction = Prisma.raw(dir === 'desc' ? 'DESC' : 'ASC');
  return Prisma.sql`${primary} ${direction} NULLS LAST, ${tail}`;
}
