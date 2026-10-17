import { RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
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
  product: { id: string; name: string; status: RecordStatus; requiresPrescription: boolean };
}

export interface RequestedLine {
  productUnitId: string;
  quantity: number;
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
}

/**
 * Dựng dòng đơn từ yêu cầu của client. Giá, tên và hệ số lấy từ DB tại thời điểm này rồi SAO CHÉP vào dòng — in lại hoá đơn
 * cũ vẫn đúng dù sản phẩm đổi giá hay đổi quy cách. Thứ tự dòng giữ đúng thứ tự client gửi.
 */
export function buildOrderLines(requested: readonly RequestedLine[], units: readonly SellableUnit[]): OrderLine[] {
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
    return {
      productId: unit.product.id,
      productUnitId: unit.id,
      productName: unit.product.name,
      unitName: unit.unit.name,
      conversionRate: unit.conversionRate,
      quantity: line.quantity,
      baseQuantity,
      unitPrice: unit.salePrice,
      totalPrice: BigInt(line.quantity) * BigInt(unit.salePrice),
      requiresPrescription: unit.product.requiresPrescription,
    };
  });
}

/** Tổng đơn. Chưa có giảm giá (luật đã chốt) nên tổng = tạm tính + phí ship — khớp CHECK `orders_total_formula_chk`. */
export function orderTotals(
  lines: readonly OrderLine[],
  shippingFee = 0,
): { subtotalAmount: bigint; totalAmount: bigint } {
  const subtotalAmount = lines.reduce((sum, line) => sum + line.totalPrice, 0n);
  return { subtotalAmount, totalAmount: subtotalAmount + BigInt(shippingFee) };
}
