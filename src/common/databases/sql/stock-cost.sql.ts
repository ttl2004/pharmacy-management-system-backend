import { Prisma } from '@prisma/client';

/**
 * Định nghĩa DÙNG CHUNG của giá vốn / giá nhập cuối (chốt 26-11, quyết định 2): màn Thiết lập giá, Hàng hoá chi nhánh
 * và mọi màn sau này phải đọc cùng một công thức, nếu không hai màn hiện hai con số khác nhau cho cùng một hàng.
 *
 * - Giá vốn (đơn vị gốc) = bình quân `importPrice` theo SỐ CÒN LẠI của các lô AVAILABLE (lô bị khoá không tính).
 *   Không còn lô AVAILABLE có tồn → NULL (không phải 0).
 * - Giá nhập cuối (đơn vị gốc) = (đơn giá − giảm giá) / hệ số của dòng phiếu nhập CONFIRMED mới nhất.
 */

/** Tử số giá vốn: Σ giá nhập × tồn của lô AVAILABLE (float8 để không tràn int). `b` = bí danh bảng `stock_batches`. */
export function availableValueSql(b = 'b'): Prisma.Sql {
  const t = Prisma.raw(`"${b}"`);
  return Prisma.sql`SUM(${t}."importPrice"::float8 * ${t}."quantityOnHand") FILTER (WHERE ${t}."status" = 'AVAILABLE')`;
}

/** Mẫu số giá vốn: Σ tồn của lô AVAILABLE. */
export function availableQtySql(b = 'b'): Prisma.Sql {
  const t = Prisma.raw(`"${b}"`);
  return Prisma.sql`SUM(${t}."quantityOnHand") FILTER (WHERE ${t}."status" = 'AVAILABLE')`;
}

/** Giá vốn đơn vị gốc trong một nhóm lô (NULL khi không còn tồn AVAILABLE). */
export function avgCostBaseSql(b = 'b'): Prisma.Sql {
  return Prisma.sql`${availableValueSql(b)} / NULLIF(${availableQtySql(b)}, 0)`;
}

export interface LastPurchaseScope {
  /**
   * `string` = một chi nhánh; `null` = không có chi nhánh (kết quả rỗng — như Thiết lập giá khi không chọn chi nhánh);
   * `'ALL'` = toàn chuỗi.
   */
  branchId: string | null;
  /** true = mỗi (chi nhánh, sản phẩm) một dòng; false = mỗi sản phẩm một dòng. */
  perBranch?: boolean;
  /** Chỉ tính cho các sản phẩm này (trang hiện tại) — tránh quét mọi phiếu nhập. */
  productIds?: string[];
}

/**
 * Giá nhập cuối: SELECT trả `productId` (+ `branchId` nếu `perBranch`) và `netBase` = giá nhập cuối theo đơn vị gốc.
 * Thứ tự "mới nhất" = thời điểm xác nhận (rơi về ngày nhận / ngày tạo), rồi dòng tạo sau, rồi id — xác định duy nhất.
 */
export function lastPurchaseSql(scope: LastPurchaseScope): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`r."status" = 'CONFIRMED' AND r."isDeleted" = false AND i."isDeleted" = false`,
  ];
  if (scope.branchId !== 'ALL') conditions.push(Prisma.sql`r."branchId" = ${scope.branchId}::uuid`);
  if (scope.productIds) conditions.push(Prisma.sql`i."productId" = ANY(${scope.productIds}::uuid[])`);
  const key = scope.perBranch ? Prisma.sql`r."branchId", i."productId"` : Prisma.sql`i."productId"`;
  return Prisma.sql`
    SELECT DISTINCT ON (${key}) ${key},
           (i."importPrice" - i."unitDiscount")::float8 / i."conversionRate" AS "netBase"
    FROM "goods_receipt_items" i
    JOIN "goods_receipts" r ON r."id" = i."receiptId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY ${key}, COALESCE(r."confirmedAt", r."receivedAt", r."createdAt") DESC, i."createdAt" DESC, i."id" DESC`;
}
