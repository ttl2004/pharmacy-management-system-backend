import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma, SupplierPaymentSource } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

const USER_BRIEF = { select: { id: true, fullName: true } } as const;

/** Cột phiếu chi trả ra client: kèm NCC, chi nhánh, người lập/huỷ và phân bổ theo phiếu nhập. */
export const PAYMENT_SELECT = {
  id: true,
  code: true,
  supplierId: true,
  branchId: true,
  paidAt: true,
  method: true,
  amount: true,
  note: true,
  source: true,
  createdAt: true,
  cancelledAt: true,
  cancelReason: true,
  supplier: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, code: true, name: true } },
  createdByUser: USER_BRIEF,
  cancelledByUser: USER_BRIEF,
  allocations: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      receiptId: true,
      amount: true,
      receipt: { select: { id: true, code: true, branchId: true } },
    },
  },
} satisfies Prisma.SupplierPaymentSelect;

export type PaymentRow = Prisma.SupplierPaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

export interface NewPayment {
  code: string;
  supplierId: string;
  branchId: string;
  paidAt: Date;
  method: PaymentMethod;
  note: string | null;
  source: SupplierPaymentSource;
  createdBy: string;
  allocations: readonly { receiptId: string; amount: bigint }[];
}

/** Một thay đổi `paidAmount` của phiếu nhập: dương = trả thêm, âm = hoàn lại (huỷ phiếu chi). */
export interface PaidDelta {
  receiptId: string;
  delta: bigint;
}

@Injectable()
export class SupplierPaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string, client: Prisma.TransactionClient = this.prisma): Promise<PaymentRow | null> {
    return client.supplierPayment.findUnique({ where: { id }, select: PAYMENT_SELECT });
  }

  /** Phiếu chi + phân bổ trong MỘT lần ghi lồng nhau (số câu lệnh không tăng theo số dòng phân bổ). */
  async create(tx: Prisma.TransactionClient, data: NewPayment): Promise<{ id: string; amount: bigint }> {
    const amount = data.allocations.reduce((sum, row) => sum + row.amount, 0n);
    const created = await tx.supplierPayment.create({
      data: {
        code: data.code,
        supplierId: data.supplierId,
        branchId: data.branchId,
        paidAt: data.paidAt,
        method: data.method,
        amount,
        note: data.note,
        source: data.source,
        createdBy: data.createdBy,
        allocations: { create: data.allocations.map((row) => ({ receiptId: row.receiptId, amount: row.amount })) },
      },
      select: { id: true },
    });
    return { id: created.id, amount };
  }

  /** Huỷ CÓ ĐIỀU KIỆN: chỉ ăn khi phiếu chưa huỷ — 0 dòng = đã huỷ trước đó (bấm đúp). */
  async markCancelled(
    tx: Prisma.TransactionClient,
    id: string,
    data: { cancelledBy: string; reason: string | null },
  ): Promise<number> {
    const now = new Date();
    const result = await tx.supplierPayment.updateMany({
      where: { id, cancelledAt: null },
      data: {
        cancelledAt: now,
        cancelledBy: data.cancelledBy,
        cancelReason: data.reason,
        updatedAt: now,
        updatedBy: data.cancelledBy,
      },
    });
    return result.count;
  }

  /** Phiếu chi CHƯA huỷ đang phân bổ vào một phiếu nhập — nguồn để huỷ theo phiếu nhập (1713). */
  findActiveByReceipt(tx: Prisma.TransactionClient, receiptId: string) {
    return tx.supplierPayment.findMany({
      where: { cancelledAt: null, allocations: { some: { receiptId } } },
      select: { id: true, code: true, source: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Cộng/trừ `paidAmount` của nhiều phiếu nhập bằng MỘT câu UPDATE có điều kiện. Điều kiện nằm trong WHERE nên hai
   * request đồng thời không thể cùng vượt tổng tiền phiếu; câu lệnh sửa ít dòng hơn yêu cầu = có điều kiện bị vi phạm.
   * `requireConfirmed`: trả thêm chỉ cho phiếu CONFIRMED; hoàn lại (huỷ phiếu chi/phiếu nhập) thì không đòi.
   * Trả `id → { paidAmount mới, branchId }` của các phiếu đã sửa.
   */
  async applyPaidDeltas(
    tx: Prisma.TransactionClient,
    deltas: readonly PaidDelta[],
    requireConfirmed: boolean,
  ): Promise<Map<string, { paidAmount: bigint; branchId: string }>> {
    if (!deltas.length) return new Map();
    const values = Prisma.join(deltas.map((d) => Prisma.sql`(${d.receiptId}::uuid, ${d.delta}::bigint)`));
    const statusCond = requireConfirmed ? Prisma.sql`AND r."status" = 'CONFIRMED'` : Prisma.empty;
    const rows = await tx.$queryRaw<{ id: string; branchId: string; paidAmount: bigint }[]>(Prisma.sql`
      UPDATE "goods_receipts" AS r
      SET "paidAmount" = r."paidAmount" + v."delta",
          "paymentStatus" = (CASE
            WHEN r."paidAmount" + v."delta" >= r."totalAmount" THEN 'PAID'
            WHEN r."paidAmount" + v."delta" = 0 THEN 'UNPAID'
            ELSE 'PARTIAL' END)::"PaymentStatus",
          "updatedAt" = now()
      FROM (VALUES ${values}) AS v("id", "delta")
      WHERE r."id" = v."id" AND r."isDeleted" = false ${statusCond}
        AND r."paidAmount" + v."delta" BETWEEN 0 AND r."totalAmount"
      RETURNING r."id", r."branchId", r."paidAmount"`);
    return new Map(rows.map((row) => [row.id, { paidAmount: row.paidAmount, branchId: row.branchId }]));
  }
}
