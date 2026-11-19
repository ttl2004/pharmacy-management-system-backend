import { Injectable } from '@nestjs/common';
import { Branch, Prisma, ReceiptStatus, TransferStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class BranchRepository extends PrismaBaseRepository<Branch> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Branch');
  }

  /**
   * Đếm người dùng còn trỏ tới chi nhánh, **kể cả** người dùng đã xoá mềm — cố ý không lọc
   * `isDeleted`, vì xoá mềm không giải phóng quan hệ và bản ghi đó vẫn có thể được khôi phục.
   */
  countReferencingUsers(branchId: string): Promise<number> {
    return this.prisma.user.count({ where: { branchId } });
  }

  /**
   * Hàng còn trong kho chi nhánh hoặc chứng từ kho đang mở (phiếu nhập/điều chỉnh nháp, điều chuyển chưa xong ở
   * cả chiều gửi lẫn nhận). Lịch sử đã đóng không chặn xoá mềm — xoá mềm không làm mất lịch sử.
   */
  async hasOpenInventory(branchId: string): Promise<boolean> {
    const [stock, receipts, transfers, adjustments] = await Promise.all([
      this.prisma.stockBatch.count({ where: { branchId, quantityOnHand: { gt: 0 } } }),
      this.prisma.goodsReceipt.count({ where: { branchId, isDeleted: false, status: ReceiptStatus.DRAFT } }),
      this.prisma.stockTransfer.count({
        where: {
          isDeleted: false,
          status: { in: [TransferStatus.PENDING, TransferStatus.IN_TRANSIT] },
          OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
        },
      }),
      this.prisma.stockAdjustment.count({ where: { branchId, isDeleted: false, status: ReceiptStatus.DRAFT } }),
    ]);
    return stock + receipts + transfers + adjustments > 0;
  }

  /**
   * M2: nợ NCC còn lại của chi nhánh, theo từng NCC (chỉ NCC còn nợ ≠ 0). Cùng công thức `SupplierDebtRepository.debtOf`
   * phạm vi chi nhánh: phiếu nhập (tổng − đã trả) − phiếu trả NCC (cần trả − NCC đã trả) + điều chỉnh nợ của chi nhánh.
   */
  async findOutstandingSupplierDebts(branchId: string): Promise<{ supplierId: string; debt: bigint }[]> {
    return this.prisma.$queryRaw<{ supplierId: string; debt: bigint }[]>(Prisma.sql`
      SELECT e."supplierId", SUM(e."amount")::bigint AS "debt"
      FROM (
        SELECT r."supplierId", r."totalAmount" - r."paidAmount" AS "amount"
        FROM "goods_receipts" r
        WHERE r."branchId" = ${branchId}::uuid AND r."status" = 'CONFIRMED' AND r."isDeleted" = false
        UNION ALL
        SELECT a."supplierId", -(a."totalAmount" - a."supplierPaid")
        FROM "stock_adjustments" a
        WHERE a."branchId" = ${branchId}::uuid AND a."type" = 'RETURN_TO_SUPPLIER' AND a."status" = 'CONFIRMED'
          AND a."isDeleted" = false AND a."supplierId" IS NOT NULL
        UNION ALL
        SELECT d."supplierId", d."delta"
        FROM "supplier_debt_adjustments" d
        WHERE d."branchId" = ${branchId}::uuid AND d."cancelledAt" IS NULL
      ) e
      GROUP BY e."supplierId"
      HAVING SUM(e."amount") <> 0`);
  }
}
