import { Inject, Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, daysBetweenDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { PermissionService } from '../../feature-auth/permission/permission.service';
import { REPORT_CACHE, ReportCache } from '../report-cache';
import { resolveReportScope } from '../report-scope';
import { SupplierReportQuery } from './dtos/supplier-report.query';
import { DebtComponentRow, SupplierReportRepository } from './supplier-report.repository';

export const SUPPLIER_REPORT_MAX_DAYS = 366;
export const SUPPLIER_REPORT_TTL_MS = 60_000;
export const SUPPLIER_REPORT_TOP_LIMIT = 10;

/** Các trường nợ là `null` khi người gọi không có `supplier-debt:read`. */
export interface SupplierReportRow {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  receiptCount: number;
  purchaseAmount: number;
  returnCount: number;
  returnAmount: number;
  paidAmount: number | null;
  adjustmentAmount: number | null;
  openingDebt: number | null;
  closingDebt: number | null;
}

export interface SupplierReportResponse {
  totals: {
    purchaseAmount: number;
    returnAmount: number;
    paidAmount: number | null;
    adjustmentAmount: number | null;
    openingDebt: number | null;
    closingDebt: number | null;
  };
  bySupplier: SupplierReportRow[];
  topProducts: { productId: string; productName: string; qtyBase: number; amount: number }[];
}

interface Acc {
  receiptCount: number;
  purchase: bigint;
  openingPurchase: bigint;
  returnCount: number;
  returned: bigint;
  openingReturned: bigint;
  payCount: number;
  paid: bigint;
  openingPaid: bigint;
  adjCount: number;
  adjusted: bigint;
  openingAdjusted: bigint;
}

const emptyAcc = (): Acc => ({
  receiptCount: 0,
  purchase: 0n,
  openingPurchase: 0n,
  returnCount: 0,
  returned: 0n,
  openingReturned: 0n,
  payCount: 0,
  paid: 0n,
  openingPaid: 0n,
  adjCount: 0,
  adjusted: 0n,
  openingAdjusted: 0n,
});

@Injectable()
export class SupplierReportService {
  constructor(
    private readonly repo: SupplierReportRepository,
    private readonly permissions: PermissionService,
    @Inject(REPORT_CACHE) private readonly cache: ReportCache,
  ) {}

  async supplierReport(query: SupplierReportQuery, actor: RequestActor): Promise<SupplierReportResponse> {
    this.assertRange(query.from, query.to);
    const { branchIds, scopeKey } = resolveReportScope(actor, query.branchIds);
    const canSeeDebt = await this.canSeeDebt(actor);
    const key = [
      'supplier',
      query.from,
      query.to,
      (branchIds ?? []).join(','),
      query.supplierId ?? '',
      scopeKey,
      canSeeDebt ? 'debt' : 'nodebt',
    ].join('|');
    const cached = this.cache.get<SupplierReportResponse>(key);
    if (cached) return cached;

    const filter = {
      start: vietnamDayStartUtc(query.from),
      end: vietnamDayStartUtc(addDaysToDateOnly(query.to, 1)),
      branchIds,
      supplierId: query.supplierId,
    };
    // Không có quyền xem nợ thì không đọc phiếu chi / điều chỉnh: các số đó chỉ phục vụ nợ.
    const [receipts, returns, payments, adjustments, top] = await Promise.all([
      this.repo.receipts(filter),
      this.repo.returns(filter),
      canSeeDebt ? this.repo.payments(filter) : Promise.resolve<DebtComponentRow[]>([]),
      canSeeDebt ? this.repo.adjustments(filter) : Promise.resolve<DebtComponentRow[]>([]),
      this.repo.topProducts(filter, SUPPLIER_REPORT_TOP_LIMIT),
    ]);

    const acc = new Map<string, Acc>();
    const at = (id: string) => {
      let a = acc.get(id);
      if (!a) acc.set(id, (a = emptyAcc()));
      return a;
    };
    for (const r of receipts)
      Object.assign(at(r.supplierId), { receiptCount: r.count, purchase: r.period, openingPurchase: r.opening });
    for (const r of returns)
      Object.assign(at(r.supplierId), { returnCount: r.count, returned: r.period, openingReturned: r.opening });
    for (const r of payments)
      Object.assign(at(r.supplierId), { payCount: r.count, paid: r.period, openingPaid: r.opening });
    for (const r of adjustments)
      Object.assign(at(r.supplierId), { adjCount: r.count, adjusted: r.period, openingAdjusted: r.opening });

    // Có phát sinh trong kỳ; người xem nợ còn thấy NCC chỉ có nợ đầu kỳ. Người không xem nợ không được biết nợ cũ.
    const shown = [...acc.entries()].filter(([, a]) => {
      const opening = a.openingPurchase - a.openingReturned - a.openingPaid + a.openingAdjusted;
      const activity = a.receiptCount > 0 || a.returnCount > 0 || a.payCount > 0 || a.adjCount > 0;
      return activity || (canSeeDebt && opening !== 0n);
    });
    const names = new Map((await this.repo.suppliersByIds(shown.map(([id]) => id))).map((s) => [s.id, s] as const));

    const total = { purchase: 0n, returned: 0n, paid: 0n, adjusted: 0n, opening: 0n, closing: 0n };
    const rows: { row: SupplierReportRow; purchase: bigint }[] = [];
    for (const [supplierId, a] of shown) {
      const opening = a.openingPurchase - a.openingReturned - a.openingPaid + a.openingAdjusted;
      const closing = opening + a.purchase - a.returned - a.paid + a.adjusted;
      const supplier = names.get(supplierId);
      total.purchase += a.purchase;
      total.returned += a.returned;
      total.paid += a.paid;
      total.adjusted += a.adjusted;
      total.opening += opening;
      total.closing += closing;
      const row: SupplierReportRow = {
        supplierId,
        supplierCode: supplier?.code ?? '',
        supplierName: supplier?.name ?? '',
        receiptCount: a.receiptCount,
        purchaseAmount: Number(a.purchase),
        returnCount: a.returnCount,
        returnAmount: Number(a.returned),
        paidAmount: canSeeDebt ? Number(a.paid) : null,
        adjustmentAmount: canSeeDebt ? Number(a.adjusted) : null,
        openingDebt: canSeeDebt ? Number(opening) : null,
        closingDebt: canSeeDebt ? Number(closing) : null,
      };
      rows.push({ row, purchase: a.purchase });
    }
    rows.sort((x, y) =>
      x.purchase === y.purchase ? x.row.supplierId.localeCompare(y.row.supplierId) : x.purchase > y.purchase ? -1 : 1,
    );

    const report: SupplierReportResponse = {
      totals: {
        purchaseAmount: Number(total.purchase),
        returnAmount: Number(total.returned),
        paidAmount: canSeeDebt ? Number(total.paid) : null,
        adjustmentAmount: canSeeDebt ? Number(total.adjusted) : null,
        openingDebt: canSeeDebt ? Number(total.opening) : null,
        closingDebt: canSeeDebt ? Number(total.closing) : null,
      },
      bySupplier: rows.map((r) => r.row),
      topProducts: top.map((p) => ({
        productId: p.productId,
        productName: p.productName,
        qtyBase: p.qtyBase,
        amount: Number(p.amount),
      })),
    };
    this.cache.set(key, report, SUPPLIER_REPORT_TTL_MS);
    return report;
  }

  /** Như `SupplierListService.scopeParams`: SUPER_ADMIN luôn có, vai khác theo quyền `supplier-debt:read`. */
  private async canSeeDebt(actor: RequestActor): Promise<boolean> {
    const role = actor.user.role;
    if (role === AuthRole.SUPER_ADMIN) return true;
    return (await this.permissions.getGrantedCodes(role)).has('supplier-debt:read');
  }

  private assertRange(from: string, to: string): void {
    const days = daysBetweenDateOnly(from, to) + 1;
    if (days < 1) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'from phải trước hoặc bằng to' });
    }
    if (days > SUPPLIER_REPORT_MAX_DAYS) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: `Khoảng ngày tối đa ${SUPPLIER_REPORT_MAX_DAYS} ngày`,
      });
    }
  }
}
