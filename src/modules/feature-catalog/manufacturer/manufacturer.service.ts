import { Injectable } from '@nestjs/common';
import { Manufacturer, Prisma, RecordStatus } from '@prisma/client';
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
import {
  CreateManufacturerRequest,
  ResolveManufacturerRequest,
  UpdateManufacturerRequest,
} from './dtos/manufacturer.request';
import { ManufacturerQuery } from './dtos/manufacturer.query';
import { MANUFACTURER_COUNTRIES, canonicalCountryOrNull } from './manufacturer-countries';
import { normalizeManufacturerName } from './manufacturer-name';
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

  /** Danh sách quốc gia chuẩn cho ô chọn ở FE. */
  listCountries(): readonly string[] {
    return MANUFACTURER_COUNTRIES;
  }

  /**
   * Tạo hãng từ form. Tên trùng (sau chuẩn hoá) với hãng chưa xoá → DUPLICATE_CODE "Hãng đã tồn tại: <tên>",
   * để người dùng chọn hãng có sẵn thay vì tạo bản thứ hai. Không nhập mã → tự sinh NSX0001…
   */
  async create(dto: CreateManufacturerRequest, actor: RequestActor): Promise<Manufacturer> {
    const nameKey = this.nameKeyOf(dto.name);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockAndFillNameKeys(tx, nameKey);
        const existing = await this.manufacturerRepository.findByNameKey(tx, nameKey);
        if (existing) throw this.duplicateName(existing);
        return this.insert(tx, dto, nameKey, actor);
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  /**
   * Tìm-hoặc-tạo hãng theo tên chuẩn hoá (dùng khi thêm hàng từ CSDL Dược). Nguyên tử: advisory lock theo khoá tên
   * nên hai request đồng thời cùng tên (kể cả biến thể) chỉ tạo một bản ghi. Ưu tiên hãng ACTIVE; nếu chỉ còn
   * hãng INACTIVE thì trả hãng đó (`created: false`) — FE tự quyết định, không tự kích hoạt lại.
   * Hãng có sẵn giữ nguyên quốc gia; `country` chỉ dùng khi tạo mới.
   */
  async resolve(
    dto: ResolveManufacturerRequest,
    actor: RequestActor,
  ): Promise<{ created: boolean; manufacturer: Manufacturer }> {
    const nameKey = this.nameKeyOf(dto.name);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockAndFillNameKeys(tx, nameKey);
        const existing = await this.manufacturerRepository.findByNameKey(tx, nameKey);
        if (existing) return { created: false, manufacturer: existing };
        const manufacturer = await this.insert(tx, { name: dto.name, country: dto.country }, nameKey, actor);
        return { created: true, manufacturer };
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  private async insert(
    tx: Prisma.TransactionClient,
    dto: CreateManufacturerRequest,
    nameKey: string,
    actor: RequestActor,
  ): Promise<Manufacturer> {
    const created = await this.manufacturerRepository.create(
      {
        code: dto.code ?? (await this.manufacturerRepository.nextAutoCode(tx)),
        name: dto.name.trim(),
        nameKey,
        country: canonicalCountryOrNull(dto.country),
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
  }

  async update(id: string, dto: UpdateManufacturerRequest, actor: RequestActor): Promise<Manufacturer> {
    if (Object.keys(dto).length === 0) throw this.badRequest('Cần gửi ít nhất một trường để cập nhật');

    const existing = await this.manufacturerRepository.findOne({ id });
    if (!existing) throw this.notFound();

    const data: Partial<Manufacturer> = { updatedBy: actor.user.userId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
      data.nameKey = this.nameKeyOf(dto.name);
    }
    if (dto.country !== undefined) data.country = canonicalCountryOrNull(dto.country);
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Đổi tên: chặn trùng với hãng KHÁC (dữ liệu cũ đã trùng sẵn mà không đổi tên thì vẫn sửa được).
        // So với khoá tính lại từ tên cũ (không dùng `existing.nameKey` có thể còn NULL trước backfill).
        if (data.nameKey && data.nameKey !== normalizeManufacturerName(existing.name)) {
          await this.lockAndFillNameKeys(tx, data.nameKey);
          const other = await this.manufacturerRepository.findByNameKey(tx, data.nameKey, id);
          if (other) throw this.duplicateName(other);
        }
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

  /** Khoá tên; tên không có chữ/số nào (vd "...") thì không so trùng được → báo lỗi. */
  private nameKeyOf(name: string): string {
    const nameKey = normalizeManufacturerName(name);
    if (!nameKey) throw this.badRequest('Tên hãng sản xuất phải có chữ hoặc số');
    return nameKey;
  }

  private async lockAndFillNameKeys(tx: Prisma.TransactionClient, nameKey: string): Promise<void> {
    await this.manufacturerRepository.lockNameKey(tx, nameKey);
    await this.manufacturerRepository.fillMissingNameKeys(tx);
  }

  private duplicateName(existing: Pick<Manufacturer, 'name' | 'code'>): ErrorException {
    const label = existing.code ? `${existing.name} (${existing.code})` : existing.name;
    return new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Hãng đã tồn tại: ${label}` });
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Hãng sản xuất không tồn tại' });
  }

  private badRequest(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
  }
}
