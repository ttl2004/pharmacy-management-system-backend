import { Prisma } from '@prisma/client';
import { addDaysToDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { escapeLike } from 'src/common/utils/like-pattern.util';
import { AdjustmentQuery } from './dtos/adjustment.request';

const ci = (value: string) => ({ contains: escapeLike(value), mode: 'insensitive' as const });

/**
 * Điều kiện danh sách phiếu điều chỉnh. Lọc ngày theo NGÀY CHỨNG TỪ (`documentDate`) như mock (ngày kiểm/huỷ/trả),
 * hàng/lô lọc theo dòng phiếu; `statuses` (nhiều) thắng `status` (một).
 */
export function adjustmentListWhere(query: AdjustmentQuery, branchId: string | undefined): Prisma.StockAdjustmentWhereInput {
  const where: Prisma.StockAdjustmentWhereInput = {};
  const and: Prisma.StockAdjustmentWhereInput[] = [];
  if (branchId) where.branchId = branchId;
  if (query.type) where.type = query.type;
  if (query.statuses?.length) where.status = { in: query.statuses };
  else if (query.status) where.status = query.status;
  if (query.fromDate || query.toDate) {
    where.documentDate = {
      ...(query.fromDate ? { gte: vietnamDayStartUtc(query.fromDate) } : {}),
      ...(query.toDate ? { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } : {}),
    };
  }
  if (query.search) where.code = ci(query.search);
  if (query.createdBy?.length) where.createdBy = { in: query.createdBy };
  if (query.handlerIds?.length) where.handlerId = { in: query.handlerIds };
  if (query.receiverIds?.length) where.receiverId = { in: query.receiverIds };
  if (query.internalUseTypeIds?.length) where.internalUseTypeId = { in: query.internalUseTypeIds };
  if (query.supplierId) where.supplierId = query.supplierId;
  if (query.product) {
    and.push({
      items: { some: { isDeleted: false, product: { OR: [{ code: ci(query.product) }, { name: ci(query.product) }] } } },
    });
  }
  if (query.lot) and.push({ items: { some: { isDeleted: false, batch: { batchNumber: ci(query.lot) } } } });
  if (query.noteQ) and.push({ OR: [{ note: ci(query.noteQ) }, { reason: ci(query.noteQ) }] });
  if (query.supplierQ) and.push({ supplier: { OR: [{ code: ci(query.supplierQ) }, { name: ci(query.supplierQ) }] } });
  if (query.receiptQ) and.push({ goodsReceipt: { code: ci(query.receiptQ) } });
  // Trả NCC: có chi phí hoàn lại thuộc một trong các mã (bản chụp JSONB [{code,…}]).
  if (query.refundCodes?.length) {
    and.push({ OR: query.refundCodes.map((code) => ({ refundExpenses: { array_contains: [{ code }] } })) });
  }
  return and.length ? { ...where, AND: and } : where;
}

const SORTABLE = new Set(['code', 'documentDate', 'confirmedAt', 'createdAt']);

/**
 * `sort` dạng FE: `field` (tăng) hoặc `-field` (giảm); hoặc `field:asc|desc`. Trường lạ → mặc định ngày lập giảm dần.
 * Phiếu có sao luôn lên đầu khi `sort` = `favourite`.
 */
export function adjustmentOrderBy(sort: string | undefined): Prisma.StockAdjustmentOrderByWithRelationInput[] {
  if (!sort) return [{ createdAt: 'desc' }];
  if (sort === 'favourite' || sort === '-favourite') return [{ isFavourite: 'desc' }, { createdAt: 'desc' }];
  const [rawField, rawDir] = sort.includes(':') ? sort.split(':') : [sort.replace(/^-/, ''), sort.startsWith('-') ? 'desc' : 'asc'];
  // FE gọi ngày chứng từ theo từng màn (countDate, disposedAt, returnedAt, usedAt) — cùng một cột.
  const field = ['countDate', 'disposedAt', 'returnedAt', 'usedAt'].includes(rawField) ? 'documentDate' : rawField === 'completedAt' ? 'confirmedAt' : rawField;
  if (!SORTABLE.has(field)) return [{ createdAt: 'desc' }];
  const dir: Prisma.SortOrder = rawDir === 'desc' ? 'desc' : 'asc';
  return [{ [field]: dir } as Prisma.StockAdjustmentOrderByWithRelationInput];
}
