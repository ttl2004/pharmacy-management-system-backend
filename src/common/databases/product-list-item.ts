import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Một dòng Danh mục hàng hoá / Hàng hoá chi nhánh: tóm tắt + đủ trường cho mọi cột FE (đơn vị bán, vị trí, mô tả, số
 * đăng ký/nước SX của thuốc liên kết). Chỉ dùng cho trang đã phân trang (≤ 100 dòng).
 */
export const PRODUCT_LIST_ITEM_SELECT = {
  id: true,
  code: true,
  barcode: true,
  name: true,
  imageUrls: true,
  categoryId: true,
  manufacturerId: true,
  baseUnitId: true,
  dosageForm: true,
  packagingSpec: true,
  requiresPrescription: true,
  minStockLevel: true,
  status: true,
  type: true,
  trackBatches: true,
  isControlled: true,
  maxStockLevel: true,
  shortName: true,
  weight: true,
  weightUnit: true,
  isFavourite: true,
  routeId: true,
  drugId: true,
  createdAt: true,
  updatedAt: true,
  description: true,
  orderNote: true,
  category: { select: { id: true, code: true, name: true } },
  manufacturer: { select: { id: true, code: true, name: true } },
  baseUnit: { select: { id: true, code: true, name: true } },
  drug: {
    select: {
      id: true,
      code: true,
      name: true,
      ingredients: true,
      strength: true,
      registrationNumber: true,
      countryOfOrigin: true,
      controlType: true,
    },
  },
  units: {
    where: { isDeleted: false },
    orderBy: [{ isBaseUnit: 'desc' }, { conversionRate: 'asc' }],
    select: {
      id: true,
      conversionRate: true,
      salePrice: true,
      barcode: true,
      isBaseUnit: true,
      allowLooseSale: true,
      nationalUnitCode: true,
      status: true,
      unit: { select: { id: true, code: true, name: true } },
    },
  },
  locations: {
    orderBy: { location: { name: 'asc' } },
    select: { location: { select: { id: true, name: true } } },
  },
} satisfies Prisma.ProductSelect;

export type ProductListItem = Prisma.ProductGetPayload<{ select: typeof PRODUCT_LIST_ITEM_SELECT }>;

/** Đọc đủ trường cho các id của trang, GIỮ thứ tự `ids` (thứ tự do câu SQL lọc/sắp xếp quyết). */
export async function findListItemsInOrder(
  prisma: Pick<PrismaClient, 'product'>,
  ids: string[],
): Promise<ProductListItem[]> {
  if (!ids.length) return [];
  const rows = await prisma.product.findMany({ where: { id: { in: ids } }, select: PRODUCT_LIST_ITEM_SELECT });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}
