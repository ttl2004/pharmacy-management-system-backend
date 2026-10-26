import { Prisma } from '@prisma/client';
import { addDaysToDateOnly, vietnamDayStartUtc } from 'src/common/utils/date-only.util';
import { escapeLike } from 'src/common/utils/like-pattern.util';
import type { GoodsReceiptQuery } from './dtos/goods-receipt.query';

const ci = (value: string) => ({ contains: escapeLike(value.trim()), mode: 'insensitive' as const });

/** `dd/mm/yyyy` → Date (UTC 00:00, khớp cột @db.Date); không đúng dạng → null. */
function parseVnDate(value: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Điều kiện danh sách phiếu nhập: lọc cơ bản + lọc nhiều giá trị (thắng trường một giá trị) + tìm nâng cao như mock
 * (mã/tên hàng, mã/tên NCC, số lô hoặc HSD dd/mm/yyyy, ghi chú phiếu, ghi chú dòng, mã chi phí NCC). Mỗi nhóm là
 * một điều kiện AND để các OR (ngày nhập, ô tìm) không đè nhau.
 */
export function receiptListWhere(query: GoodsReceiptQuery, branchId: string | undefined): Prisma.GoodsReceiptWhereInput {
  const where: Prisma.GoodsReceiptWhereInput = {};
  const and: Prisma.GoodsReceiptWhereInput[] = [];
  if (branchId) where.branchId = branchId;
  if (query.supplierId) where.supplierId = query.supplierId;

  if (query.statuses?.length) where.status = { in: query.statuses };
  else if (query.status) where.status = query.status;
  if (query.createdByIds?.length) where.createdBy = { in: query.createdByIds };
  else if (query.createdBy) where.createdBy = query.createdBy;
  if (query.receiverIds?.length) where.receiverId = { in: query.receiverIds };
  else if (query.receiverId) where.receiverId = query.receiverId;

  if (query.fromDate || query.toDate) {
    const range = {
      ...(query.fromDate ? { gte: vietnamDayStartUtc(query.fromDate) } : {}),
      ...(query.toDate ? { lt: vietnamDayStartUtc(addDaysToDateOnly(query.toDate, 1)) } : {}),
    };
    // Ngày nhập (như mock `receiptDate`): phiếu chưa có ngày nhập thì lấy ngày lập.
    if (query.dateBy === 'receivedAt') and.push({ OR: [{ receivedAt: range }, { receivedAt: null, createdAt: range }] });
    else where.createdAt = range;
  }
  if (query.search) {
    and.push({ OR: [{ code: ci(query.search) }, { supplierInvoiceNo: ci(query.search) }] });
  }
  // Bản chụp chi phí JSONB [{code,kind,…}].
  if (query.expenseCodes?.length) {
    and.push({ OR: query.expenseCodes.map((code) => ({ expenses: { array_contains: [{ code }] } })) });
  }

  const line = (w: Prisma.GoodsReceiptItemWhereInput) => ({ items: { some: { isDeleted: false, ...w } } });
  if (query.productQ?.trim()) and.push(line({ product: { OR: [{ code: ci(query.productQ) }, { name: ci(query.productQ) }] } }));
  if (query.supplierQ?.trim()) and.push({ supplier: { OR: [{ code: ci(query.supplierQ) }, { name: ci(query.supplierQ) }] } });
  if (query.lotQ?.trim()) {
    const expiry = parseVnDate(query.lotQ);
    and.push(line(expiry ? { expiryDate: expiry } : { batchNumber: ci(query.lotQ) }));
  }
  if (query.invoiceNo?.trim()) and.push({ supplierInvoiceNo: ci(query.invoiceNo) });
  if (query.noteQ?.trim()) and.push({ note: ci(query.noteQ) });
  if (query.itemNoteQ?.trim()) and.push(line({ note: ci(query.itemNoteQ) }));
  return and.length ? { ...where, AND: and } : where;
}
