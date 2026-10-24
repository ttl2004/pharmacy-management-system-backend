import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import type { JwtUser } from '../../feature-auth/authz/types/authz.types';
import { resolveBranchScope, scopedBranchFilter } from '../../feature-auth/permission/branch-scope';
import { PriceRowsFilterRequest, SetBookItemRequest } from './dtos/price-book-rows.request';
import { computeFormulaPrice, FormulaTerms } from './price-book-formula';
import { toRowsFilter } from './price-book-rows-filter';
import { assertCanEditBook } from './price-book-scope';
import { PriceBookRepository, PriceBookRow } from './repositories/price-book.repository';
import { PriceBookRowsRepository, RawPriceRow } from './repositories/price-book-rows.repository';

/** Giá gốc của một dòng đơn vị; `basePrice = null` khi không tính được (bảng gốc không có hàng này). */
export interface BasePriceRow {
  productUnitId: string;
  basePrice: number | null;
}

/** Sửa giá từng ô của một bảng và áp công thức. */
@Injectable()
export class PriceBookItemsService {
  constructor(
    private readonly rowsRepository: PriceBookRowsRepository,
    private readonly bookRepository: PriceBookRepository,
  ) {}

  /** Số → thêm/cập nhật giá; `null` → bỏ hàng khỏi bảng. */
  async setItem(bookId: string, dto: SetBookItemRequest, user: JwtUser): Promise<{ ok: true }> {
    const book = await this.getEditableBook(bookId, user);
    const unit = await this.rowsRepository.findProductUnit(dto.drugId, dto.unitId);
    if (!unit) throw new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message: 'Đơn vị không thuộc hàng này' });
    await this.rowsRepository.setItem(book.id, unit.id, dto.price);
    return { ok: true };
  }

  /** Áp công thức của bảng cho MỌI dòng khớp bộ lọc (không phân trang); giá gốc theo `branchId` gửi kèm. */
  async applyFormulaToFilter(bookId: string, dto: PriceRowsFilterRequest, user: JwtUser): Promise<{ count: number }> {
    const book = await this.getEditableBook(bookId, user);
    if (!book.formulaBase) {
      throw new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message: 'Bảng giá chưa có công thức' });
    }
    const branchId = scopedBranchFilter(resolveBranchScope(user), dto.branchId);
    const rows = await this.rowsRepository.findAll(toRowsFilter(dto, branchId));
    const bases = await this.toBasePrices(book.formulaBase, rows);
    return { count: await this.applyFormula(book.id, bases) };
  }

  /**
   * Tính lại giá các dòng ĐANG CÓ trong bảng theo công thức hiện tại (PUT với `reapplyFormula`). Chạy trong
   * transaction của lần sửa nên công thức mới đã nằm trong `tx`.
   */
  async reapplyExisting(tx: Prisma.TransactionClient, book: PriceBookRow, branchId: string | undefined): Promise<number> {
    if (!book.formulaBase) return 0;
    const unitIds = await this.rowsRepository.findItemUnitIds(tx, book.id);
    if (!unitIds.length) return 0;
    const rows = await this.rowsRepository.findAll({
      codes: [], categoryIds: [], stock: 'all', branchId, productUnitIds: unitIds,
    });
    return this.applyFormula(book.id, await this.toBasePrices(book.formulaBase, rows), tx);
  }

  /**
   * Ghi giá theo công thức của bảng `bookId` cho các dòng có giá gốc; dòng `basePrice = null` bị BỎ QUA (không ghi 0).
   * Trả số dòng đã ghi. Không truyền `tx` thì tự mở transaction.
   */
  async applyFormula(bookId: string, rows: BasePriceRow[], tx?: Prisma.TransactionClient): Promise<number> {
    if (!tx) return this.bookRepository.transaction((inner) => this.applyFormula(bookId, rows, inner));
    const book = await this.bookRepository.findById(bookId, tx);
    const terms = book && this.termsOf(book);
    if (!terms) return 0;

    const entries = rows
      .filter((row): row is { productUnitId: string; basePrice: number } => row.basePrice !== null)
      .map((row) => ({ productUnitId: row.productUnitId, price: computeFormulaPrice(row.basePrice, terms) }));
    await this.rowsRepository.upsertItems(tx, bookId, entries);
    return entries.length;
  }

  /** Giá gốc của từng dòng theo `formula.base`: giá vốn / giá nhập cuối / giá chung / giá trong một bảng khác. */
  private async toBasePrices(base: string, rows: RawPriceRow[]): Promise<BasePriceRow[]> {
    if (base === 'avgCost' || base === 'lastPurchaseCost') {
      return rows.map((r) => ({ productUnitId: r.productUnitId, basePrice: r[base] }));
    }
    if (base === 'general') return rows.map((r) => ({ productUnitId: r.productUnitId, basePrice: r.generalPrice }));
    const prices = await this.rowsRepository.findBookPrices([base], rows.map((r) => r.productUnitId));
    const priceOf = new Map(prices.map((p) => [p.productUnitId, p.price]));
    return rows.map((r) => ({ productUnitId: r.productUnitId, basePrice: priceOf.get(r.productUnitId) ?? null }));
  }

  private termsOf(book: PriceBookRow): FormulaTerms | null {
    if (!book.formulaBase || !book.formulaOp || book.formulaAmount === null || !book.formulaUnit) return null;
    return { op: book.formulaOp as '+' | '-', amount: Number(book.formulaAmount), unit: book.formulaUnit as 'vnd' | '%' };
  }

  private async getEditableBook(bookId: string, user: JwtUser): Promise<PriceBookRow> {
    const book = await this.bookRepository.findById(bookId);
    if (!book) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Bảng giá không tồn tại' });
    assertCanEditBook(resolveBranchScope(user), book.branches.map((b) => b.branchId));
    return book;
  }
}
