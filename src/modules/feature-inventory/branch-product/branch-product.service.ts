import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, RecordStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { resolveWriteBranch } from '../core/inventory-scope';
import { InventoryTransactions } from '../core/inventory-transactions';
import { BranchProductQuery, UpsertBranchProductRequest } from './dtos/branch-product.request';

const ROW_SELECT = {
  id: true,
  branchId: true,
  productId: true,
  minStockLevel: true,
  updatedAt: true,
  createdAt: true,
  branch: { select: { id: true, code: true, name: true } },
  product: { select: { id: true, code: true, name: true, minStockLevel: true } },
} satisfies Prisma.BranchProductSelect;

/**
 * Ngưỡng tồn riêng của chi nhánh, ghi đè `products.minStockLevel`. Không có dòng = dùng ngưỡng chung. Bảng nhỏ,
 * thao tác đơn giản nên đi thẳng Prisma trong service, không tách repository.
 */
@Injectable()
export class BranchProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: InventoryTransactions,
    private readonly audit: AuditLogService,
  ) {}

  async list(query: BranchProductQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    const where: Prisma.BranchProductWhereInput = { isDeleted: false };
    if (branchId) where.branchId = branchId;
    if (query.productId) where.productId = query.productId;
    const [hits, total] = await Promise.all([
      this.prisma.branchProduct.findMany({
        where,
        select: ROW_SELECT,
        orderBy: [{ product: { name: 'asc' } }, { id: 'asc' }],
        take: query.limit,
        skip: (query.page - 1) * query.limit,
      }),
      this.prisma.branchProduct.count({ where }),
    ]);
    return { hits, total, page: query.page, totalPages: Math.ceil(total / query.limit), limit: query.limit };
  }

  async upsert(dto: UpsertBranchProductRequest, actor: RequestActor) {
    const branchId = resolveWriteBranch(resolveBranchScope(actor.user), dto.branchId);
    const actorId = actor.user.userId;

    return this.transactions.run(async ({ tx }) => {
      await this.assertReferences(tx, branchId, dto.productId);
      const existing = await tx.branchProduct.findUnique({
        where: { branchId_productId: { branchId, productId: dto.productId } },
      });
      // `select` chỉ lấy id để Prisma sinh `INSERT … ON CONFLICT DO UPDATE` ngay trong DB: chọn kèm quan hệ thì Prisma
      // tự tách thành "tìm rồi tạo" → hai PUT đồng thời lần đầu (bấm đúp) cùng tạo, request sau nổ P2002 thành 500.
      const { id } = await tx.branchProduct.upsert({
        where: { branchId_productId: { branchId, productId: dto.productId } },
        create: { branchId, productId: dto.productId, minStockLevel: dto.minStockLevel, createdBy: actorId },
        update: { minStockLevel: dto.minStockLevel, isDeleted: false, updatedAt: new Date(), updatedBy: actorId },
        select: { id: true },
      });
      const row = await tx.branchProduct.findUniqueOrThrow({ where: { id }, select: ROW_SELECT });
      const before = existing && !existing.isDeleted ? existing.minStockLevel : null;
      if (before !== dto.minStockLevel) {
        await this.audit.record(tx, [
          {
            actorId,
            action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
            entityType: AUDIT_ENTITY.BRANCH_PRODUCT,
            entityId: row.id,
            branchId,
            before: existing ? { minStockLevel: before } : null,
            after: { minStockLevel: dto.minStockLevel, productId: dto.productId },
            ipAddress: actor.ip,
          },
        ]);
      }
      return row;
    });
  }

  /** Bỏ ngưỡng riêng — chi nhánh quay về ngưỡng chung của sản phẩm. */
  async remove(productId: string, requestedBranchId: string | undefined, actor: RequestActor) {
    const branchId = resolveWriteBranch(resolveBranchScope(actor.user), requestedBranchId);
    const actorId = actor.user.userId;

    await this.transactions.run(async ({ tx }) => {
      const existing = await tx.branchProduct.findFirst({ where: { branchId, productId, isDeleted: false } });
      if (!existing) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Chưa đặt ngưỡng riêng' });
      await tx.branchProduct.update({
        where: { id: existing.id },
        data: { isDeleted: true, updatedAt: new Date(), updatedBy: actorId },
      });
      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.DELETE,
          entityType: AUDIT_ENTITY.BRANCH_PRODUCT,
          entityId: existing.id,
          branchId,
          before: { minStockLevel: existing.minStockLevel, productId },
          ipAddress: actor.ip,
        },
      ]);
    });
    return { success: true as const };
  }

  private async assertReferences(tx: Prisma.TransactionClient, branchId: string, productId: string) {
    const [branch, product] = await Promise.all([
      tx.branch.findFirst({ where: { id: branchId, isDeleted: false }, select: { id: true } }),
      tx.product.findFirst({
        where: { id: productId, isDeleted: false, status: RecordStatus.ACTIVE },
        select: { id: true },
      }),
    ]);
    if (!branch || !product) {
      throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Chi nhánh hoặc sản phẩm không tồn tại' });
    }
  }
}
