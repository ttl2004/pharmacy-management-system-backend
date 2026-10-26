import { PriceBookPolicy, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { ErrorException } from 'src/common/exceptions/error.exception';
import type { ApplicableBook } from 'src/modules/feature-catalog/price-book/price-book.service';
import { MAX_BASE_QUANTITY } from 'src/modules/feature-inventory/core/inventory.constants';
import { badRequest } from 'src/modules/feature-inventory/core/inventory.error';
import { salesError } from './sales.error';

/** Đơn vị bán đọc từ DB kèm sản phẩm — đủ để dựng một dòng đơn. */
export interface SellableUnit {
  id: string;
  conversionRate: number;
  salePrice: number;
  status: RecordStatus;
  unit: { name: string };
  product: { id: string; name: string; status: RecordStatus; requiresPrescription: boolean; isControlled?: boolean };
}

export interface RequestedLine {
  productUnitId: string;
  quantity: number;
}

/** Bảng giá áp lên đơn: giá theo đơn vị bán + cách xử lý hàng ngoài bảng. */
export interface BookPricing {
  outOfBookPolicy: PriceBookPolicy;
  priceByUnitId: Map<string, number>;
}

export function toBookPricing(book: ApplicableBook): BookPricing {
  return {
    outOfBookPolicy: book.outOfBookPolicy,
    priceByUnitId: new Map(book.items.map((item) => [item.productUnitId, item.price])),
  };
}

/** Giá của một đơn vị theo bảng; null = hàng không có trong bảng (hoặc không dùng bảng). */
export function bookPriceOf(book: BookPricing | undefined, productUnitId: string): number | null {
  return book?.priceByUnitId.get(productUnitId) ?? null;
}

/** Đơn gắn bảng giá đã bị xoá (`priceBookId` về null, tên còn) — không sửa dòng được nữa (D10). */
export function deletedPriceBookError(name: string): ErrorException {
  return new ErrorException({
    code: ErrorCode.PRICE_BOOK_UNAVAILABLE,
    message: `Bảng giá "${name}" đã bị xoá — không sửa được dòng đơn`,
  });
}

/** Một dòng đơn đã tính xong — đúng các cột của `order_items` cộng cờ kê đơn. */
export interface OrderLine {
  productId: string;
  productUnitId: string;
  productName: string;
  unitName: string;
  conversionRate: number;
  quantity: number;
  baseQuantity: number;
  unitPrice: number;
  totalPrice: bigint;
  requiresPrescription: boolean;
  /** Thuốc kiểm soát — đơn phải gắn khách có SĐT. */
  isControlled: boolean;
}

/**
 * Dựng dòng đơn từ yêu cầu của client. Giá, tên và hệ số lấy từ DB tại thời điểm này rồi SAO CHÉP vào dòng — in lại hoá đơn
 * cũ vẫn đúng dù sản phẩm đổi giá hay đổi quy cách. Thứ tự dòng giữ đúng thứ tự client gửi.
 */
export function buildOrderLines(
  requested: readonly RequestedLine[],
  units: readonly SellableUnit[],
  book?: BookPricing,
): OrderLine[] {
  if (new Set(requested.map((line) => line.productUnitId)).size !== requested.length) {
    throw badRequest('Một đơn vị bán chỉ được xuất hiện một lần trong đơn — gộp số lượng vào một dòng');
  }
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  return requested.map((line, index) => {
    const unit = unitById.get(line.productUnitId);
    if (!unit || unit.status !== RecordStatus.ACTIVE || unit.product.status !== RecordStatus.ACTIVE) {
      throw salesError(ErrorCode.PRODUCT_NOT_SELLABLE, `dòng ${index + 1}`);
    }
    const baseQuantity = line.quantity * unit.conversionRate;
    if (baseQuantity > MAX_BASE_QUANTITY) {
      throw badRequest(`Dòng ${index + 1} vượt quá ${MAX_BASE_QUANTITY} đơn vị cơ bản`);
    }
    // Có giá trong bảng → dùng giá bảng. Ngoài bảng: BLOCK chặn, ALLOW/WARN bán theo giá chung (WARN cảnh báo ở FE).
    const bookPrice = bookPriceOf(book, unit.id);
    if (book && bookPrice === null && book.outOfBookPolicy === PriceBookPolicy.BLOCK) {
      throw new ErrorException({
        code: ErrorCode.PRODUCT_NOT_IN_PRICE_BOOK,
        message: `Dòng ${index + 1}: hàng không có trong bảng giá đã chọn`,
      });
    }
    const unitPrice = bookPrice ?? unit.salePrice;
    return {
      productId: unit.product.id,
      productUnitId: unit.id,
      productName: unit.product.name,
      unitName: unit.unit.name,
      conversionRate: unit.conversionRate,
      quantity: line.quantity,
      baseQuantity,
      unitPrice,
      totalPrice: BigInt(line.quantity) * BigInt(unitPrice),
      requiresPrescription: unit.product.requiresPrescription,
      isControlled: unit.product.isControlled ?? false,
    };
  });
}

/**
 * Tổng đơn = tạm tính + phí ship − giảm giá (VND, ≤ tạm tính) — khớp CHECK `orders_total_formula_chk` và
 * `orders_discount_range_chk`. Giảm giá vượt tạm tính → 400.
 */
export function orderTotals(
  lines: readonly OrderLine[],
  shippingFee = 0,
  discount = 0,
): { subtotalAmount: bigint; discountAmount: bigint; totalAmount: bigint } {
  const subtotalAmount = lines.reduce((sum, line) => sum + line.totalPrice, 0n);
  const discountAmount = BigInt(discount);
  if (discountAmount > subtotalAmount) throw badRequest('Giảm giá vượt tổng tiền hàng');
  return { subtotalAmount, discountAmount, totalAmount: subtotalAmount + BigInt(shippingFee) - discountAmount };
}
