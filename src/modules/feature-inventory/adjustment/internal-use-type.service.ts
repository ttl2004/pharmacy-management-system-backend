import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { diffFields } from 'src/providers/audit-log/audit-diff';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';

export class InternalUseTypeRequest {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @ApiProperty({ example: 'Văn phòng phẩm' })
  name: string;
}

const SELECT = { id: true, name: true, createdAt: true } as const;

/** Danh mục dùng chung toàn chuỗi → `branchIds: []`. */
function auditBase(row: { id: string; name: string }) {
  return {
    entityType: 'internal_use_types',
    entityId: row.id,
    entityLabel: row.name,
    branchIds: [],
    searchTerms: [row.name],
  };
}

/**
 * Danh mục loại xuất dùng nội bộ (như mock `/internal-use-types`): tên duy nhất không phân biệt hoa thường; loại đã
 * có phiếu dùng (kể cả phiếu huỷ) không xoá được → 1602. Xoá mềm.
 */
@Injectable()
export class InternalUseTypeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  list() {
    return this.prisma.internalUseType.findMany({
      where: { isDeleted: false },
      orderBy: { name: 'asc' },
      select: SELECT,
    });
  }

  async create(dto: InternalUseTypeRequest, actor: RequestActor) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, dto.name);
      const created = await tx.internalUseType.create({
        data: { name: dto.name, createdBy: actor.user.userId },
        select: SELECT,
      });
      await this.audit.record(tx, auditActorOf(actor), [
        { event: 'INTERNAL_USE_TYPE.CREATED', ...auditBase(created), after: { name: created.name } },
      ]);
      return created;
    });
  }

  async update(id: string, dto: InternalUseTypeRequest, actor: RequestActor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.mustExist(tx, id);
      await this.assertNameFree(tx, dto.name, id);
      const updated = await tx.internalUseType.update({
        where: { id },
        data: { name: dto.name, updatedBy: actor.user.userId, updatedAt: new Date() },
        select: SELECT,
      });
      const diff = diffFields(existing, { name: updated.name }, ['name']);
      if (diff) {
        await this.audit.record(tx, auditActorOf(actor), [
          {
            event: 'INTERNAL_USE_TYPE.UPDATED',
            ...auditBase(updated),
            before: diff.before,
            after: diff.after,
          },
        ]);
      }
      return updated;
    });
  }

  async remove(id: string, actor: RequestActor): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.mustExist(tx, id);
      if ((await tx.stockAdjustment.count({ where: { internalUseTypeId: id } })) > 0) {
        throw new ErrorException({
          code: ErrorCode.INVALID_REFERENCE,
          message: 'Loại xuất đã có phiếu dùng, không xoá được',
        });
      }
      // Giải phóng tên (unique) để tạo lại được loại cùng tên sau khi xoá.
      await tx.internalUseType.update({
        where: { id },
        data: { isDeleted: true, name: `${id}:deleted`, updatedBy: actor.user.userId, updatedAt: new Date() },
      });
      // Nhật ký giữ tên gốc, không phải tên đã đổi để giải phóng unique.
      await this.audit.record(tx, auditActorOf(actor), [
        { event: 'INTERNAL_USE_TYPE.DELETED', ...auditBase(existing), before: { name: existing.name } },
      ]);
    });
    return { success: true };
  }

  private async mustExist(tx: Prisma.TransactionClient, id: string) {
    const found = await tx.internalUseType.findFirst({
      where: { id, isDeleted: false },
      select: { id: true, name: true },
    });
    if (!found) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Loại xuất không tồn tại' });
    return found;
  }

  private async assertNameFree(tx: Prisma.TransactionClient, name: string, exceptId?: string) {
    const dup = await tx.internalUseType.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        isDeleted: false,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (dup) throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Loại xuất "${name}" đã tồn tại` });
  }
}
