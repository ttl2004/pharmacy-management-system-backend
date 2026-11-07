import { Injectable } from '@nestjs/common';
import { Branch, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { maskPhone } from 'src/common/utils/mask.util';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { diffFields, pickAuditFields } from 'src/providers/audit-log/audit-diff';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { AuditJson } from 'src/providers/audit-log/audit-log.types';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import type { JwtUser } from 'src/modules/feature-auth/authz/types/authz.types';
import { isInBranchScope, resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { permissionError } from 'src/modules/feature-auth/permission/permission.error';
import { CreateBranchRequest, UpdateBranchRequest } from './dtos/branch.request';
import { BranchQuery } from './dtos/branch.query';
import { BranchRepository } from './repositories/branch.repository';

const AUDITED_FIELDS = ['code', 'name', 'phone', 'address', 'email', 'openingHours', 'status'] as const;

/** Không bao giờ ghi SĐT đầy đủ vào nhật ký: che còn 4 số cuối. */
function maskSnapshot(snapshot: Record<string, AuditJson>): Record<string, AuditJson> {
  if (!('phone' in snapshot)) return snapshot;
  return { ...snapshot, phone: maskPhone(snapshot.phone as string | null) };
}

/** Phạm vi của dòng nhật ký chi nhánh là chính chi nhánh đó, để quản lý chi nhánh thấy lịch sử của mình. */
function auditBase(branch: Pick<Branch, 'id' | 'code' | 'name'>) {
  return {
    entityType: 'branches',
    entityId: branch.id,
    entityLabel: branch.code,
    branchIds: [branch.id],
    searchTerms: [branch.code, branch.name],
  };
}

/**
 * Chi nhánh cũng chịu phạm vi chi nhánh như mọi dữ liệu khác: vai trò BRANCH chỉ thấy/đụng tới chi nhánh của
 * mình. Ghi mặc định chỉ ADMIN có quyền, nhưng SUPER_ADMIN có thể tick thêm quyền cho vai trò BRANCH trên ma
 * trận quyền — nên service vẫn chặn theo phạm vi, không chỉ dựa vào `PermissionGuard`.
 */
@Injectable()
export class BranchService extends AbstractBaseService<Branch> {
  constructor(
    private readonly branchRepository: BranchRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {
    super(branchRepository);
  }

  async list(query: BranchQuery, caller: JwtUser) {
    const scope = resolveBranchScope(caller);
    const filter: BaseWhere<Branch> = {};
    if (scope.kind === 'BRANCH') filter.id = scope.branchId;
    if (query.status) filter.status = query.status;

    return this.branchRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search,
      searchFields: ['code', 'name', 'phone'],
    });
  }

  async getDetail(id: string, caller: JwtUser): Promise<Branch> {
    return this.findInScope(id, caller);
  }

  async create(dto: CreateBranchRequest, actor: RequestActor): Promise<Branch> {
    const caller = actor.user;
    // Tạo chi nhánh là việc của cả chuỗi: vai trò BRANCH không được tạo dù đã được cấp quyền.
    if (resolveBranchScope(caller).kind !== 'ALL') throw permissionError(ErrorCode.BRANCH_ACCESS_DENIED);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await this.branchRepository.create(
          {
            code: dto.code,
            name: dto.name,
            phone: dto.phone,
            email: dto.email ?? null,
            address: dto.address,
            openingHours: dto.openingHours ?? null,
            status: dto.status ?? RecordStatus.ACTIVE,
            createdBy: caller.userId,
          },
          tx,
        );
        await this.audit.record(tx, auditActorOf(actor), [
          {
            event: 'BRANCH.CREATED',
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

  async update(id: string, dto: UpdateBranchRequest, actor: RequestActor): Promise<Branch> {
    const caller = actor.user;
    if (Object.keys(dto).length === 0) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: 'Cần gửi ít nhất một trường để cập nhật',
      });
    }
    const existing = await this.findInScope(id, caller);

    const data: Partial<Branch> = { updatedBy: caller.userId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.openingHours !== undefined) data.openingHours = dto.openingHours;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await this.branchRepository.update({ id }, data, undefined, tx);
        if (!updated) throw this.notFound();

        const diff = diffFields(existing, data, AUDITED_FIELDS);
        if (diff) {
          await this.audit.record(tx, auditActorOf(actor), [
            {
              event: 'BRANCH.UPDATED',
              ...auditBase({ ...existing, ...data }),
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

  /** `reason` tuỳ chọn (DELETE không có body nên đi qua `?reason=`). */
  async remove(id: string, actor: RequestActor, reason?: string): Promise<{ success: true }> {
    const existing = await this.findInScope(id, actor.user);

    const referencing = await this.branchRepository.countReferencingUsers(id);
    if (referencing > 0) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: 'Không thể xoá chi nhánh đang được người dùng tham chiếu',
      });
    }
    if (await this.branchRepository.hasOpenInventory(id)) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: 'Chi nhánh còn hàng trong kho hoặc chứng từ kho chưa xong, không thể xoá',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const deleted = await this.branchRepository.softDelete({ id }, tx);
      if (!deleted) throw this.notFound();
      await this.audit.record(tx, auditActorOf(actor), [
        {
          event: 'BRANCH.DELETED',
          ...auditBase(existing),
          before: maskSnapshot(pickAuditFields(existing, AUDITED_FIELDS)),
          reason: reason?.trim() || null,
        },
      ]);
    });

    return { success: true };
  }

  /** Đọc chi nhánh rồi kiểm phạm vi: không có → 1600; có nhưng ngoài phạm vi người gọi → 1506. */
  private async findInScope(id: string, caller: JwtUser): Promise<Branch> {
    const scope = resolveBranchScope(caller);
    const branch = await this.branchRepository.findOne({ id });
    if (!branch) throw this.notFound();
    if (!isInBranchScope(scope, branch.id)) throw permissionError(ErrorCode.BRANCH_ACCESS_DENIED);
    return branch;
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Chi nhánh không tồn tại' });
  }
}
