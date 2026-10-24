import { Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

export class InternalUseTypeRequest {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @ApiProperty({ example: 'Văn phòng phẩm' })
  name: string;
}

const SELECT = { id: true, name: true, createdAt: true } as const;

/**
 * Danh mục loại xuất dùng nội bộ (như mock `/internal-use-types`): tên duy nhất không phân biệt hoa thường; loại đã
 * có phiếu dùng (kể cả phiếu huỷ) không xoá được → 1602. Xoá mềm.
 */
@Injectable()
export class InternalUseTypeService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.internalUseType.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' }, select: SELECT });
  }

  async create(dto: InternalUseTypeRequest, actorId: string) {
    await this.assertNameFree(dto.name);
    return this.prisma.internalUseType.create({ data: { name: dto.name, createdBy: actorId }, select: SELECT });
  }

  async update(id: string, dto: InternalUseTypeRequest, actorId: string) {
    await this.mustExist(id);
    await this.assertNameFree(dto.name, id);
    return this.prisma.internalUseType.update({
      where: { id },
      data: { name: dto.name, updatedBy: actorId, updatedAt: new Date() },
      select: SELECT,
    });
  }

  async remove(id: string, actorId: string): Promise<{ success: true }> {
    await this.mustExist(id);
    if ((await this.prisma.stockAdjustment.count({ where: { internalUseTypeId: id } })) > 0) {
      throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Loại xuất đã có phiếu dùng, không xoá được' });
    }
    // Giải phóng tên (unique) để tạo lại được loại cùng tên sau khi xoá.
    await this.prisma.internalUseType.update({
      where: { id },
      data: { isDeleted: true, name: `${id}:deleted`, updatedBy: actorId, updatedAt: new Date() },
    });
    return { success: true };
  }

  private async mustExist(id: string) {
    const found = await this.prisma.internalUseType.findFirst({ where: { id, isDeleted: false }, select: { id: true } });
    if (!found) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Loại xuất không tồn tại' });
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const dup = await this.prisma.internalUseType.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, isDeleted: false, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup) throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Loại xuất "${name}" đã tồn tại` });
  }
}
