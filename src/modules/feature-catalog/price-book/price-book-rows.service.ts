import { Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { resolveBranchScope, scopedBranchFilter } from '../../feature-auth/permission/branch-scope';
import { permissionError } from '../../feature-auth/permission/permission.error';
import { PermissionService } from '../../feature-auth/permission/permission.service';
import { PriceRowsQuery, SetGeneralPriceRequest } from './dtos/price-book-rows.request';
import { generalPriceChangedEntry } from './price-book-audit';
import { toRowsFilter } from './price-book-rows-filter';
import { PriceBookRepository } from './repositories/price-book.repository';
import { PriceBookRowsRepository } from './repositories/price-book-rows.repository';

const DEFAULT_PAGE_SIZE = 15;
/** Trang tối đa cho người không được xuất file; trần 100.000 của DTO chỉ dành cho người sửa được bảng giá. */
const MAX_PAGE_SIZE_NO_EXPORT = 500;
/** Quyền xuất cả bảng giá một lần (chưa có quyền riêng cho xuất file → dùng quyền sửa giá). */
const EXPORT_PERMISSION = 'price-book:update';
/**
 * Quyền thấy giá vốn / giá nhập cuối: người lập phiếu nhập (đã tự nhập giá nhập) hoặc người sửa bảng giá (công thức
 * theo giá vốn cần thấy giá vốn). `goods-receipt:read` không dùng được vì nhân viên bán hàng cũng có.
 */
const COST_PERMISSIONS = ['goods-receipt:create', EXPORT_PERMISSION] as const;

/** Một dòng trang Thiết lập giá — đúng `priceRowSchema` của FE. `drugId` = sản phẩm, `unitId` = id đơn vị tính. */
export interface PriceRowResponse {
  drugId: string;
  unitId: string;
  code: string;
  name: string;
  unitName: string;
  factor: number;
  /** null = chưa biết (không chọn chi nhánh / không còn lô). */
  avgCost: number | null;
  /** null = chưa biết (không chọn chi nhánh / chưa có phiếu nhập). */
  lastPurchaseCost: number | null;
  generalPrice: number;
  /** bookId → giá; null = hàng chưa có trong bảng đó. */
  prices: Record<string, number | null>;
}

/** Trang dòng giá và sửa giá chung. Dòng giá của từng bảng ở `PriceBookItemsService`. */
@Injectable()
export class PriceBookRowsService {
  constructor(
    private readonly rowsRepository: PriceBookRowsRepository,
    private readonly bookRepository: PriceBookRepository,
    private readonly audit: AuditLogService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Trang dòng giá. Quản lý chi nhánh chỉ xem giá vốn / tồn của chi nhánh mình (không gửi `branchId` → chi nhánh
   * mình), và chỉ nhận cột giá của bảng mình được xem. Người không có quyền xem giá vốn nhận `avgCost` và
   * `lastPurchaseCost` = null, và bộ lọc so với giá vốn (`priceOp`/`priceCompare`) bị bỏ qua (không lộ giá vốn qua việc
   * lọc dò); người không có quyền xuất file bị 400 nếu xin trang quá 500 dòng.
   */
  async listRows(query: PriceRowsQuery, user: JwtUser) {
    const granted = user.role === AuthRole.SUPER_ADMIN ? null : await this.permissions.getGrantedCodes(user.role);
    const canSeeCost = !granted || COST_PERMISSIONS.some((code) => granted.has(code));
    const canExport = !granted || granted.has(EXPORT_PERMISSION);

    const scope = resolveBranchScope(user);
    const filter = toRowsFilter(query, scopedBranchFilter(scope, query.branchId));
    if (!canSeeCost) {
      filter.priceOp = undefined;
      filter.priceCompare = undefined;
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!canExport && pageSize > MAX_PAGE_SIZE_NO_EXPORT) {
      throw new ErrorException({
        code: ErrorCode.HTTP_BAD_REQUEST,
        message: `pageSize tối đa ${MAX_PAGE_SIZE_NO_EXPORT}`,
      });
    }

    const [{ items, total }, bookIds] = await Promise.all([
      this.rowsRepository.findPage(filter, page, pageSize),
      this.rowsRepository.findReadableBookIds(scope, query.bookIds ?? []),
    ]);
    const bookPrices = await this.rowsRepository.findBookPrices(
      bookIds,
      items.map((i) => i.productUnitId),
    );

    const priceOf = new Map(bookPrices.map((p) => [`${p.priceBookId}|${p.productUnitId}`, p.price]));
    const rows: PriceRowResponse[] = items.map((row) => ({
      drugId: row.productId,
      unitId: row.unitId,
      code: row.code,
      name: row.name,
      unitName: row.unitName,
      factor: row.factor,
      avgCost: canSeeCost ? row.avgCost : null,
      lastPurchaseCost: canSeeCost ? row.lastPurchaseCost : null,
      generalPrice: row.generalPrice,
      prices: Object.fromEntries(bookIds.map((id) => [id, priceOf.get(`${id}|${row.productUnitId}`) ?? null])),
    }));
    return { items: rows, total, page, pageSize };
  }

  /**
   * Sửa giá chung = `product_units.salePrice` — dữ liệu toàn chuỗi nên chỉ vai trò toàn chuỗi được sửa (D6);
   * quản lý chi nhánh có `price-book:update` vẫn bị 403 ở đây.
   */
  async setGeneralPrice(dto: SetGeneralPriceRequest, actor: RequestActor): Promise<{ ok: true }> {
    if (resolveBranchScope(actor.user).kind !== 'ALL') {
      throw permissionError(ErrorCode.PERMISSION_DENIED, 'Chỉ quản trị toàn chuỗi mới được sửa giá chung');
    }
    await this.bookRepository.transaction(async (tx) => {
      const unit = await this.rowsRepository.findProductUnit(dto.drugId, dto.unitId, tx);
      if (!unit)
        throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Đơn vị không thuộc hàng này' });
      if (unit.salePrice === dto.price) return;
      await this.rowsRepository.setGeneralPrice(tx, unit.id, dto.price, actor.user.userId);
      const product = { id: dto.drugId, code: unit.product.code, name: unit.product.name };
      await this.audit.record(tx, auditActorOf(actor), [
        generalPriceChangedEntry(product, dto.unitId, unit.salePrice, dto.price),
      ]);
    });
    return { ok: true };
  }
}
