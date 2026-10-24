import { Injectable } from '@nestjs/common';
import { Prisma, PriceBookPolicy, RecordStatus } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import { assertBranchInScope, BranchScope, resolveBranchScope } from '../../feature-auth/permission/branch-scope';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { permissionError } from '../../feature-auth/permission/permission.error';
import { PriceBookRequest } from './dtos/price-book.request';
import {
  ApplicablePriceBookResponse,
  POLICY_TO_DB,
  PriceBookResponse,
  toPriceBookResponse,
} from './dtos/price-book.response';
import { priceBookCreatedEntry, priceBookDeletedEntry, priceBookUpdatedEntry } from './price-book-audit';
import { assertWritableBranchIds, canEditBook } from './price-book-scope';
import { PriceBookRepository, PriceBookRow, PriceBookScalars } from './repositories/price-book.repository';

/** Bảng áp dụng được cho một đơn — Task 4 (đơn bán) dùng để tính lại giá dòng. */
export interface ApplicableBook {
  id: string;
  name: string;
  outOfBookPolicy: PriceBookPolicy;
  items: { productUnitId: string; price: number }[];
}

/** Ba khoá giá gốc cố định của công thức; khoá khác phải là id một bảng giá. */
const FIXED_BASES: ReadonlySet<string> = new Set(['avgCost', 'lastPurchaseCost', 'general']);

const unique = (ids: readonly string[]) => [...new Set(ids)];

/** CRUD bảng giá, phạm vi chi nhánh (D2), người bán và bảng áp dụng cho POS. Dòng giá ở `PriceBookItemsService`. */
@Injectable()
export class PriceBookService {
  constructor(
    private readonly repository: PriceBookRepository,
    private readonly audit: AuditLogService,
  ) {}

  async list(user: JwtUser): Promise<PriceBookResponse[]> {
    const scope = resolveBranchScope(user);
    const rows = await this.repository.listVisible(scope);
    return rows.map((row) => toPriceBookResponse(row, canEditBook(scope, row.branches.map((b) => b.branchId))));
  }

  async create(dto: PriceBookRequest, user: JwtUser): Promise<PriceBookResponse> {
    const scope = resolveBranchScope(user);
    const data = await this.prepareWrite(dto, scope, null);
    try {
      const created = await this.repository.transaction(async (tx) => {
        const row = await this.repository.create(tx, data, user.userId);
        await this.audit.record(tx, [priceBookCreatedEntry(user.userId, row)]);
        return row;
      });
      return toPriceBookResponse(created, canEditBook(scope, data.branchIds));
    } catch (error) {
      this.rethrowDuplicateName(error);
    }
  }

  async update(id: string, dto: PriceBookRequest, user: JwtUser): Promise<PriceBookResponse> {
    const scope = resolveBranchScope(user);
    const existing = await this.getEditable(id, scope);
    const data = await this.prepareWrite(dto, scope, id);
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const row = await this.repository.update(tx, id, data, user.userId);
        const entry = priceBookUpdatedEntry(user.userId, existing, row);
        if (entry) await this.audit.record(tx, [entry]);
        return row;
      });
      return toPriceBookResponse(updated, canEditBook(scope, data.branchIds));
    } catch (error) {
      this.rethrowDuplicateName(error);
    }
  }

  /**
   * Xoá cứng bảng (D8). Bảng khác đang lấy bảng này làm giá gốc (D9): gỡ công thức của chúng, trừ khi người gọi
   * không sửa được một trong số đó (quản lý chi nhánh vs bảng toàn hệ thống) → từ chối, không gỡ gì cả.
   */
  async remove(id: string, user: JwtUser): Promise<{ ok: true }> {
    const scope = resolveBranchScope(user);
    const existing = await this.getEditable(id, scope);
    await this.repository.transaction(async (tx) => {
      const dependents = await this.repository.findDependents(tx, id);
      const blocked = dependents.find((d) => !canEditBook(scope, d.branches.map((b) => b.branchId)));
      if (blocked) {
        throw new ErrorException({
          code: ErrorCode.PRICE_BOOK_BASE_IN_USE,
          message: `Bảng giá đang là giá gốc của bảng "${blocked.name}"`,
        });
      }
      await this.repository.clearFormula(tx, dependents.map((d) => d.id), user.userId);
      const cleared = { formulaBase: null, formulaOp: null, formulaAmount: null, formulaUnit: null };
      const entries: AuditEntry[] = [priceBookDeletedEntry(user.userId, existing)];
      for (const dependent of dependents) {
        const entry = priceBookUpdatedEntry(user.userId, dependent, { ...dependent, ...cleared });
        if (entry) entries.push(entry);
      }
      await this.audit.record(tx, entries);
      await this.repository.delete(tx, id);
    });
    return { ok: true };
  }

  /** Người bán chọn được cho tab "Phạm vi áp dụng": quản lý chi nhánh chỉ thấy người cùng chi nhánh. */
  listSellers(user: JwtUser): Promise<{ id: string; fullName: string }[]> {
    return this.repository.findSellers(resolveBranchScope(user));
  }

  /** Bảng POS được dùng ở chi nhánh này (theo người đăng nhập + hiệu lực), kèm toàn bộ giá — đúng contract FE. */
  async listApplicable(branchId: string, user: JwtUser): Promise<ApplicablePriceBookResponse[]> {
    const scope = resolveBranchScope(user);
    assertBranchInScope(scope, branchId);
    const rows = await this.repository.findApplicable(branchId, user.userId, new Date());
    return rows.map((row) => ({
      ...toPriceBookResponse(row, canEditBook(scope, row.branches.map((b) => b.branchId))),
      items: row.items.map((i) => ({
        priceBookId: row.id,
        drugId: i.productUnit.productId,
        unitId: i.productUnit.unitId,
        price: i.price,
      })),
    }));
  }

  /** Bảng đang áp dụng được cho (chi nhánh, người bán) lúc `at`, theo `productUnitId`. */
  async findApplicable(branchId: string, userId: string, at = new Date()): Promise<ApplicableBook[]> {
    const rows = await this.repository.findApplicable(branchId, userId, at);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      outOfBookPolicy: row.outOfBookPolicy,
      items: row.items.map((i) => ({ productUnitId: i.productUnitId, price: i.price })),
    }));
  }

  /**
   * Bảng dùng được cho (chi nhánh, người bán) ngay lúc này, hoặc ném `PRICE_BOOK_UNAVAILABLE` kèm lý do để
   * FE báo và quay về giá chung. KHÔNG im lặng về giá chung (D10).
   */
  async getUsableBook(id: string, branchId: string, userId: string): Promise<ApplicableBook> {
    const book = await this.repository.findWithItems(id);
    if (!book) throw this.unavailable('Bảng giá không tồn tại');
    const now = Date.now();
    const reason =
      book.status !== RecordStatus.ACTIVE ? 'đang ở trạng thái chưa áp dụng'
      : now < book.startAt.getTime() || now > book.endAt.getTime() ? 'không còn trong thời gian hiệu lực'
      : book.branches.length && !book.branches.some((b) => b.branchId === branchId) ? 'không áp dụng cho chi nhánh này'
      : book.users.length && !book.users.some((u) => u.userId === userId) ? 'không áp dụng cho người bán này'
      : null;
    if (reason) throw this.unavailable(`Bảng giá "${book.name}" ${reason}`);
    return { id: book.id, name: book.name, outOfBookPolicy: book.outOfBookPolicy, items: book.items };
  }

  /** Bảng phải tồn tại và nằm trong phạm vi SỬA của người gọi (D2). */
  private async getEditable(id: string, scope: BranchScope): Promise<PriceBookRow> {
    const row = await this.repository.findById(id);
    if (!row) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Bảng giá không tồn tại' });
    if (!canEditBook(scope, row.branches.map((b) => b.branchId))) {
      throw permissionError(ErrorCode.BRANCH_ACCESS_DENIED, 'Bạn không có quyền sửa bảng giá này');
    }
    return row;
  }

  /** Kiểm toàn bộ dữ liệu client gửi (phạm vi, tham chiếu, công thức, tên) và đổi sang dạng ghi DB. */
  private async prepareWrite(
    dto: PriceBookRequest,
    scope: BranchScope,
    selfId: string | null,
  ): Promise<PriceBookScalars & { branchIds: string[]; userIds: string[] }> {
    const branchIds = unique(dto.branchIds);
    const userIds = unique(dto.userIds);
    assertWritableBranchIds(scope, branchIds);

    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (!(endAt.getTime() > startAt.getTime())) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Ngày kết thúc phải sau ngày bắt đầu' });
    }
    await this.assertScopeReferences(scope, branchIds, userIds);

    const formula = dto.formula;
    if (formula) {
      if (selfId && formula.base === selfId) {
        throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Không lấy chính bảng này làm giá gốc' });
      }
      if (!FIXED_BASES.has(formula.base) && !(await this.repository.findById(formula.base))) {
        throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Bảng giá gốc của công thức không tồn tại' });
      }
    }
    if (await this.repository.findNameConflict(dto.name, selfId)) throw this.duplicateName();

    return {
      name: dto.name,
      startAt,
      endAt,
      status: dto.status === 'active' ? RecordStatus.ACTIVE : RecordStatus.INACTIVE,
      outOfBookPolicy: POLICY_TO_DB[dto.outOfBookPolicy],
      formulaBase: formula?.base ?? null,
      formulaOp: formula?.op ?? null,
      formulaAmount: formula?.amount ?? null,
      formulaUnit: formula?.unit ?? null,
      branchIds,
      userIds,
    };
  }

  /** Chi nhánh / người bán phải tồn tại; quản lý chi nhánh chỉ được chọn người cùng chi nhánh (D2). */
  private async assertScopeReferences(scope: BranchScope, branchIds: string[], userIds: string[]): Promise<void> {
    if ((await this.repository.countBranches(branchIds)) !== branchIds.length) {
      throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Chi nhánh không tồn tại' });
    }
    const users = await this.repository.findUsers(userIds);
    if (users.length !== userIds.length) {
      throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Người bán không tồn tại' });
    }
    if (scope.kind === 'BRANCH' && users.some((u) => u.branchId !== scope.branchId)) {
      throw permissionError(ErrorCode.BRANCH_ACCESS_DENIED, 'Chỉ được chọn người bán thuộc chi nhánh của mình');
    }
  }

  private unavailable(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.PRICE_BOOK_UNAVAILABLE, message });
  }

  private duplicateName(): ErrorException {
    return new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: 'Tên bảng giá đã tồn tại' });
  }

  /** Hai request song song cùng qua bước kiểm tên → DB (unique `lower(name)`) chặn một bên; dịch về cùng thông báo. */
  private rethrowDuplicateName(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw this.duplicateName();
    throw error;
  }
}
