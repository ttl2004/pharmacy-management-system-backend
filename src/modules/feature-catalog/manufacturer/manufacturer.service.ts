import { Injectable } from '@nestjs/common';
import { Manufacturer, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { diffFields, pickAuditFields } from 'src/providers/audit-log/audit-diff';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { CreateManufacturerRequest, UpdateManufacturerRequest } from './dtos/manufacturer.request';
import { ManufacturerQuery } from './dtos/manufacturer.query';
import { ManufacturerRepository } from './repositories/manufacturer.repository';

const AUDITED_FIELDS = ['code', 'name', 'country', 'address', 'note', 'status'] as const;

/** Danh mục dùng chung toàn chuỗi → `branchIds: []`. Từ khoá tìm kiếm: mã + tên (D8). */
function auditBase(manufacturer: Pick<Manufacturer, 'id' | 'code' | 'name'>) {
  return {
    entityType: 'manufacturers',
    entityId: manufacturer.id,
    entityLabel: manufacturer.code ?? manufacturer.name,
    branchIds: [],
    searchTerms: [manufacturer.code, manufacturer.name].filter((t): t is string => !!t),
  };
}

@Injectable()
export class ManufacturerService extends AbstractBaseService<Manufacturer> {
  constructor(
    private readonly manufacturerRepository: ManufacturerRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {
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

  async create(dto: CreateManufacturerRequest, actor: RequestActor): Promise<Manufacturer> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await this.manufacturerRepository.create(
          {
            code: dto.code ?? null,
            name: dto.name,
            country: dto.country ?? null,
            address: dto.address ?? null,
            note: dto.note ?? null,
            status: dto.status ?? RecordStatus.ACTIVE,
            createdBy: actor.user.userId,
          },
          tx,
        );
        await this.audit.record(tx, auditActorOf(actor), [
          { event: 'MANUFACTURER.CREATED', ...auditBase(created), after: pickAuditFields(created, AUDITED_FIELDS) },
        ]);
        return created;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async update(id: string, dto: UpdateManufacturerRequest, actor: RequestActor): Promise<Manufacturer> {
    if (Object.keys(dto).length === 0) throw this.badRequest('Cần gửi ít nhất một trường để cập nhật');

    const existing = await this.manufacturerRepository.findOne({ id });
    if (!existing) throw this.notFound();

    const data: Partial<Manufacturer> = { updatedBy: actor.user.userId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await this.manufacturerRepository.update({ id }, data, undefined, tx);
        if (!updated) throw this.notFound();

        const diff = diffFields(existing, data, AUDITED_FIELDS);
        if (diff) {
          await this.audit.record(tx, auditActorOf(actor), [
            {
              event: diff.after.status !== undefined ? 'MANUFACTURER.STATUS_CHANGED' : 'MANUFACTURER.UPDATED',
              ...auditBase({ ...existing, ...data }),
              before: diff.before,
              after: diff.after,
            },
          ]);
        }
        return updated;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async remove(id: string, actor: RequestActor): Promise<{ success: true }> {
    const existing = await this.manufacturerRepository.findOne({ id });
    if (!existing) throw this.notFound();

    if ((await this.manufacturerRepository.countProducts(id)) > 0) {
      throw new ErrorException({
        code: ErrorCode.INVALID_REFERENCE,
        message: 'Không thể xoá hãng sản xuất đang được sản phẩm tham chiếu',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const deleted = await this.manufacturerRepository.softDelete({ id }, tx);
      if (!deleted) throw this.notFound();
      await this.audit.record(tx, auditActorOf(actor), [
        { event: 'MANUFACTURER.DELETED', ...auditBase(existing), before: pickAuditFields(existing, AUDITED_FIELDS) },
      ]);
    });

    return { success: true };
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Hãng sản xuất không tồn tại' });
  }

  private badRequest(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
  }
}
