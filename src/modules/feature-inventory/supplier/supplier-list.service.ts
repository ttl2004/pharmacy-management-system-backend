import { Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { resolveBranchScope } from '../../feature-auth/permission/branch-scope';
import { PermissionService } from '../../feature-auth/permission/permission.service';
import { SupplierQuery } from './dtos/supplier.query';
import { SupplierListParams, SupplierListWithTotalsRepository } from './repositories/supplier-list-with-totals.repository';
import { SupplierRepository } from './repositories/supplier.repository';

/**
 * Đọc NCC kèm Tổng mua / Nợ. Phạm vi chi nhánh và quyền xem nợ do server ép:
 * người thiếu `supplier-debt:read` luôn thấy nợ = 0 và không dò được qua lọc/sắp xếp.
 */
@Injectable()
export class SupplierListService {
  constructor(
    private readonly totals: SupplierListWithTotalsRepository,
    private readonly suppliers: SupplierRepository,
    private readonly permissions: PermissionService,
  ) {}

  async list(query: SupplierQuery, actor: RequestActor) {
    const result = await this.totals.findPage({
      ...(await this.scopeParams(actor)),
      status: query.status,
      groupId: query.groupId,
      search: query.search,
      note: query.note,
      purchaseMin: query.purchaseMin,
      purchaseMax: query.purchaseMax,
      debtMin: query.debtMin,
      debtMax: query.debtMax,
      fromDate: query.fromDate,
      toDate: query.toDate,
      sort: query.sort,
      page: query.page,
      limit: query.limit,
    });

    const hits = await this.attach(result.rows);
    return {
      hits,
      total: result.total,
      page: query.page,
      totalPages: Math.ceil(result.total / query.limit),
      limit: query.limit,
      summary: result.summary,
    };
  }

  async getDetail(id: string, actor: RequestActor) {
    const result = await this.totals.findPage({
      ...(await this.scopeParams(actor)),
      ids: [id],
      page: 1,
      limit: 1,
    });
    const [hit] = await this.attach(result.rows);
    if (!hit) {
      throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Nhà cung cấp không tồn tại' });
    }
    return hit;
  }

  /** Nạp cột đầy đủ + nhóm + người tạo, giữ đúng thứ tự do SQL sắp xếp. */
  private async attach(rows: { id: string; totalPurchase: number; currentDebt: number }[]) {
    const found = await this.suppliers.findManyByIds(rows.map((r) => r.id));
    const byId = new Map(found.map((s) => [s.id, s] as const));
    return rows.flatMap((r) => {
      const supplier = byId.get(r.id);
      return supplier ? [{ ...supplier, totalPurchase: r.totalPurchase, currentDebt: r.currentDebt }] : [];
    });
  }

  private async scopeParams(actor: RequestActor): Promise<Pick<SupplierListParams, 'branchId' | 'canSeeDebt'>> {
    const scope = resolveBranchScope(actor.user);
    const role = actor.user.role;
    const canSeeDebt =
      role === AuthRole.SUPER_ADMIN || (await this.permissions.getGrantedCodes(role)).has('supplier-debt:read');
    return {
      branchId: scope.kind === 'BRANCH' ? scope.branchId : undefined,
      canSeeDebt,
    };
  }
}
