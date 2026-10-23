import { Prisma } from '@prisma/client';

const USER_BRIEF = { select: { id: true, fullName: true } } as const;

/** Cột đọc được của phiếu nhập ở danh sách — không lộ `isDeleted`. */
export const RECEIPT_LIST_SELECT = {
  id: true,
  code: true,
  status: true,
  receivedAt: true,
  subtotalAmount: true,
  discountAmount: true,
  discountPercent: true,
  vatAmount: true,
  supplierExpenseAmount: true,
  otherExpenseAmount: true,
  totalAmount: true,
  paidAmount: true,
  paymentStatus: true,
  paymentMethod: true,
  supplierInvoiceNo: true,
  supplierInvoiceDate: true,
  confirmedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  receiverId: true,
  branch: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, name: true } },
  createdByUser: USER_BRIEF,
  receiver: USER_BRIEF,
  _count: { select: { items: { where: { isDeleted: false } } } },
} satisfies Prisma.GoodsReceiptSelect;

export const RECEIPT_DETAIL_SELECT = {
  ...RECEIPT_LIST_SELECT,
  branchId: true,
  supplierId: true,
  note: true,
  cancelReason: true,
  expenses: true,
  updatedByUser: USER_BRIEF,
  confirmedByUser: USER_BRIEF,
  cancelledByUser: USER_BRIEF,
  items: {
    where: { isDeleted: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      productId: true,
      productUnitId: true,
      quantity: true,
      conversionRate: true,
      baseQuantity: true,
      importPrice: true,
      unitDiscount: true,
      totalPrice: true,
      batchNumber: true,
      manufacturingDate: true,
      expiryDate: true,
      note: true,
      product: { select: { id: true, code: true, name: true } },
      productUnit: { select: { id: true, unit: { select: { id: true, code: true, name: true } } } },
    },
  },
} satisfies Prisma.GoodsReceiptSelect;

type Brief = { id: string; fullName: string } | null;

/** Đổi discountPercent (Decimal → JSON chuỗi) sang number; quan hệ `receiver` trả ra tên `receiverUser` cho client. */
type Presented<T extends { discountPercent: Prisma.Decimal | null; receiver: Brief }> = Omit<
  T,
  'discountPercent' | 'receiver'
> & { discountPercent: number | null; receiverUser: Brief };

export type GoodsReceiptSummary = Presented<Prisma.GoodsReceiptGetPayload<{ select: typeof RECEIPT_LIST_SELECT }>>;
export type GoodsReceiptDetail = Presented<Prisma.GoodsReceiptGetPayload<{ select: typeof RECEIPT_DETAIL_SELECT }>>;

export function presentReceipt<T extends { discountPercent: Prisma.Decimal | null; receiver: Brief }>(
  row: T,
): Presented<T> {
  const { discountPercent, receiver, ...rest } = row;
  return { ...rest, discountPercent: discountPercent === null ? null : discountPercent.toNumber(), receiverUser: receiver };
}
