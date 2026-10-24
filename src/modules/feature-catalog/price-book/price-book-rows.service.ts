import { Injectable } from '@nestjs/common';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { resolveBranchScope, scopedBranchFilter } from '../../feature-auth/permission/branch-scope';
import { permissionError } from '../../feature-auth/permission/permission.error';
import { PriceRowsQuery, SetGeneralPriceRequest } from './dtos/price-book-rows.request';
import { generalPriceChangedEntry } from './price-book-audit';
import { toRowsFilter } from './price-book-rows-filter';
import { PriceBookRepository } from './repositories/price-book.repository';
import { PriceBookRowsRepository } from './repositories/price-book-rows.repository';

const DEFAULT_PAGE_SIZE = 15;

/** Một dòng trang Thiết lập giá — đúng `priceRowSchema` của FE. `drugId` = sản phẩm, `unitId` = id đơn vị tính. */
export interface PriceRowResponse {
  drugId: string;
  unitId: string;
  code: string;
  name: string;
  unitName: string;
  factor: number;
  avgCost: number;
  lastPurchaseCost: number;
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
  ) {}

  /**
   * Trang dòng giá. Quản lý chi nhánh chỉ xem giá vốn / tồn của chi nhánh mình (không gửi `branchId` → chi nhánh
   * mình), và chỉ nhận cột giá của bảng mình được xem.
   */
  async listRows(query: PriceRowsQuery, user: JwtUser) {
    const scope = resolveBranchScope(user);
    const filter = toRowsFilter(query, scopedBranchFilter(scope, query.branchId));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const [{ items, total }, bookIds] = await Promise.all([
      this.rowsRepository.findPage(filter, page, pageSize),
      this.rowsRepository.findReadableBookIds(scope, query.bookIds ?? []),
    ]);
    const bookPrices = await this.rowsRepository.findBookPrices(bookIds, items.map((i) => i.productUnitId));

    const priceOf = new Map(bookPrices.map((p) => [`${p.priceBookId}|${p.productUnitId}`, p.price]));
    const rows: PriceRowResponse[] = items.map((row) => ({
      drugId: row.productId,
      unitId: row.unitId,
      code: row.code,
      name: row.name,
      unitName: row.unitName,
      factor: row.factor,
      avgCost: row.avgCost,
      lastPurchaseCost: row.lastPurchaseCost,
      generalPrice: row.generalPrice,
      prices: Object.fromEntries(bookIds.map((id) => [id, priceOf.get(`${id}|${row.productUnitId}`) ?? null])),
    }));
    return { items: rows, total, page, pageSize };
  }

  /**
   * Sửa giá chung = `product_units.salePrice` — dữ liệu toàn chuỗi nên chỉ vai trò toàn chuỗi được sửa (D6);
   * quản lý chi nhánh có `price-book:update` vẫn bị 403 ở đây.
   */
  async setGeneralPrice(dto: SetGeneralPriceRequest, user: JwtUser): Promise<{ ok: true }> {
    if (resolveBranchScope(user).kind !== 'ALL') {
      throw permissionError(ErrorCode.PERMISSION_DENIED, 'Chỉ quản trị toàn chuỗi mới được sửa giá chung');
    }
    await this.bookRepository.transaction(async (tx) => {
      const unit = await this.rowsRepository.findProductUnit(dto.drugId, dto.unitId, tx);
      if (!unit) throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Đơn vị không thuộc hàng này' });
      if (unit.salePrice === dto.price) return;
      await this.rowsRepository.setGeneralPrice(tx, unit.id, dto.price, user.userId);
      await this.audit.record(tx, [generalPriceChangedEntry(user.userId, dto.drugId, dto.unitId, unit.salePrice, dto.price)]);
    });
    return { ok: true };
  }
}
