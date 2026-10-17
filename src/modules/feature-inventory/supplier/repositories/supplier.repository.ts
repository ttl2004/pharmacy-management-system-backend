import { Injectable } from '@nestjs/common';
import { Prisma, Supplier } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class SupplierRepository extends PrismaBaseRepository<Supplier> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Supplier');
  }

  findActiveWith(tx: Prisma.TransactionClient, id: string): Promise<Supplier | null> {
    return tx.supplier.findFirst({ where: { id, isDeleted: false } });
  }

  createWith(tx: Prisma.TransactionClient, data: Prisma.SupplierUncheckedCreateInput): Promise<Supplier> {
    return tx.supplier.create({ data });
  }

  updateWith(tx: Prisma.TransactionClient, id: string, data: Prisma.SupplierUncheckedUpdateInput): Promise<Supplier> {
    return tx.supplier.update({ where: { id }, data });
  }

  /**
   * Chứng từ kho còn trỏ tới nhà cung cấp — đếm cả chứng từ đã huỷ/xoá mềm: xoá mềm không giải phóng quan hệ và
   * lịch sử nhập hàng phải còn đọc được nhà cung cấp.
   */
  async countReferences(tx: Prisma.TransactionClient, id: string): Promise<number> {
    const [receipts, adjustments, batches] = await Promise.all([
      tx.goodsReceipt.count({ where: { supplierId: id } }),
      tx.stockAdjustment.count({ where: { supplierId: id } }),
      tx.stockBatch.count({ where: { supplierId: id } }),
    ]);
    return receipts + adjustments + batches;
  }
}
