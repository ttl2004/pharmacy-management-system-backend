import { Injectable } from '@nestjs/common';
import { Prisma, RecordStatus, Supplier } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { maskPhone } from 'src/common/utils/mask.util';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { diffFields, pickAuditFields } from 'src/providers/audit-log/audit-diff';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { AuditJson } from 'src/providers/audit-log/audit-log.types';
import { AUDIT_ENTITY } from '../core/inventory.constants';
import { InventoryTransactions } from '../core/inventory-transactions';
import { CreateSupplierRequest, UpdateSupplierRequest } from './dtos/supplier.request';
import { SupplierRepository } from './repositories/supplier.repository';

/** Trường được theo dõi trong nhật ký thao tác. */
const AUDITED_FIELDS = [
  'code',
  'name',
  'phone',
  'email',
  'address',
  'taxCode',
  'contactName',
  'note',
  'status',
  'groupId',
  'companyName',
  'idNumber',
] as const;

/** Không bao giờ ghi SĐT đầy đủ vào nhật ký: che còn 4 số cuối. */
function maskSnapshot(snapshot: Record<string, AuditJson>): Record<string, AuditJson> {
  if (!('phone' in snapshot)) return snapshot;
  return { ...snapshot, phone: maskPhone(snapshot.phone as string | null) };
}

/** Nhãn, phạm vi (danh mục toàn chuỗi → `[]`) và từ khoá tìm kiếm (mã + tên, D8) của một dòng NCC. */
function auditBase(supplier: Pick<Supplier, 'id' | 'code' | 'name'>) {
  return {
    entityType: AUDIT_ENTITY.SUPPLIER,
    entityId: supplier.id,
    entityLabel: supplier.code,
    branchIds: [],
    searchTerms: [supplier.code, supplier.name],
  };
}

/**
 * Nhà cung cấp là danh mục dùng chung toàn chuỗi (không có `branchId`): mọi vai trò kho đều đọc được, chỉ ADMIN
 * thêm/sửa/xoá (ma trận kho). Mọi thao tác ghi đi chung transaction với dòng `audit_logs` của nó.
 */
@Injectable()
export class SupplierService {
  constructor(
    private readonly suppliers: SupplierRepository,
    private readonly transactions: InventoryTransactions,
    private readonly audit: AuditLogService,
  ) {}

  async create(dto: CreateSupplierRequest, actor: RequestActor): Promise<Supplier> {
    try {
      return await this.transactions.run(async ({ tx }) => {
        await this.assertGroupExists(tx, dto.groupId);
        const created = await this.suppliers.createWith(tx, {
          code: dto.code,
          name: dto.name,
          phone: dto.phone,
          email: dto.email ?? null,
          address: dto.address ?? null,
          taxCode: dto.taxCode ?? null,
          contactName: dto.contactName ?? null,
          note: dto.note ?? null,
          groupId: dto.groupId ?? null,
          companyName: dto.companyName ?? null,
          idNumber: dto.idNumber ?? null,
          status: dto.status ?? RecordStatus.ACTIVE,
          createdBy: actor.user.userId,
        });
        await this.audit.record(tx, auditActorOf(actor), [
          {
            event: 'SUPPLIER.CREATED',
            ...auditBase(created),
            after: maskSnapshot(pickAuditFields(created, AUDITED_FIELDS)),
          },
        ]);
        return created;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async update(id: string, dto: UpdateSupplierRequest, actor: RequestActor): Promise<Supplier> {
    if (Object.keys(dto).length === 0) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Cần gửi ít nhất một trường để cập nhật' });
    }

    try {
      return await this.transactions.run(async ({ tx }) => {
        const existing = await this.suppliers.findActiveWith(tx, id);
        if (!existing) throw this.notFound();
        await this.assertGroupExists(tx, dto.groupId);

        const changes: Partial<Supplier> = {};
        for (const field of AUDITED_FIELDS) {
          if (dto[field] !== undefined) (changes as Record<string, unknown>)[field] = dto[field];
        }
        const updated = await this.suppliers.updateWith(tx, id, {
          ...changes,
          updatedAt: new Date(),
          updatedBy: actor.user.userId,
        });

        const diff = diffFields(existing, changes, AUDITED_FIELDS);
        if (diff) {
          await this.audit.record(tx, auditActorOf(actor), [
            {
              event: diff.after.status !== undefined ? 'SUPPLIER.STATUS_CHANGED' : 'SUPPLIER.UPDATED',
              ...auditBase(updated),
              before: maskSnapshot(diff.before),
              after: maskSnapshot(diff.after),
            },
          ]);
        }
        return updated;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  /** Còn chứng từ kho trỏ tới thì từ chối — muốn ngừng hợp tác thì chuyển `status` sang INACTIVE. */
  async remove(id: string, actor: RequestActor): Promise<{ success: true }> {
    await this.transactions.run(async ({ tx }) => {
      const existing = await this.suppliers.findActiveWith(tx, id);
      if (!existing) throw this.notFound();

      if ((await this.suppliers.countReferences(tx, id)) > 0) {
        throw new ErrorException({
          code: ErrorCode.INVALID_REFERENCE,
          message: 'Nhà cung cấp đã có chứng từ kho, không thể xoá — hãy chuyển sang ngừng hợp tác (INACTIVE)',
        });
      }

      await this.suppliers.updateWith(tx, id, { isDeleted: true, updatedAt: new Date(), updatedBy: actor.user.userId });
      await this.audit.record(tx, auditActorOf(actor), [
        {
          event: 'SUPPLIER.DELETED',
          ...auditBase(existing),
          before: maskSnapshot(pickAuditFields(existing, AUDITED_FIELDS)),
        },
      ]);
    });
    return { success: true };
  }

  /** `groupId` lạ hoặc đã xoá -> 1602. */
  private async assertGroupExists(tx: Prisma.TransactionClient, groupId?: string | null): Promise<void> {
    if (groupId && !(await this.suppliers.groupExistsWith(tx, groupId))) {
      throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Nhóm nhà cung cấp không tồn tại' });
    }
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Nhà cung cấp không tồn tại' });
  }
}
