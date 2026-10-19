import { Injectable } from '@nestjs/common';
import { Branch, RecordStatus } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import type { JwtUser } from 'src/modules/feature-auth/authz/types/authz.types';
import { isInBranchScope, resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { permissionError } from 'src/modules/feature-auth/permission/permission.error';
import { CreateBranchRequest, UpdateBranchRequest } from './dtos/branch.request';
import { BranchQuery } from './dtos/branch.query';
import { BranchRepository } from './repositories/branch.repository';

/**
 * Chi nhánh cũng chịu phạm vi chi nhánh như mọi dữ liệu khác: vai trò BRANCH chỉ thấy/đụng tới chi nhánh của
 * mình. Ghi mặc định chỉ ADMIN có quyền, nhưng SUPER_ADMIN có thể tick thêm quyền cho vai trò BRANCH trên ma
 * trận quyền — nên service vẫn chặn theo phạm vi, không chỉ dựa vào `PermissionGuard`.
 */
@Injectable()
export class BranchService extends AbstractBaseService<Branch> {
  constructor(private readonly branchRepository: BranchRepository) {
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

  async create(dto: CreateBranchRequest, caller: JwtUser): Promise<Branch> {
    // Tạo chi nhánh là việc của cả chuỗi: vai trò BRANCH không được tạo dù đã được cấp quyền.
    if (resolveBranchScope(caller).kind !== 'ALL') throw permissionError(ErrorCode.BRANCH_ACCESS_DENIED);
    try {
      return await this.branchRepository.create({
        code: dto.code,
        name: dto.name,
        phone: dto.phone,
        email: dto.email ?? null,
        address: dto.address,
        openingHours: dto.openingHours ?? null,
        status: dto.status ?? RecordStatus.ACTIVE,
        createdBy: caller.userId,
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async update(id: string, dto: UpdateBranchRequest, caller: JwtUser): Promise<Branch> {
    if (Object.keys(dto).length === 0) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: 'Cần gửi ít nhất một trường để cập nhật',
      });
    }
    await this.findInScope(id, caller);

    const data: Partial<Branch> = { updatedBy: caller.userId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.openingHours !== undefined) data.openingHours = dto.openingHours;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      const updated = await this.branchRepository.update({ id }, data);
      if (!updated) throw this.notFound();
      return updated;
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async remove(id: string, caller: JwtUser): Promise<{ success: true }> {
    await this.findInScope(id, caller);

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

    const deleted = await this.branchRepository.softDelete({ id });
    if (!deleted) throw this.notFound();

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
