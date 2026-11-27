import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

/** Thông báo duy nhất ra ngoài; chi tiết lỗi chỉ nằm trong log. */
const UNAVAILABLE_MESSAGE = 'Không kiểm tra được tương tác thuốc lúc này, vui lòng thử lại sau';

/**
 * Quá hạn này thì bỏ chờ và trả 1611 (như timeout 5 giây của client HTTP cũ) để luồng thu tiền / duyệt không treo
 * theo DB chậm. Câu SQL thường mất vài ms; mức này chỉ chạm khi DB/pool có sự cố.
 */
export const LOOKUP_TIMEOUT_MS = 3_000;

/** Prisma: không kết nối được / hết hạn kết nối / mất kết nối / chờ pool quá lâu. */
const UNAVAILABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
/** SQLSTATE của Postgres (trong P2010): 08 lỗi kết nối, 53 thiếu tài nguyên, 57014 bị huỷ / statement_timeout, 57P0x tắt máy. */
const UNAVAILABLE_SQLSTATE = /^(08|53|57014|57P0)/;

/** Một hàng hoá trong giỏ (chưa lọc loại), `registrationNumber` là giá trị gốc của thuốc trong danh mục. */
export interface CartProductRow {
  id: string;
  name: string;
  type: string;
  registrationNumber: string | null;
}

/** Một dòng `national_drug_ddinter_mapping`: một hoạt chất của một thuốc. `ingredientOrder = 0` = thuốc không ghi thành phần. */
export interface MappingRow {
  registrationNumber: string;
  drugName: string;
  ingredientOrder: number;
  ddinterId: string | null;
  ddinterDrug: string | null;
}

export interface InteractionRow {
  ddinterIdA: string;
  ddinterIdB: string;
  level: string;
  interaction: string | null;
  management: string | null;
}

export interface DiseaseRow {
  drugId: string;
  severity: string;
  diseaseName: string;
  description: string | null;
}

export interface FoodRow {
  drugId: string;
  severity: string;
  foodName: string;
  description: string | null;
  management: string | null;
}

interface CartRows {
  /** Hàng hoá tìm thấy (chưa xoá), theo thứ tự gửi lên. Thiếu dòng = có id không tồn tại. */
  products: CartProductRow[];
  /** Dòng map của các thuốc trong giỏ, theo (số đăng ký, thứ tự hoạt chất). */
  mapping: MappingRow[];
  /** false = bảng dữ liệu tương tác rỗng (chưa nạp / nạp hỏng) → KHÔNG được coi là "không có cảnh báo". */
  dataLoaded: boolean;
}

export interface CheckRows extends CartRows {
  /** Cặp mà hai hoạt chất thuộc hai thuốc KHÁC nhau trong giỏ (mỗi cặp DDInter chỉ lưu một chiều). */
  interactions: InteractionRow[];
}

export interface WarningRows extends CartRows {
  /** Theo `id` (= thứ tự dòng trong file CSV gốc). */
  diseases: DiseaseRow[];
  foods: FoodRow[];
}

/*
 * Phần đầu dùng chung của hai câu truy vấn:
 * - input:    id hàng hoá kèm vị trí trong giỏ.
 * - cart:     hàng hoá chưa xoá + số đăng ký của thuốc (chỉ hàng loại DRUG mới đem tra).
 * - mapping:  các dòng map của những số đăng ký đó (khoá chính bắt đầu bằng registration_number).
 * - id_drugs: mỗi mã DDInter đã map → các thuốc trong giỏ có hoạt chất đó. `ingredient_order <> 0` loại dòng
 *             đánh dấu "không ghi thành phần".
 * btrim ở đây chỉ để khớp khoá; BE vẫn cắt khoảng trắng lại bằng JS như trước.
 */
const cartCtes = (productIds: string[]) => Prisma.sql`
  input AS (
    SELECT t.id, t.ord FROM unnest(${productIds}::uuid[]) WITH ORDINALITY AS t(id, ord)
  ),
  cart AS (
    SELECT i.ord, p.id, p.name, p.type::text AS type, d."registrationNumber" AS registration_number,
           CASE WHEN p.type = 'DRUG' THEN nullif(btrim(d."registrationNumber", E' \\t\\n\\r\\f\\v'), '') END AS lookup_number
    FROM input i
    JOIN products p ON p.id = i.id AND p."isDeleted" = false
    LEFT JOIN drugs d ON d.id = p."drugId"
  ),
  mapping AS (
    SELECT registration_number, drug_name, ingredient_order, ddinter_id, ddinter_drug
    FROM national_drug_ddinter_mapping
    WHERE registration_number IN (SELECT lookup_number FROM cart WHERE lookup_number IS NOT NULL)
  ),
  id_drugs AS (
    SELECT ddinter_id AS id, array_agg(DISTINCT registration_number ORDER BY registration_number) AS drugs
    FROM mapping
    WHERE ingredient_order <> 0 AND ddinter_id IS NOT NULL
    GROUP BY ddinter_id
  )`;

const productsJson = Prisma.sql`
  (SELECT coalesce(json_agg(json_build_object(
            'id', id, 'name', name, 'type', type, 'registrationNumber', registration_number
          ) ORDER BY ord), '[]'::json)
   FROM cart)`;

const mappingJson = Prisma.sql`
  (SELECT coalesce(json_agg(json_build_object(
            'registrationNumber', registration_number, 'drugName', drug_name, 'ingredientOrder', ingredient_order,
            'ddinterId', ddinter_id, 'ddinterDrug', ddinter_drug
          ) ORDER BY registration_number, ingredient_order), '[]'::json)
   FROM mapping)`;

/** Lỗi nội bộ: hết `LOOKUP_TIMEOUT_MS`. */
class LookupTimeoutError extends Error {}

/**
 * Đọc giỏ hàng + dữ liệu tương tác thuốc (4 bảng DDInter, chỉ đọc) trong MỘT câu SQL = một vòng gọi DB; các phần
 * kết quả gom thành cột JSON. DB không với tới được / quá hạn → 1611 để luồng bán lùi về "dược sĩ kiểm tra thủ công"
 * như khi service TTT-BE cũ không chạy. Lỗi khác (vd SQL sai) ném nguyên để lộ ra 500, không âm thầm đẩy mọi đơn
 * sang duyệt thủ công.
 */
@Injectable()
export class InteractionKnowledgeRepository {
  private readonly logger = new Logger(InteractionKnowledgeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cặp tương tác: với MỖI mã DDInter của giỏ, quét đoạn index ("DDInterID_A" = mã) trong một subquery LATERAL có
   * `OFFSET 0` — hàng rào chặn planner gộp subquery, nên:
   *  - luôn đi index theo từng mã A (không đổi sang quét cả bảng 235k dòng khi giỏ lớn);
   *  - cột B không bị đưa vào điều kiện index: Postgres ≤ 16 khi đó dò index cho từng tổ hợp (A, B), số lần dò tăng
   *    theo bình phương số hoạt chất. B được lọc sau bằng hash join với `id_drugs`.
   * Mỗi cặp chỉ lưu một chiều nên đi phía A là đủ. Bỏ luôn cặp mà cả hai hoạt chất chỉ thuộc cùng MỘT thuốc (thuốc
   * phối hợp) — BE chỉ so giữa hai thuốc khác nhau.
   */
  async loadForCheck(productIds: string[]): Promise<CheckRows> {
    const [row] = await this.query<CheckRows>(
      'loadForCheck',
      Prisma.sql`
        WITH ${cartCtes(productIds)},
        pairs AS (
          SELECT i.*
          FROM id_drugs a
          CROSS JOIN LATERAL (
            SELECT x."DDInterID_A", x."DDInterID_B", x."Level", x."Interaction", x."Management"
            FROM ddinter_interactions_final x
            WHERE x."DDInterID_A" = a.id
            OFFSET 0
          ) i
          JOIN id_drugs b ON b.id = i."DDInterID_B"
          WHERE NOT (cardinality(a.drugs) = 1 AND a.drugs = b.drugs)
        )
        SELECT
          ${productsJson} AS products,
          ${mappingJson} AS mapping,
          (SELECT coalesce(json_agg(json_build_object(
                    'ddinterIdA', "DDInterID_A", 'ddinterIdB', "DDInterID_B", 'level', "Level",
                    'interaction', "Interaction", 'management', "Management"
                  )), '[]'::json)
           FROM pairs) AS interactions,
          (EXISTS (SELECT 1 FROM national_drug_ddinter_mapping)
            AND EXISTS (SELECT 1 FROM ddinter_interactions_final)) AS "dataLoaded"`,
    );
    return row;
  }

  async loadForWarnings(productIds: string[]): Promise<WarningRows> {
    const [row] = await this.query<WarningRows>(
      'loadForWarnings',
      Prisma.sql`
        WITH ${cartCtes(productIds)},
        ids AS (SELECT coalesce(array_agg(id), '{}')::text[] AS ids FROM id_drugs)
        SELECT
          ${productsJson} AS products,
          ${mappingJson} AS mapping,
          (SELECT coalesce(json_agg(json_build_object(
                    'drugId', d.drug_id, 'severity', d.severity, 'diseaseName', d.disease_name,
                    'description', d.description
                  ) ORDER BY d.id), '[]'::json)
           FROM drug_disease_interactions d
           WHERE d.drug_id = ANY((SELECT ids FROM ids)::text[])) AS diseases,
          (SELECT coalesce(json_agg(json_build_object(
                    'drugId', f.drug_id, 'severity', f.severity, 'foodName', f.food_name,
                    'description', f.description, 'management', f.management
                  ) ORDER BY f.id), '[]'::json)
           FROM drug_food_interactions f
           WHERE f.drug_id = ANY((SELECT ids FROM ids)::text[])) AS foods,
          (EXISTS (SELECT 1 FROM national_drug_ddinter_mapping)
            AND EXISTS (SELECT 1 FROM drug_disease_interactions)
            AND EXISTS (SELECT 1 FROM drug_food_interactions)) AS "dataLoaded"`,
    );
    return row;
  }

  /**
   * Hết hạn bằng `Promise.race` thay vì `SET LOCAL statement_timeout`: cách sau cần transaction (BEGIN/SET/COMMIT)
   * = thêm vòng gọi DB, còn tham số kết nối thì áp cho cả app và bị pooler chế độ transaction bỏ qua. Nhược điểm:
   * câu SQL vẫn chạy nốt phía DB (vài ms khi DB bình thường), BE chỉ thôi chờ.
   */
  private async query<T>(name: string, sql: Prisma.Sql): Promise<T[]> {
    const pending = Promise.resolve(this.prisma.$queryRaw<T[]>(sql));
    pending.catch(() => undefined); // thua cuộc đua thì lỗi về sau không thành unhandled rejection
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LookupTimeoutError(`quá ${LOOKUP_TIMEOUT_MS}ms`)), LOOKUP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (error) {
      if (!isUnavailableError(error)) throw error;
      this.logger.error(`Đọc dữ liệu tương tác thuốc (${name}) thất bại: ${String(error)}`);
      throw interactionDataUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

export function interactionDataUnavailable(): ErrorException {
  return new ErrorException({ code: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE, message: UNAVAILABLE_MESSAGE });
}

/** Chỉ lỗi "DB không dùng được lúc này" mới thành 1611. */
export function isUnavailableError(error: unknown): boolean {
  if (error instanceof LookupTimeoutError || error instanceof Prisma.PrismaClientInitializationError) return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (UNAVAILABLE_PRISMA_CODES.has(error.code)) return true;
  const sqlState = (error.meta as { code?: unknown } | undefined)?.code;
  return error.code === 'P2010' && typeof sqlState === 'string' && UNAVAILABLE_SQLSTATE.test(sqlState);
}
