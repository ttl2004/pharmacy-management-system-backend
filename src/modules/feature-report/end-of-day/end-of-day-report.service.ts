import { Inject, Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, todayInVietnam, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { REPORT_CACHE, ReportCache } from '../report-cache';
import { resolveReportScope } from '../report-scope';
import { EndOfDayReportQuery } from './dtos/end-of-day-report.query';
import { EndOfDayReportRepository } from './end-of-day-report.repository';

export const END_OF_DAY_REPORT_TTL_MS = 60_000;
export const END_OF_DAY_TOP_LIMIT = 10;

const SALE_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD'] as const;
/** Thứ tự hiển thị hình thức chi NCC (hình thức lạ xếp cuối). */
const SUPPLIER_METHOD_ORDER = ['CASH', 'BANK_TRANSFER', 'CARD', 'COD'];

export interface EndOfDayReportResponse {
  date: string;
  sales: { orderCount: number; grossAmount: number; refundAmount: number; netAmount: number; cancelledCount: number };
  byMethod: { method: 'CASH' | 'BANK_TRANSFER' | 'CARD'; received: number; refunded: number; net: number }[];
  supplier: {
    receiptCount: number;
    receiptAmount: number;
    paymentCount: number;
    paymentAmount: number;
    paymentByMethod: { method: string; amount: number }[];
  };
  topProducts: { productId: string; productName: string; qtyBase: number; amount: number }[];
  byStaff: { staffId: string; staffName: string; orderCount: number; netAmount: number }[];
}

@Injectable()
export class EndOfDayReportService {
  constructor(
    private readonly repo: EndOfDayReportRepository,
    @Inject(REPORT_CACHE) private readonly cache: ReportCache,
  ) {}

  async endOfDay(query: EndOfDayReportQuery, actor: RequestActor): Promise<EndOfDayReportResponse> {
    const date = query.date ?? todayInVietnam();
    if (date > todayInVietnam()) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'date không được ở tương lai' });
    }
    const { branchIds, scopeKey } = resolveReportScope(actor, query.branchIds);
    const key = `end-of-day|${date}|${(branchIds ?? []).join(',')}|${scopeKey}`;
    const cached = this.cache.get<EndOfDayReportResponse>(key);
    if (cached) return cached;

    const range = { start: vietnamDayStartUtc(date), end: vietnamDayStartUtc(addDaysToDateOnly(date, 1)) };
    const [payments, counts, receipts, supplierPays, top, staff] = await Promise.all([
      this.repo.paymentsByMethod(range, branchIds),
      this.repo.orderCounts(range, branchIds),
      this.repo.supplierReceipts(range, branchIds),
      this.repo.supplierPayments(range, branchIds),
      this.repo.topProducts(range, END_OF_DAY_TOP_LIMIT, branchIds),
      this.repo.byStaff(range, branchIds),
    ]);

    const byMethod = SALE_METHODS.map((method) => {
      const sum = (kind: string) =>
        payments.filter((r) => r.method === method && r.kind === kind).reduce((s, r) => s + r.total, 0n);
      const received = sum('PAYMENT');
      const refunded = sum('REFUND');
      return { method, received, refunded, net: received - refunded };
    });
    const gross = byMethod.reduce((s, m) => s + m.received, 0n);
    const refund = byMethod.reduce((s, m) => s + m.refunded, 0n);

    const rank = (m: string) => {
      const i = SUPPLIER_METHOD_ORDER.indexOf(m);
      return i < 0 ? SUPPLIER_METHOD_ORDER.length : i;
    };
    const supplierMethods = [...supplierPays].sort((a, b) => rank(a.method) - rank(b.method));

    const report: EndOfDayReportResponse = {
      date,
      sales: {
        orderCount: counts.orderCount,
        grossAmount: Number(gross),
        refundAmount: Number(refund),
        netAmount: Number(gross - refund),
        cancelledCount: counts.cancelledCount,
      },
      byMethod: byMethod.map((m) => ({
        method: m.method,
        received: Number(m.received),
        refunded: Number(m.refunded),
        net: Number(m.net),
      })),
      supplier: {
        receiptCount: receipts.count,
        receiptAmount: Number(receipts.amount),
        paymentCount: supplierPays.reduce((s, r) => s + r.count, 0),
        paymentAmount: Number(supplierPays.reduce((s, r) => s + r.amount, 0n)),
        paymentByMethod: supplierMethods.map((r) => ({ method: r.method, amount: Number(r.amount) })),
      },
      topProducts: top.map((r) => ({
        productId: r.productId,
        productName: r.productName,
        qtyBase: Number(r.qtyBase),
        amount: Number(r.amount),
      })),
      byStaff: staff.map((r) => ({
        staffId: r.staffId,
        staffName: r.staffName,
        orderCount: r.orderCount,
        netAmount: Number(r.netAmount),
      })),
    };
    this.cache.set(key, report, END_OF_DAY_REPORT_TTL_MS);
    return report;
  }
}
