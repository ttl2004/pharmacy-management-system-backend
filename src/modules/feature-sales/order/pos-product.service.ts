import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { todayInVietnam } from 'src/common/utils/date-only.util';
import { escapeLike } from 'src/common/utils/like-pattern.util';
import { resolveBranchScope } from 'src/modules/feature-auth/permission/branch-scope';
import { resolveWriteBranch } from 'src/modules/feature-inventory/core/inventory-scope';
import { PriceBookService } from 'src/modules/feature-catalog/price-book/price-book.service';
import { BookPricing, bookPriceOf, toBookPricing } from '../core/order-lines';
import { PosProductQuery } from './dtos/order.request';
import { PosProductRepository, PosProductRow } from './repositories/pos-product.repository';

export interface PosProductUnit {
  id: string;
  unitName: string;
  conversionRate: number;
  salePrice: number;
  /** Giá theo bảng giá đã chọn; null = không chọn bảng hoặc hàng không có trong bảng. Giá bán hiển thị = bookPrice ?? salePrice. */
  bookPrice: number | null;
  /** true = đã chọn bảng mà đơn vị này không có trong bảng (FE xử lý theo policy ALLOW/WARN/BLOCK của bảng). */
  outOfBook: boolean;
  barcode: string | null;
  isBaseUnit: boolean;
  /** Bán được bao nhiêu theo đơn vị này (làm tròn xuống). */
  sellableQuantity: number;
}

export interface PosProduct {
  id: string;
  code: string;
  name: string;
  imageUrl: string | null;
  requiresPrescription: boolean;
  /** Thuốc kiểm soát đặc biệt — POS bắt buộc tên + SĐT khách (như mock). */
  isControlled: boolean;
  /** Lượng bán được tại chi nhánh theo đơn vị cơ bản. */
  sellableBaseQuantity: number;
  units: PosProductUnit[];
  /** Chỉ có khi tra bằng mã vạch: đơn vị vừa quét (mã của sản phẩm thì là đơn vị cơ bản) — FE thêm thẳng 1 đơn vị này. */
  matchedUnitId?: string | null;
}

/**
 * Tra hàng cho màn bán tại quầy — một API cho cả "bán nhanh" (quét mã vạch, gõ tên/mã) và "bán thường" (lưới sản phẩm).
 * Khác `GET /product` ở chỗ: tìm được theo mã vạch của từng đơn vị bán, chỉ trả hàng đang kinh doanh, và kèm lượng bán
 * được tại chi nhánh để thu ngân biết còn hàng trước khi thêm vào đơn. Lượng này chỉ để hiển thị; lúc lập đơn vẫn khoá
 * lô và kiểm lại.
 */
@Injectable()
export class PosProductService {
  constructor(
    private readonly products: PosProductRepository,
    private readonly priceBooks: PriceBookService,
  ) {}

  async search(query: PosProductQuery, actor: RequestActor, today: string = todayInVietnam()) {
    const branchId = resolveWriteBranch(
      resolveBranchScope(actor.user),
      query.branchId,
      'Cần chọn chi nhánh bán (branchId)',
    );
    const { page, limit } = query;
    // Bảng giá không dùng được -> 1802 để FE về Bảng giá chung và báo người dùng.
    const book = query.priceBookId
      ? toBookPricing(await this.priceBooks.getUsableBook(query.priceBookId, branchId, actor.user.userId))
      : undefined;

    if (query.barcode) {
      const row = await this.products.findByBarcode(query.barcode.trim());
      const hits = row ? await this.withStock(branchId, [row], today, book) : [];
      if (row) hits[0].matchedUnitId = matchedUnitOf(row, query.barcode.trim());
      return { hits, total: hits.length, page: 1, totalPages: hits.length, limit };
    }

    const conditions: Prisma.ProductWhereInput[] = [];
    if (query.categoryId) conditions.push({ categoryId: query.categoryId });
    if (query.search?.trim()) {
      const keyword = escapeLike(query.search.trim());
      const matches = { contains: keyword, mode: 'insensitive' } as const;
      conditions.push({
        OR: [
          ...['code', 'barcode', 'name'].map((field) => ({ [field]: matches })),
          // Hoạt chất là thông tin của thuốc liên kết, không còn là cột của hàng hoá.
          { drug: { ingredients: matches } },
        ],
      });
    }
    const { rows, total } = await this.products.findPage({ AND: conditions }, page, limit);
    return {
      hits: await this.withStock(branchId, rows, today, book),
      total,
      page,
      totalPages: Math.ceil(total / limit),
      limit,
    };
  }

  private async withStock(
    branchId: string,
    rows: readonly PosProductRow[],
    today: string,
    book?: BookPricing,
  ): Promise<PosProduct[]> {
    const sellable = await this.products.sellableQuantities(
      branchId,
      rows.map((row) => row.id),
      today,
    );
    return rows.map((row) => {
      const base = sellable.get(row.id) ?? 0;
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        imageUrl: row.imageUrls[0] ?? null,
        requiresPrescription: row.requiresPrescription,
        isControlled: row.isControlled,
        sellableBaseQuantity: base,
        units: row.units.map((unit) => {
          const bookPrice = bookPriceOf(book, unit.id);
          return {
            id: unit.id,
            unitName: unit.unit.name,
            conversionRate: unit.conversionRate,
            salePrice: unit.salePrice,
            bookPrice,
            outOfBook: !!book && bookPrice === null,
            barcode: unit.barcode,
            isBaseUnit: unit.isBaseUnit,
            sellableQuantity: Math.floor(base / unit.conversionRate),
          };
        }),
      };
    });
  }
}

/** Mã vạch của một đơn vị bán → đơn vị đó; mã của chính sản phẩm → đơn vị cơ bản. */
function matchedUnitOf(row: PosProductRow, barcode: string): string | null {
  const unit = row.units.find((item) => item.barcode === barcode) ?? row.units.find((item) => item.isBaseUnit);
  return unit?.id ?? null;
}
