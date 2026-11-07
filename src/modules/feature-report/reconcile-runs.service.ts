import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { toDateOnlyString } from 'src/common/utils/date-only.util';
import type { ReconcileRunsQuery } from './dtos/reconcile.request';

type RunRow = Prisma.SalesReconcileRunGetPayload<object>;

/** `fromDate`/`toDate` ra dạng `YYYY-MM-DD`; danh sách bỏ `mismatches` (nặng) — chỉ chi tiết mới có. */
function present(run: RunRow, withMismatches: boolean) {
  const { mismatches, fromDate, toDate, ...rest } = run;
  return {
    ...rest,
    fromDate: toDateOnlyString(fromDate),
    toDate: toDateOnlyString(toDate),
    ...(withMismatches ? { mismatches } : {}),
  };
}

@Injectable()
export class ReconcileRunsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ReconcileRunsQuery) {
    const where: Prisma.SalesReconcileRunWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.hasMismatch !== undefined) where.mismatchCount = query.hasMismatch ? { gt: 0 } : 0;
    const [hits, total] = await Promise.all([
      this.prisma.salesReconcileRun.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: (query.page - 1) * query.limit,
      }),
      this.prisma.salesReconcileRun.count({ where }),
    ]);
    return {
      hits: hits.map((run) => present(run, false)),
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
      limit: query.limit,
    };
  }

  async detail(id: string) {
    const run = await this.prisma.salesReconcileRun.findUnique({ where: { id } });
    if (!run) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Không tìm thấy lần đối soát' });
    return present(run, true);
  }
}
