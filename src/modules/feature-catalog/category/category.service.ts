import { Injectable } from '@nestjs/common';
import { Category, RecordStatus } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { CategoryQuery } from './dtos/category.query';
import { CreateCategoryRequest, UpdateCategoryRequest } from './dtos/category.request';
import { CategoryRepository } from './repositories/category.repository';

@Injectable()
export class CategoryService extends AbstractBaseService<Category> {
  constructor(private readonly categoryRepository: CategoryRepository) {
    super(categoryRepository);
  }

  async list(query: CategoryQuery) {
    const filter: BaseWhere<Category> = {};
    if (query.parentId) filter.parentId = query.parentId;
    if (query.status) filter.status = query.status;

    return this.categoryRepository.findManyWithPagination(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search,
      searchFields: ['code', 'name'],
    });
  }

  async getDetail(id: string): Promise<Category> {
    const category = await this.categoryRepository.findOne({ id }, { relations: { parent: true } });
    if (!category) throw this.notFound();
    return category;
  }

  async create(dto: CreateCategoryRequest, callerId: string): Promise<Category> {
    await this.assertParentUsable(dto.parentId ?? null);

    try {
      return await this.categoryRepository.create({
        code: dto.code ?? null,
        name: dto.name,
        parentId: dto.parentId ?? null,
        sortOrder: dto.sortOrder ?? 0,
        status: dto.status ?? RecordStatus.ACTIVE,
        createdBy: callerId,
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async update(id: string, dto: UpdateCategoryRequest, callerId: string): Promise<Category> {
    if (Object.keys(dto).length === 0) throw this.badRequest('Cần gửi ít nhất một trường để cập nhật');

    const existing = await this.categoryRepository.findOne({ id });
    if (!existing) throw this.notFound();

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) throw this.badRequest('Nhóm sản phẩm không thể là cha của chính nó');

      await this.assertParentUsable(dto.parentId);
      if (await this.categoryRepository.isInSubtreeOf(dto.parentId, id)) {
        throw this.badRequest('Không thể chuyển nhóm sản phẩm vào chính nhánh con của nó');
      }
    }

    const data: Partial<Category> = { updatedBy: callerId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.parentId !== undefined) data.parentId = dto.parentId;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      const updated = await this.categoryRepository.update({ id }, data);
      if (!updated) throw this.notFound();
      return updated;
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async remove(id: string): Promise<{ success: true }> {
    const existing = await this.categoryRepository.findOne({ id });
    if (!existing) throw this.notFound();

    if ((await this.categoryRepository.countChildren(id)) > 0) {
      throw this.invalidReference('Không thể xoá nhóm sản phẩm đang có nhóm con');
    }
    if ((await this.categoryRepository.countProducts(id)) > 0) {
      throw this.invalidReference('Không thể xoá nhóm sản phẩm đang được sản phẩm tham chiếu');
    }

    const deleted = await this.categoryRepository.softDelete({ id });
    if (!deleted) throw this.notFound();

    return { success: true };
  }

  private async assertParentUsable(parentId: string | null): Promise<void> {
    if (!parentId) return;

    const parent = await this.categoryRepository.findOne({ id: parentId, status: RecordStatus.ACTIVE });
    if (!parent) throw this.invalidReference('Nhóm sản phẩm cha không tồn tại hoặc đã ngừng hoạt động');
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Nhóm sản phẩm không tồn tại' });
  }

  private invalidReference(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message });
  }

  private badRequest(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
  }
}
