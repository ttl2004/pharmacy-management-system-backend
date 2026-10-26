import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

const USER_BRIEF = { select: { id: true, fullName: true } } as const;

export const ADJUSTMENT_SELECT = {
  id: true,
  code: true,
  supplierId: true,
  branchId: true,
  adjustedAt: true,
  debtBefore: true,
  debtAfter: true,
  delta: true,
  note: true,
  createdAt: true,
  cancelledAt: true,
  cancelReason: true,
  supplier: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, code: true, name: true } },
  createdByUser: USER_BRIEF,
  cancelledByUser: USER_BRIEF,
} satisfies Prisma.SupplierDebtAdjustmentSelect;

export type AdjustmentRow = Prisma.SupplierDebtAdjustmentGetPayload<{ select: typeof ADJUSTMENT_SELECT }>;

@Injectable()
export class SupplierDebtAdjustmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string, client: Prisma.TransactionClient = this.prisma): Promise<AdjustmentRow | null> {
    return client.supplierDebtAdjustment.findUnique({ where: { id }, select: ADJUSTMENT_SELECT });
  }

  create(tx: Prisma.TransactionClient, data: Prisma.SupplierDebtAdjustmentUncheckedCreateInput) {
    return tx.supplierDebtAdjustment.create({ data, select: { id: true } });
  }

  /** Huỷ CÓ ĐIỀU KIỆN: 0 dòng = đã huỷ trước đó. */
  async markCancelled(
    tx: Prisma.TransactionClient,
    id: string,
    data: { cancelledBy: string; reason: string | null },
  ): Promise<number> {
    const now = new Date();
    const result = await tx.supplierDebtAdjustment.updateMany({
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
}
