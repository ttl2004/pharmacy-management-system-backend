import { Prisma, ProductType } from '@prisma/client';
import { ProductExtraFieldsRequest } from './dtos/product-extra-fields.request';

/** Chuỗi rỗng sau trim coi như xoá (null), giống quy ước các trường văn bản khác của sản phẩm. */
const text = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value?.trim() || null;

/** Cột mở rộng khi tạo. `locationIds` ghi riêng vào bảng nối nên không có ở đây. */
export function toExtraCreateData(dto: ProductExtraFieldsRequest) {
  const type = dto.type ?? ProductType.DRUG;
  return {
    type,
    // Mặc định như KiotViet: thuốc theo lô, hàng hoá thường không.
    trackBatches: dto.trackBatches ?? type === ProductType.DRUG,
    routeId: dto.routeId ?? null,
    isControlled: dto.isControlled ?? false,
    maxStockLevel: dto.maxStockLevel ?? null,
    shortName: text(dto.shortName) ?? null,
    weight: dto.weight ?? null,
    weightUnit: dto.weightUnit ?? 'g',
    description: text(dto.description) ?? null,
    orderNote: text(dto.orderNote) ?? null,
    isFavourite: dto.isFavourite ?? false,
    drugId: dto.drugId ?? null,
  } satisfies Partial<Prisma.ProductUncheckedCreateInput>;
}

/**
 * Cột mở rộng khi sửa: chỉ trường client gửi. `type` không ghi (service đã chặn đổi loại), `locationIds`
 * thay toàn bộ ở bảng nối.
 */
export function toExtraUpdateData(dto: ProductExtraFieldsRequest): Prisma.ProductUncheckedUpdateInput {
  const data: Prisma.ProductUncheckedUpdateInput = {};
  if (dto.trackBatches !== undefined) data.trackBatches = dto.trackBatches;
  if (dto.routeId !== undefined) data.routeId = dto.routeId;
  if (dto.isControlled !== undefined) data.isControlled = dto.isControlled;
  if (dto.maxStockLevel !== undefined) data.maxStockLevel = dto.maxStockLevel;
  if (dto.shortName !== undefined) data.shortName = text(dto.shortName);
  if (dto.weight !== undefined) data.weight = dto.weight;
  if (dto.weightUnit !== undefined) data.weightUnit = dto.weightUnit;
  if (dto.description !== undefined) data.description = text(dto.description);
  if (dto.orderNote !== undefined) data.orderNote = text(dto.orderNote);
  if (dto.isFavourite !== undefined) data.isFavourite = dto.isFavourite;
  if (dto.drugId !== undefined) data.drugId = dto.drugId;
  return data;
}
