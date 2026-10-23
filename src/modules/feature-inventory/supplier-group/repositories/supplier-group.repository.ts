import { Injectable } from '@nestjs/common';
import { Prisma, SupplierGroup } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

@Injectable()
export class SupplierGroupRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Mọi nhóm chưa xoá, xếp theo tên (không phân trang). */
  findAll(): Promise<SupplierGroup[]> {
    return this.prisma.supplierGroup.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' } });
  }

  findActiveWith(tx: Prisma.TransactionClient, id: string): Promise<SupplierGroup | null> {
    return tx.supplierGroup.findFirst({ where: { id, isDeleted: false } });
  }

  /** Trùng tên không phân biệt hoa thường với nhóm chưa xoá (bỏ qua chính nhóm `exceptId`). */
  async nameTakenWith(tx: Prisma.TransactionClient, name: string, exceptId?: string): Promise<boolean> {
    const count = await tx.supplierGroup.count({
      where: {
        isDeleted: false,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    return count > 0;
  }

  createWith(tx: Prisma.TransactionClient, data: Prisma.SupplierGroupUncheckedCreateInput): Promise<SupplierGroup> {
    return tx.supplierGroup.create({ data });
  }

  updateWith(tx: Prisma.TransactionClient, id: string, data: Prisma.SupplierGroupUncheckedUpdateInput) {
    return tx.supplierGroup.update({ where: { id }, data });
  }

  /** Đưa mọi NCC của nhóm về chưa phân nhóm; trả số NCC bị gỡ. */
  async detachSuppliersWith(tx: Prisma.TransactionClient, groupId: string): Promise<number> {
    const result = await tx.supplier.updateMany({ where: { groupId }, data: { groupId: null } });
    return result.count;
  }
}
