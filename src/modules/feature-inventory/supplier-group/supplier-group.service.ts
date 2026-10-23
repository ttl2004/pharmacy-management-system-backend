import { Injectable } from '@nestjs/common';
import { AuditAction, SupplierGroup } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { diffFields, pickAuditFields } from 'src/providers/audit-log/audit-diff';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { InventoryTransactions } from '../core/inventory-transactions';
import { CreateSupplierGroupRequest, UpdateSupplierGroupRequest } from './dtos/supplier-group.request';
import { SupplierGroupRepository } from './repositories/supplier-group.repository';

const AUDITED_FIELDS = ['name', 'note'] as const;

/** Nhóm NCC: danh mục dùng chung toàn chuỗi. Mọi thao tác ghi đi chung transaction với dòng nhật ký. */
@Injectable()
export class SupplierGroupService {
  constructor(
    private readonly groups: SupplierGroupRepository,
    private readonly transactions: InventoryTransactions,
    private readonly audit: AuditLogService,
  ) {}

  list(): Promise<SupplierGroup[]> {
    return this.groups.findAll();
  }

  create(dto: CreateSupplierGroupRequest, actor: RequestActor): Promise<SupplierGroup> {
    return this.transactions.run(async ({ tx }) => {
      await this.assertNameFree(tx, dto.name);
      const created = await this.groups.createWith(tx, {
        name: dto.name,
        note: dto.note ?? null,
        createdBy: actor.user.userId,
      });
      await this.audit.record(tx, [
        {
          actorId: actor.user.userId,
          action: AuditAction.CREATE,
          entityType: AUDIT_ENTITY.SUPPLIER_GROUP,
          entityId: created.id,
          after: pickAuditFields(created, AUDITED_FIELDS),
          ipAddress: actor.ip,
        },
      ]);
      return created;
    });
  }

  update(id: string, dto: UpdateSupplierGroupRequest, actor: RequestActor): Promise<SupplierGroup> {
    if (Object.keys(dto).length === 0) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Cần gửi ít nhất một trường để cập nhật' });
    }
    return this.transactions.run(async ({ tx }) => {
      const existing = await this.groups.findActiveWith(tx, id);
      if (!existing) throw this.notFound();
      if (dto.name !== undefined) await this.assertNameFree(tx, dto.name, id);

      const changes: Partial<SupplierGroup> = {};
      if (dto.name !== undefined) changes.name = dto.name;
      if (dto.note !== undefined) changes.note = dto.note;
      const updated = await this.groups.updateWith(tx, id, {
        ...changes,
        updatedAt: new Date(),
        updatedBy: actor.user.userId,
      });

      const diff = diffFields(existing, changes, AUDITED_FIELDS);
      if (diff) {
        await this.audit.record(tx, [
          {
            actorId: actor.user.userId,
            action: AuditAction.UPDATE,
            entityType: AUDIT_ENTITY.SUPPLIER_GROUP,
            entityId: id,
            ...diff,
            ipAddress: actor.ip,
          },
        ]);
      }
      return updated;
    });
  }

  /** Xoá mềm; NCC thuộc nhóm được đưa về chưa phân nhóm trong cùng transaction. */
  async remove(id: string, actor: RequestActor): Promise<{ success: true }> {
    await this.transactions.run(async ({ tx }) => {
      const existing = await this.groups.findActiveWith(tx, id);
      if (!existing) throw this.notFound();

      const detached = await this.groups.detachSuppliersWith(tx, id);
      await this.groups.updateWith(tx, id, { isDeleted: true, updatedAt: new Date(), updatedBy: actor.user.userId });
      await this.audit.record(tx, [
        {
          actorId: actor.user.userId,
          action: AuditAction.DELETE,
          entityType: AUDIT_ENTITY.SUPPLIER_GROUP,
          entityId: id,
          before: { ...pickAuditFields(existing, AUDITED_FIELDS), detachedSuppliers: detached },
          ipAddress: actor.ip,
        },
      ]);
    });
    return { success: true };
  }

  private async assertNameFree(tx: Parameters<SupplierGroupRepository['nameTakenWith']>[0], name: string, exceptId?: string) {
    if (await this.groups.nameTakenWith(tx, name, exceptId)) {
      throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: 'Tên nhóm nhà cung cấp đã tồn tại' });
    }
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Nhóm nhà cung cấp không tồn tại' });
  }
}
