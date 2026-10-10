import { Injectable } from '@nestjs/common';
import { Unit } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { CreateUnitRequest, UpdateUnitRequest } from './dtos/unit.request';
import { UnitQuery } from './dtos/unit.query';
import { UnitRepository } from './repositories/unit.repository';

@Injectable()
export class UnitService extends AbstractBaseService<Unit> {
  constructor(private readonly unitRepository: UnitRepository) {
    super(unitRepository);
  }

  async list(query: UnitQuery) {
    const filter: BaseWhere<Unit> = {};

    return this.unitRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search,
      searchFields: ['code', 'name'],
    });
  }

  async getDetail(id: string): Promise<Unit> {
    const unit = await this.unitRepository.findOne({ id });
    if (!unit) throw this.notFound();
    return unit;
  }

  async create(dto: CreateUnitRequest, callerId: string): Promise<Unit> {
    try {
      return await this.unitRepository.create({
        code: dto.code,
        name: dto.name,
        note: dto.note ?? null,
        createdBy: callerId,
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async update(id: string, dto: UpdateUnitRequest, callerId: string): Promise<Unit> {
    if (Object.keys(dto).length === 0) throw this.badRequest('Cần gửi ít nhất một trường để cập nhật');

    const data: Partial<Unit> = { updatedBy: callerId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.note !== undefined) data.note = dto.note;

    try {
      const updated = await this.unitRepository.update({ id }, data);
      if (!updated) throw this.notFound();
      return updated;
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async remove(id: string): Promise<{ success: true }> {
    const existing = await this.unitRepository.findOne({ id });
    if (!existing) throw this.notFound();

    if ((await this.unitRepository.countBaseProducts(id)) > 0) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: 'Không thể xoá đơn vị đang là đơn vị cơ bản của sản phẩm',
      });
    }
    if ((await this.unitRepository.countProductUnits(id)) > 0) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: 'Không thể xoá đơn vị đang được cấu hình đơn vị bán của sản phẩm tham chiếu',
      });
    }

    const deleted = await this.unitRepository.softDelete({ id });
    if (!deleted) throw this.notFound();

    return { success: true };
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Đơn vị tính không tồn tại' });
  }

  private badRequest(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
  }
}
