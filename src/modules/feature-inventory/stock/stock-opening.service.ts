import { Injectable } from '@nestjs/common';
import { RecordStatus, StockMovementType, StockRefType } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { assertBranchInScope, resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { InventoryTransactions } from '../core/inventory-transactions';
import { StockIntakeService } from '../core/stock-intake.service';
import { OpeningStockRequest } from './dtos/opening-stock.request';

/** Quy ước FE cho hàng không theo lô (R5): một lô giả, hạn canh gác. */
const NO_LOT_BATCH = 'KHONG-LO';
const NO_EXPIRY = new Date('2999-12-31T00:00:00.000Z');

/**
 * Tồn đầu kỳ của hàng KHÔNG theo lô, nhập lúc tạo hàng (như KiotViet "Tồn kho ban đầu"). Hàng theo lô phải nhập qua
 * phiếu nhập (có số lô, hạn dùng). Đi chung thuật toán `StockIntakeService` nên giá vốn, sổ kho nhất quán với phiếu
 * nhập; bút toán IMPORT tham chiếu `OPENING_STOCK` + id sản phẩm. Chỉ cho khi sản phẩm chưa từng có lô ở chi nhánh đó.
 */
@Injectable()
export class StockOpeningService {
  constructor(
    private readonly transactions: InventoryTransactions,
    private readonly intake: StockIntakeService,
    private readonly audit: AuditLogService,
  ) {}

  async create(dto: OpeningStockRequest, actor: RequestActor): Promise<{ batchId: string }> {
    assertBranchInScope(resolveBranchScope(actor.user), dto.branchId);

    return this.transactions.run(async (ctx) => {
      const { tx } = ctx;
      const [branch, product] = await Promise.all([
        tx.branch.findFirst({
          where: { id: dto.branchId, isDeleted: false, status: RecordStatus.ACTIVE },
          select: { id: true },
        }),
        tx.product.findFirst({
          where: { id: dto.productId, isDeleted: false },
          select: { id: true, code: true, name: true, trackBatches: true },
        }),
      ]);
      if (!branch) throw this.error(ErrorCode.INVALID_REFERENCE, 'Chi nhánh không tồn tại hoặc đã ngừng hoạt động');
      if (!product) throw this.error(ErrorCode.RECORD_NOT_FOUND, 'Sản phẩm không tồn tại');
      if (product.trackBatches) {
        throw this.error(ErrorCode.HTTP_BAD_REQUEST, 'Hàng quản lý theo lô nhập tồn qua phiếu nhập kho (có số lô)');
      }
      const existing = await tx.stockBatch.count({ where: { productId: dto.productId, branchId: dto.branchId } });
      if (existing > 0) {
        throw this.error(
          ErrorCode.PRODUCT_HAS_STOCK,
          'Sản phẩm đã phát sinh kho ở chi nhánh này, không nhập tồn đầu được',
        );
      }

      const result = await this.intake.intake(ctx, {
        branchId: dto.branchId,
        type: StockMovementType.IMPORT,
        refType: StockRefType.OPENING_STOCK,
        refId: dto.productId,
        actorId: actor.user.userId,
        lines: [
          {
            productId: dto.productId,
            batchNumber: NO_LOT_BATCH,
            manufacturingDate: null,
            expiryDate: NO_EXPIRY,
            quantity: dto.quantity,
            unitCost: dto.unitCost,
            supplierId: null,
            goodsReceiptItemId: null,
            refItemId: dto.productId,
          },
        ],
      });
      const batchId = result.batchIdByRefItem.get(dto.productId);
      if (!batchId) throw new Error('Không ghi được lô tồn đầu');
      // Một lần record cho cả transaction: lô tồn đầu có thể thừa hưởng thu hồi của cùng số lô ở chi nhánh khác
      // (entry của intake) cộng với chính sự kiện tồn đầu kỳ.
      await this.audit.record(tx, auditActorOf(actor), [
        ...result.auditEntries,
        {
          event: 'STOCK.OPENING',
          entityType: 'products',
          entityId: product.id,
          entityLabel: product.code,
          branchIds: [dto.branchId],
          searchTerms: [product.code, product.name],
          // Tiền bigint: Σ quantity × unitCost (một dòng).
          amount: BigInt(dto.quantity) * BigInt(dto.unitCost),
          metadata: { batchId, quantity: dto.quantity, unitCost: String(dto.unitCost) },
        },
      ]);
      return { batchId };
    });
  }

  private error(code: ErrorCode, message: string): ErrorException {
    return new ErrorException({ code, message });
  }
}
