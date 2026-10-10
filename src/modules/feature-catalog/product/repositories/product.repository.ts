import { Injectable } from '@nestjs/common';
import { Prisma, Product, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { BaseWhere, PaginationResult } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

/**
 * Các cột đọc được của Product. Cố ý dùng `select` tường minh thay vì trả nguyên row: ẩn
 * `isDeleted`/`createdBy`/`updatedBy` và chỉ lấy quan hệ ở dạng tóm tắt.
 */
const PRODUCT_BASE_SELECT = {
  id: true,
  code: true,
  barcode: true,
  name: true,
  imageUrls: true,
  categoryId: true,
  manufacturerId: true,
  baseUnitId: true,
  activeIngredient: true,
  strength: true,
  dosageForm: true,
  packagingSpec: true,
  requiresPrescription: true,
  minStockLevel: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

const PRODUCT_SUMMARY_SELECT = {
  ...PRODUCT_BASE_SELECT,
  category: { select: { id: true, code: true, name: true } },
  manufacturer: { select: { id: true, code: true, name: true } },
  baseUnit: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ProductSelect;

const PRODUCT_DETAIL_SELECT = {
  ...PRODUCT_SUMMARY_SELECT,
  indications: true,
  dosageNote: true,
  storageNote: true,
  units: {
    where: { isDeleted: false },
    orderBy: [{ isBaseUnit: 'desc' }, { conversionRate: 'asc' }],
    select: {
      id: true,
      conversionRate: true,
      salePrice: true,
      barcode: true,
      isBaseUnit: true,
      status: true,
      unit: { select: { id: true, code: true, name: true } },
    },
  },
} satisfies Prisma.ProductSelect;

export type ProductSummary = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SUMMARY_SELECT }>;
export type ProductDetail = Prisma.ProductGetPayload<{ select: typeof PRODUCT_DETAIL_SELECT }>;

/**
 * Bộ trường cho storefront — tách hẳn khỏi bộ nội bộ để mỗi lần thêm cột mới phải chủ động quyết định
 * nó có ra công khai hay không, thay vì tự động lọt ra theo bộ nội bộ.
 */
const PUBLIC_PRODUCT_LIST_SELECT = {
  id: true,
  name: true,
  imageUrls: true,
  activeIngredient: true,
  strength: true,
  dosageForm: true,
  packagingSpec: true,
  requiresPrescription: true,
  category: { select: { id: true, name: true } },
  manufacturer: { select: { id: true, name: true } },
  units: {
    where: { isDeleted: false, status: RecordStatus.ACTIVE },
    orderBy: [{ isBaseUnit: 'desc' }, { conversionRate: 'asc' }],
    select: { conversionRate: true, salePrice: true, unit: { select: { name: true } } },
  },
} satisfies Prisma.ProductSelect;

const PUBLIC_PRODUCT_DETAIL_SELECT = {
  ...PUBLIC_PRODUCT_LIST_SELECT,
  indications: true,
  dosageNote: true,
  storageNote: true,
} satisfies Prisma.ProductSelect;

export type PublicProductSummary = Prisma.ProductGetPayload<{ select: typeof PUBLIC_PRODUCT_LIST_SELECT }>;
export type PublicProductDetail = Prisma.ProductGetPayload<{ select: typeof PUBLIC_PRODUCT_DETAIL_SELECT }>;

export interface ProductPageOptions {
  page: number;
  limit: number;
  sort?: string;
  search?: string;
  searchFields?: string[];
}

@Injectable()
export class ProductRepository extends PrismaBaseRepository<Product> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Product');
  }

  /**
   * Danh sách Product kèm quan hệ tóm tắt. Repository nền chỉ `include` boolean nên không lọc được
   * ProductUnit đã xoá mềm hay `select` gọn quan hệ — vì vậy đọc bằng truy vấn riêng ở đây.
   */
  async findPageWithSummary(
    filter: BaseWhere<Product>,
    options: ProductPageOptions,
  ): Promise<PaginationResult<ProductSummary>> {
    const searchIds = await this.resolveSearchIds(options.search, options.searchFields);
    const where = this.buildWhere(filter, searchIds) as Prisma.ProductWhereInput;

    const [hits, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: this.toOrder(options.sort),
        take: options.limit,
        skip: (options.page - 1) * options.limit,
        select: PRODUCT_SUMMARY_SELECT,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      hits,
      total,
      page: options.page,
      totalPages: Math.ceil(total / options.limit),
      limit: options.limit,
    };
  }

  /** Chi tiết Product kèm cấu hình đơn vị bán đang hoạt động. */
  findDetail(id: string): Promise<ProductDetail | null> {
    return this.findDetailWith(this.prisma, id);
  }

  /**
   * Bản dùng được **bên trong transaction**: đọc và ghi phải chung một client, nếu không phần suy luận
   * (`baseUnitId` hiệu lực, invariant đơn vị cơ bản) sẽ dựa trên snapshot cũ và ghi đè mất thay đổi đã
   * commit của request khác.
   */
  findDetailWith(client: Prisma.TransactionClient, id: string): Promise<ProductDetail | null> {
    return client.product.findFirst({ where: { id, isDeleted: false }, select: PRODUCT_DETAIL_SELECT });
  }

  /**
   * Danh sách đọc công khai cho storefront. Cùng khuôn với `findPageWithSummary` nhưng dùng bộ trường
   * công khai; service ép `status = ACTIVE` vì DTO công khai không nhận trạng thái từ client.
   */
  async findPublicPage(
    filter: BaseWhere<Product>,
    options: ProductPageOptions,
  ): Promise<PaginationResult<PublicProductSummary>> {
    const searchIds = await this.resolveSearchIds(options.search, options.searchFields);
    const where = this.buildWhere(filter, searchIds) as Prisma.ProductWhereInput;

    const [hits, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: this.toOrder(options.sort),
        take: options.limit,
        skip: (options.page - 1) * options.limit,
        select: PUBLIC_PRODUCT_LIST_SELECT,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      hits,
      total,
      page: options.page,
      totalPages: Math.ceil(total / options.limit),
      limit: options.limit,
    };
  }

  /** Chi tiết công khai: sản phẩm ngừng bán hoặc đã xoá mềm trả `null` như không tồn tại. */
  findPublicDetail(id: string): Promise<PublicProductDetail | null> {
    return this.prisma.product.findFirst({
      where: { id, isDeleted: false, status: RecordStatus.ACTIVE },
      select: PUBLIC_PRODUCT_DETAIL_SELECT,
    });
  }

  /** Nhóm sản phẩm dùng được làm tham chiếu: chưa xoá mềm và đang ACTIVE. */
  findActiveCategory(client: Prisma.TransactionClient, id: string): Promise<{ id: string } | null> {
    return client.category.findFirst({
      where: { id, isDeleted: false, status: RecordStatus.ACTIVE },
      select: { id: true },
    });
  }

  /** Hãng sản xuất dùng được làm tham chiếu: chưa xoá mềm và đang ACTIVE. */
  findActiveManufacturer(client: Prisma.TransactionClient, id: string): Promise<{ id: string } | null> {
    return client.manufacturer.findFirst({
      where: { id, isDeleted: false, status: RecordStatus.ACTIVE },
      select: { id: true },
    });
  }

  /** Đơn vị chỉ cần tồn tại và chưa xoá mềm — bảng `units` không có cột trạng thái. */
  findUnits(client: Prisma.TransactionClient, ids: string[]): Promise<{ id: string }[]> {
    return client.unit.findMany({ where: { id: { in: ids }, isDeleted: false }, select: { id: true } });
  }

  /**
   * Mã vạch đã bị dùng chưa. Quét **cả** bản ghi đã xoá mềm vì unique index của PostgreSQL là toàn
   * cục, và quét cả hai bảng vì ràng buộc unique chéo `products`/`product_units` không có ở tầng CSDL.
   */
  async findBarcodeConflict(
    client: Prisma.TransactionClient,
    barcodes: string[],
    exclude: { productId?: string; productUnitIds?: string[] } = {},
  ): Promise<{ barcode: string; source: 'products' | 'product_units' } | null> {
    const wanted = [...new Set(barcodes)];
    if (!wanted.length) return null;

    const product = await client.product.findFirst({
      where: { barcode: { in: wanted }, ...(exclude.productId ? { id: { not: exclude.productId } } : {}) },
      select: { barcode: true },
    });
    if (product?.barcode) return { barcode: product.barcode, source: 'products' };

    const unit = await client.productUnit.findFirst({
      where: {
        barcode: { in: wanted },
        ...(exclude.productUnitIds?.length ? { id: { notIn: exclude.productUnitIds } } : {}),
      },
      select: { barcode: true },
    });
    if (unit?.barcode) return { barcode: unit.barcode, source: 'product_units' };

    return null;
  }

  createProduct(client: Prisma.TransactionClient, data: Prisma.ProductUncheckedCreateInput): Promise<{ id: string }> {
    return client.product.create({ data, select: { id: true } });
  }

  async createUnits(client: Prisma.TransactionClient, rows: Prisma.ProductUnitUncheckedCreateInput[]): Promise<void> {
    await client.productUnit.createMany({ data: rows });
  }

  /**
   * Nạp toàn bộ ProductUnit của sản phẩm, **kể cả** dòng đã xoá mềm: replace-all cần biết dòng nào
   * phải kích hoạt lại thay vì `create` mới, vì unique `(productId, unitId)` vẫn giữ chỗ.
   */
  findUnitsForReconcile(
    client: Prisma.TransactionClient,
    productId: string,
  ): Promise<{ id: string; unitId: string; isDeleted: boolean }[]> {
    return client.productUnit.findMany({
      where: { productId },
      select: { id: true, unitId: true, isDeleted: true },
    });
  }

  /** Trả số dòng đã ghi; 0 nghĩa là sản phẩm không tồn tại hoặc vừa bị xoá mềm. */
  async updateProduct(
    client: Prisma.TransactionClient,
    id: string,
    data: Prisma.ProductUncheckedUpdateInput,
  ): Promise<number> {
    const result = await client.product.updateMany({ where: { id, isDeleted: false }, data });
    return result.count;
  }

  /** Ghi đè một dòng ProductUnit theo id — dùng cho cả cập nhật lẫn kích hoạt lại dòng đã xoá mềm. */
  async updateUnit(
    client: Prisma.TransactionClient,
    id: string,
    data: Prisma.ProductUnitUncheckedUpdateInput,
  ): Promise<void> {
    await client.productUnit.update({ where: { id }, data });
  }

  /** Xoá mềm Product. Ghi được `updatedBy` nên không dùng `softDelete` của repository nền. */
  async softDeleteProduct(client: Prisma.TransactionClient, id: string, actorId: string): Promise<void> {
    await client.product.update({
      where: { id },
      data: { isDeleted: true, updatedBy: actorId, updatedAt: new Date() },
    });
  }

  /** Xoá mềm dòng bị loại khỏi payload. Ghi được `updatedBy` nên không dùng `softDeleteMany` của base. */
  async softDeleteUnits(client: Prisma.TransactionClient, ids: string[], actorId: string): Promise<void> {
    if (!ids.length) return;

    await client.productUnit.updateMany({
      where: { id: { in: ids }, isDeleted: false },
      data: { isDeleted: true, updatedBy: actorId, updatedAt: new Date() },
    });
  }
}
