import { Injectable } from '@nestjs/common';
import { Prisma, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { containsPattern } from 'src/common/utils/like-pattern.util';

/** Cột được phép sắp xếp -> biểu thức SQL cố định (không bao giờ ghép chuỗi người dùng vào SQL). */
const SORT_COLUMNS: Record<string, string> = {
  code: 't."code"',
  name: 't."name"',
  phone: 't."phone"',
  email: 't."email"',
  status: 't."status"',
  taxCode: 't."taxCode"',
  contactName: 't."contactName"',
  createdAt: 't."createdAt"',
  updatedAt: 't."updatedAt"',
  totalPurchase: 't."totalPurchase"',
  currentDebt: 't."currentDebt"',
};

export interface SupplierListParams {
  /** Chỉ tính phiếu nhập của chi nhánh này; `undefined` = toàn chuỗi. */
  branchId?: string;
  /** Thiếu quyền supplier-debt:read -> nợ = 0, bỏ qua lọc/sắp theo nợ. */
  canSeeDebt: boolean;
  ids?: string[];
  status?: RecordStatus;
  groupId?: string;
  search?: string;
  note?: string;
  purchaseMin?: number;
  purchaseMax?: number;
  debtMin?: number;
  debtMax?: number;
  fromDate?: string;
  toDate?: string;
  /** "field:asc|desc" */
  sort?: string;
  page: number;
  limit: number;
}

export interface SupplierTotalsRow {
  id: string;
  totalPurchase: number;
  currentDebt: number;
}

export interface SupplierListResult {
  rows: SupplierTotalsRow[];
  total: number;
  summary: { totalPurchase: number; currentDebt: number };
}

/**
 * Danh sách NCC kèm Tổng mua / Nợ hiện tại gom bằng SQL: Prisma không `orderBy`/lọc theo tổng của quan hệ.
 * Tổng mua = Σ totalAmount phiếu CONFIRMED (trong khoảng ngày nhập, giờ VN). Nợ = Σ(totalAmount − paidAmount) phiếu
 * CONFIRMED + Σ delta điều chỉnh chưa huỷ; có `branchId` thì cả hai đều chỉ tính đúng chi nhánh đó
 * (điều chỉnh gắn chi nhánh lập).
 */
@Injectable()
export class SupplierListWithTotalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(p: SupplierListParams): Promise<SupplierListResult> {
    const base = this.buildBase(p);
    const where = this.buildOuterWhere(p);
    const order = this.buildOrder(p);
    const offset = (p.page - 1) * p.limit;

    const [rows, agg] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; totalPurchase: bigint; currentDebt: bigint }[]>(
        Prisma.sql`${base} SELECT t."id", t."totalPurchase", t."currentDebt" FROM base t ${where} ${order} LIMIT ${p.limit} OFFSET ${offset}`,
      ),
      this.prisma.$queryRaw<{ total: bigint; purchase: bigint | null; debt: bigint | null }[]>(
        Prisma.sql`${base} SELECT COUNT(*)::bigint AS total, SUM(t."totalPurchase")::bigint AS purchase, SUM(t."currentDebt")::bigint AS debt FROM base t ${where}`,
      ),
    ]);

    return {
      rows: rows.map((r) => ({ id: r.id, totalPurchase: Number(r.totalPurchase), currentDebt: Number(r.currentDebt) })),
      total: Number(agg[0]?.total ?? 0),
      summary: { totalPurchase: Number(agg[0]?.purchase ?? 0), currentDebt: Number(agg[0]?.debt ?? 0) },
    };
  }

  /** CTE `base`: mỗi NCC chưa xoá (đã lọc theo các điều kiện bản ghi) + hai cột tổng. */
  private buildBase(p: SupplierListParams): Prisma.Sql {
    const branchCond = p.branchId ? Prisma.sql`AND r."branchId" = ${p.branchId}::uuid` : Prisma.empty;
    const dateExpr = Prisma.sql`(COALESCE(r."receivedAt", r."confirmedAt") AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
    const fromCond = p.fromDate ? Prisma.sql`AND ${dateExpr} >= ${p.fromDate}::date` : Prisma.empty;
    const toCond = p.toDate ? Prisma.sql`AND ${dateExpr} <= ${p.toDate}::date` : Prisma.empty;

    const adjBranchCond = p.branchId ? Prisma.sql`AND x."branchId" = ${p.branchId}::uuid` : Prisma.empty;
    const retBranchCond = p.branchId ? Prisma.sql`AND t."branchId" = ${p.branchId}::uuid` : Prisma.empty;
    const debtExpr = p.canSeeDebt
      ? Prisma.sql`COALESCE(d.amt, 0) - COALESCE(rt.amt, 0) + COALESCE(a.amt, 0)`
      : Prisma.sql`0`;

    const conds: Prisma.Sql[] = [Prisma.sql`s."isDeleted" = false`];
    if (p.ids) conds.push(Prisma.sql`s."id" = ANY(${p.ids}::uuid[])`);
    if (p.status) conds.push(Prisma.sql`s."status"::text = ${p.status}`);
    if (p.groupId === 'none') conds.push(Prisma.sql`s."groupId" IS NULL`);
    else if (p.groupId) conds.push(Prisma.sql`s."groupId" = ${p.groupId}::uuid`);
    if (p.note) conds.push(Prisma.sql`s."note" ILIKE ${containsPattern(p.note)}`);
    if (p.search) {
      const pattern = containsPattern(p.search);
      conds.push(
        Prisma.sql`(s."code" ILIKE ${pattern} OR s."name" ILIKE ${pattern} OR s."phone" ILIKE ${pattern} OR s."taxCode" ILIKE ${pattern})`,
      );
    }

    return Prisma.sql`WITH purchase AS (
        SELECT r."supplierId" AS sid, SUM(r."totalAmount")::bigint AS amt
        FROM "goods_receipts" r
        WHERE r."status" = 'CONFIRMED' AND r."isDeleted" = false ${branchCond} ${fromCond} ${toCond}
        GROUP BY r."supplierId"
      ), debt AS (
        SELECT r."supplierId" AS sid, SUM(r."totalAmount" - r."paidAmount")::bigint AS amt
        FROM "goods_receipts" r
        WHERE r."status" = 'CONFIRMED' AND r."isDeleted" = false ${branchCond}
        GROUP BY r."supplierId"
      ), ret AS (
        -- Phiếu trả NCC đã xác nhận: phần NCC chưa hoàn tiền giảm nợ (như supplier-debt.repository debtOf).
        SELECT t."supplierId" AS sid, SUM(t."totalAmount" - t."supplierPaid")::bigint AS amt
        FROM "stock_adjustments" t
        WHERE t."type" = 'RETURN_TO_SUPPLIER' AND t."status" = 'CONFIRMED' AND t."isDeleted" = false ${retBranchCond}
        GROUP BY t."supplierId"
      ), adj AS (
        SELECT x."supplierId" AS sid, SUM(x."delta")::bigint AS amt
        FROM "supplier_debt_adjustments" x
        WHERE x."cancelledAt" IS NULL ${adjBranchCond}
        GROUP BY x."supplierId"
      ), base AS (
        SELECT s."id", s."code", s."name", s."phone", s."email", s."status", s."taxCode", s."contactName",
               s."createdAt", s."updatedAt",
               COALESCE(p.amt, 0)::bigint AS "totalPurchase",
               (${debtExpr})::bigint AS "currentDebt"
        FROM "suppliers" s
        LEFT JOIN purchase p ON p.sid = s."id"
        LEFT JOIN debt d ON d.sid = s."id"
        LEFT JOIN ret rt ON rt.sid = s."id"
        LEFT JOIN adj a ON a.sid = s."id"
        WHERE ${Prisma.join(conds, ' AND ')}
      )`;
  }

  /** Lọc khoảng số trên cột tổng (không thể đặt trong WHERE của CTE vì là cột tính toán). */
  private buildOuterWhere(p: SupplierListParams): Prisma.Sql {
    const conds: Prisma.Sql[] = [];
    if (p.purchaseMin !== undefined) conds.push(Prisma.sql`t."totalPurchase" >= ${p.purchaseMin}`);
    if (p.purchaseMax !== undefined) conds.push(Prisma.sql`t."totalPurchase" <= ${p.purchaseMax}`);
    if (p.canSeeDebt) {
      if (p.debtMin !== undefined) conds.push(Prisma.sql`t."currentDebt" >= ${p.debtMin}`);
      if (p.debtMax !== undefined) conds.push(Prisma.sql`t."currentDebt" <= ${p.debtMax}`);
    }
    return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  }

  /** `field:dir` -> ORDER BY từ whitelist; sai/thiếu quyền nợ -> mặc định createdAt desc. Luôn thêm id để ổn định trang. */
  private buildOrder(p: SupplierListParams): Prisma.Sql {
    const [field, dir] = (p.sort ?? '').split(':');
    const column = SORT_COLUMNS[field];
    const blocked = field === 'currentDebt' && !p.canSeeDebt;
    if (!column || blocked) return Prisma.sql`ORDER BY t."createdAt" DESC, t."id"`;
    const direction = dir?.toLowerCase() === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    return Prisma.sql`ORDER BY ${Prisma.raw(column)} ${direction}, t."id"`;
  }
}
