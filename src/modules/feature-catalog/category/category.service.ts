import { Injectable } from '@nestjs/common';
import { Category, RecordStatus } from '@prisma/client';
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
import { CategoryQuery } from './dtos/category.query';
import { CreateCategoryRequest, UpdateCategoryRequest } from './dtos/category.request';
import { CategoryRepository } from './repositories/category.repository';

const AUDITED_FIELDS = ['code', 'name', 'parentId', 'sortOrder', 'status'] as const;

/** Danh mục dùng chung toàn chuỗi → `branchIds: []`. Từ khoá tìm kiếm: mã + tên (D8). */
function auditBase(category: Pick<Category, 'id' | 'code' | 'name'>) {
  return {
    entityType: 'categories',
    entityId: category.id,
    entityLabel: category.code ?? category.name,
    branchIds: [],
    searchTerms: [category.code, category.name].filter((t): t is string => !!t),
  };
}

@Injectable()
export class CategoryService extends AbstractBaseService<Category> {
  constructor(
    private readonly categoryRepository: CategoryRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {
    super(categoryRepository);
  }

  async list(query: CategoryQuery) {
    const filter: BaseWhere<Category> = {};
    if (query.parentId) filter.parentId = query.parentId;
    if (query.status) filter.status = query.status;

    const [page, counts] = await Promise.all([
      this.categoryRepository.findManyWithPagination(filter, {
        page: query.page,
        limit: query.limit,
        sort: query.sort,
        search: query.search,
        searchFields: ['code', 'name'],
      }),
      this.categoryRepository.countActiveProductsWithDescendants(),
    ]);
    // `productCount`: hàng đang kinh doanh của nhóm, cộng dồn nhóm con cháu.
    return { ...page, hits: page.hits.map((c) => ({ ...c, productCount: counts.get(c.id) ?? 0 })) };
  }

  async getDetail(id: string): Promise<Category> {
    const category = await this.categoryRepository.findOne({ id }, { relations: { parent: true } });
    if (!category) throw this.notFound();
    return category;
  }

  async create(dto: CreateCategoryRequest, actor: RequestActor): Promise<Category> {
    await this.assertParentUsable(dto.parentId ?? null);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await this.categoryRepository.create(
          {
            code: dto.code ?? null,
            name: dto.name,
            parentId: dto.parentId ?? null,
            sortOrder: dto.sortOrder ?? 0,
            status: dto.status ?? RecordStatus.ACTIVE,
            createdBy: actor.user.userId,
          },
          tx,
        );
        await this.audit.record(tx, auditActorOf(actor), [
          { event: 'CATEGORY.CREATED', ...auditBase(created), after: pickAuditFields(created, AUDITED_FIELDS) },
        ]);
        return created;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }

  async update(id: string, dto: UpdateCategoryRequest, actor: RequestActor): Promise<Category> {
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

    const data: Partial<Category> = { updatedBy: actor.user.userId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.parentId !== undefined) data.parentId = dto.parentId;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await this.categoryRepository.update({ id }, data, undefined, tx);
        if (!updated) throw this.notFound();

        const diff = diffFields(existing, data, AUDITED_FIELDS);
        if (diff) {
          await this.audit.record(tx, auditActorOf(actor), [
            {
              event: diff.after.status !== undefined ? 'CATEGORY.STATUS_CHANGED' : 'CATEGORY.UPDATED',
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
    const existing = await this.categoryRepository.findOne({ id });
    if (!existing) throw this.notFound();

    if ((await this.categoryRepository.countChildren(id)) > 0) {
      throw this.invalidReference('Không thể xoá nhóm sản phẩm đang có nhóm con');
    }
    if ((await this.categoryRepository.countProducts(id)) > 0) {
      throw this.invalidReference('Không thể xoá nhóm sản phẩm đang được sản phẩm tham chiếu');
    }

    await this.prisma.$transaction(async (tx) => {
      const deleted = await this.categoryRepository.softDelete({ id }, tx);
      if (!deleted) throw this.notFound();
      await this.audit.record(tx, auditActorOf(actor), [
        { event: 'CATEGORY.DELETED', ...auditBase(existing), before: pickAuditFields(existing, AUDITED_FIELDS) },
      ]);
    });

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
