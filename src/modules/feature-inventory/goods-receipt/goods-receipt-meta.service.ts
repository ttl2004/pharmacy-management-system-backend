import { Injectable } from '@nestjs/common';
import { AuditAction, ReceiptStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { resolveBranchScope, scopedBranchFilter } from 'src/modules/feature-auth/permission/branch-scope';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { badRequest, documentErrors, invalidReference } from '../core/inventory.error';
import { branchWhere } from '../core/inventory-scope';
import { InventoryTransactions } from '../core/inventory-transactions';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { ReceiversQuery } from './dtos/goods-receipt.query';
import { UpdateReceiptMetaRequest } from './dtos/goods-receipt-meta.request';
import { GoodsReceiptLocker } from './goods-receipt-locker';
import { GoodsReceiptDetail, GoodsReceiptRepository } from './repositories/goods-receipt.repository';

const errors = documentErrors('Phiếu nhập');

/** Người nhập + sửa thông tin phiếu ĐÃ NHẬP (không đụng tồn, giá vốn, công nợ). */
@Injectable()
export class GoodsReceiptMetaService {
  constructor(
    private readonly receipts: GoodsReceiptRepository,
    private readonly locker: GoodsReceiptLocker,
    private readonly transactions: InventoryTransactions,
    private readonly audit: AuditLogService,
  ) {}

  /** Nhân sự có thể chọn làm người nhập. PM/nhân viên bị ép về chi nhánh mình. */
  listReceivers(query: ReceiversQuery, actor: RequestActor) {
    const branchId = scopedBranchFilter(resolveBranchScope(actor.user), query.branchId);
    return this.receipts.findReceiverCandidates(branchId);
  }

  /** Chỉ phiếu CONFIRMED; body rỗng → 1002. Đổi trạng thái có điều kiện nên không đè lên huỷ đồng thời. */
  async updateMeta(id: string, dto: UpdateReceiptMetaRequest, actor: RequestActor): Promise<GoodsReceiptDetail> {
    if (dto.receiverId === undefined && dto.receivedAt === undefined && dto.note === undefined) {
      throw badRequest('Cần gửi ít nhất một trong receiverId, receivedAt, note');
    }
    const scope = resolveBranchScope(actor.user);
    const actorId = actor.user.userId;

    return this.transactions.run(async ({ tx }) => {
      const head = await this.locker.lock(tx, id, branchWhere(scope));
      if (head.status !== ReceiptStatus.CONFIRMED) throw errors.wrongState(head.status);
      // Chỉ kiểm lại khi ĐỔI người nhập: người nhập cũ đã nghỉ/chuyển chi nhánh vẫn giữ nguyên để sửa ghi chú, ngày nhập.
      const receiverChanged = !!dto.receiverId && dto.receiverId !== head.receiverId;
      if (receiverChanged && !(await this.receipts.isValidReceiver(tx, dto.receiverId!, head.branchId))) {
        throw invalidReference('người nhập không thuộc chi nhánh của phiếu hoặc không còn hoạt động');
      }

      const receiverId = dto.receiverId === undefined ? head.receiverId : dto.receiverId;
      const receivedAt = dto.receivedAt === undefined ? head.receivedAt : new Date(dto.receivedAt);
      const note = dto.note === undefined ? head.note : dto.note?.trim() || null;

      const changed = await this.receipts.transition(tx, id, ReceiptStatus.CONFIRMED, {
        receiverId,
        receivedAt,
        note,
        updatedAt: new Date(),
        updatedBy: actorId,
      });
      if (!changed) throw errors.wrongState();

      await this.audit.record(tx, [
        {
          actorId,
          action: AuditAction.UPDATE,
          entityType: AUDIT_ENTITY.GOODS_RECEIPT,
          entityId: id,
          branchId: head.branchId,
          before: { receiverId: head.receiverId, receivedAt: head.receivedAt?.toISOString() ?? null, note: head.note },
          after: { receiverId, receivedAt: receivedAt?.toISOString() ?? null, note },
          ipAddress: actor.ip,
        },
      ]);
      const receipt = await this.receipts.findDetail(id, {}, tx);
      if (!receipt) throw errors.notFound();
      return receipt;
    });
  }
}
