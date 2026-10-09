import { Injectable } from '@nestjs/common';
import { Branch, RecordStatus } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { CreateBranchRequest, UpdateBranchRequest } from './dtos/branch.request';
import { BranchQuery } from './dtos/branch.query';
import { BranchRepository } from './repositories/branch.repository';

@Injectable()
export class BranchService extends AbstractBaseService<Branch> {
  constructor(private readonly branchRepository: BranchRepository) {
    super(branchRepository);
  }

  async list(query: BranchQuery) {
    const filter: BaseWhere<Branch> = {};
    if (query.status) filter.status = query.status;

    return this.branchRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search,
      searchFields: ['code', 'name', 'phone'],
    });
  }

  async getDetail(id: string): Promise<Branch> {
    const branch = await this.branchRepository.findOne({ id });
    if (!branch) throw this.notFound();
    return branch;
  }

  async create(dto: CreateBranchRequest, callerId: string): Promise<Branch> {
    try {
      return await this.branchRepository.create({
        code: dto.code,
        name: dto.name,
        phone: dto.phone,
        email: dto.email ?? null,
        address: dto.address,
        openingHours: dto.openingHours ?? null,
        status: dto.status ?? RecordStatus.ACTIVE,
        createdBy: callerId,
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async update(id: string, dto: UpdateBranchRequest, callerId: string): Promise<Branch> {
    if (Object.keys(dto).length === 0) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: 'Cần gửi ít nhất một trường để cập nhật',
      });
    }

    const data: Partial<Branch> = { updatedBy: callerId };
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

  async remove(id: string): Promise<{ success: true }> {
    const existing = await this.branchRepository.findOne({ id });
    if (!existing) throw this.notFound();

    const referencing = await this.branchRepository.countReferencingUsers(id);
    if (referencing > 0) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: 'Không thể xoá chi nhánh đang được người dùng tham chiếu',
      });
    }

    const deleted = await this.branchRepository.softDelete({ id });
    if (!deleted) throw this.notFound();

    return { success: true };
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Chi nhánh không tồn tại' });
  }
}
