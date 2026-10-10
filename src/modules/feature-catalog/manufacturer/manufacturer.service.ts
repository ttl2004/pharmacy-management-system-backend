import { Injectable } from '@nestjs/common';
import { Manufacturer, RecordStatus } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { CreateManufacturerRequest, UpdateManufacturerRequest } from './dtos/manufacturer.request';
import { ManufacturerQuery } from './dtos/manufacturer.query';
import { ManufacturerRepository } from './repositories/manufacturer.repository';

@Injectable()
export class ManufacturerService extends AbstractBaseService<Manufacturer> {
  constructor(private readonly manufacturerRepository: ManufacturerRepository) {
    super(manufacturerRepository);
  }

  async list(query: ManufacturerQuery) {
    const filter: BaseWhere<Manufacturer> = {};
    if (query.status) filter.status = query.status;

    return this.manufacturerRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search,
      searchFields: ['code', 'name', 'country'],
    });
  }

  async getDetail(id: string): Promise<Manufacturer> {
    const manufacturer = await this.manufacturerRepository.findOne({ id });
    if (!manufacturer) throw this.notFound();
    return manufacturer;
  }

  async create(dto: CreateManufacturerRequest, callerId: string): Promise<Manufacturer> {
    try {
      return await this.manufacturerRepository.create({
        code: dto.code ?? null,
        name: dto.name,
        country: dto.country ?? null,
        address: dto.address ?? null,
        note: dto.note ?? null,
        status: dto.status ?? RecordStatus.ACTIVE,
        createdBy: callerId,
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async update(id: string, dto: UpdateManufacturerRequest, callerId: string): Promise<Manufacturer> {
    if (Object.keys(dto).length === 0) throw this.badRequest('Cần gửi ít nhất một trường để cập nhật');

    const data: Partial<Manufacturer> = { updatedBy: callerId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      const updated = await this.manufacturerRepository.update({ id }, data);
      if (!updated) throw this.notFound();
      return updated;
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async remove(id: string): Promise<{ success: true }> {
    const existing = await this.manufacturerRepository.findOne({ id });
    if (!existing) throw this.notFound();

    if ((await this.manufacturerRepository.countProducts(id)) > 0) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: 'Không thể xoá hãng sản xuất đang được sản phẩm tham chiếu',
      });
    }

    const deleted = await this.manufacturerRepository.softDelete({ id });
    if (!deleted) throw this.notFound();

    return { success: true };
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Hãng sản xuất không tồn tại' });
  }

  private badRequest(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
  }
}
