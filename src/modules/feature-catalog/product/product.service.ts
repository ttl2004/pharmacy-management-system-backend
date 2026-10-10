import { Injectable } from '@nestjs/common';
import { Prisma, Product, RecordStatus } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { AbstractBaseService } from 'src/providers/abstract-base/abstract-base.service';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { SessionTransactions } from '../../feature-auth/authz/session.store';
import { CreateProductRequest, ProductUnitRequest, UpdateProductRequest } from './dtos/product.request';
import { ProductQuery } from './dtos/product.query';
import { ProductDetail, ProductRepository } from './repositories/product.repository';

@Injectable()
export class ProductService extends AbstractBaseService<Product> {
  constructor(
    private readonly productRepository: ProductRepository,
    private readonly transactions: SessionTransactions,
  ) {
    super(productRepository);
  }

  async list(query: ProductQuery) {
    const filter: BaseWhere<Product> = {};
    if (query.categoryId) filter.categoryId = query.categoryId;
    if (query.manufacturerId) filter.manufacturerId = query.manufacturerId;
    if (query.baseUnitId) filter.baseUnitId = query.baseUnitId;
    if (query.status) filter.status = query.status;
    if (query.dosageForm) filter.dosageForm = query.dosageForm;
    if (query.requiresPrescription !== undefined) filter.requiresPrescription = query.requiresPrescription;

    return this.productRepository.findPageWithSummary(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search,
      searchFields: ['code', 'barcode', 'name', 'activeIngredient'],
    });
  }

  async getDetail(id: string): Promise<ProductDetail> {
    const product = await this.productRepository.findDetail(id);
    if (!product) throw this.notFound();
    return product;
  }

  async create(dto: CreateProductRequest, callerId: string): Promise<ProductDetail> {
    this.assertUnitConfig(dto.units, dto.baseUnitId, dto.barcode ?? null);

    let created: ProductDetail | null;
    try {
      created = await this.transactions.write(async (tx) => {
        await this.assertReferences(tx, {
          categoryId: dto.categoryId,
          manufacturerId: dto.manufacturerId ?? null,
          unitIds: [dto.baseUnitId, ...dto.units.map((unit) => unit.unitId)],
        });
        await this.assertBarcodesAvailable(tx, [dto.barcode, ...dto.units.map((unit) => unit.barcode)]);

        const product = await this.productRepository.createProduct(tx, {
          code: dto.code,
          barcode: dto.barcode ?? null,
          name: dto.name,
          imageUrls: dto.imageUrls ?? [],
          categoryId: dto.categoryId,
          manufacturerId: dto.manufacturerId ?? null,
          baseUnitId: dto.baseUnitId,
          activeIngredient: dto.activeIngredient ?? null,
          strength: dto.strength ?? null,
          dosageForm: dto.dosageForm ?? null,
          packagingSpec: dto.packagingSpec ?? null,
          requiresPrescription: dto.requiresPrescription ?? false,
          indications: dto.indications ?? null,
          dosageNote: dto.dosageNote ?? null,
          storageNote: dto.storageNote ?? null,
          minStockLevel: dto.minStockLevel ?? 0,
          status: dto.status ?? RecordStatus.ACTIVE,
          createdBy: callerId,
        });

        await this.productRepository.createUnits(
          tx,
          dto.units.map((unit) => ({
            productId: product.id,
            unitId: unit.unitId,
            conversionRate: unit.conversionRate,
            salePrice: unit.salePrice,
            barcode: unit.barcode ?? null,
            isBaseUnit: unit.isBaseUnit ?? false,
            status: unit.status ?? RecordStatus.ACTIVE,
            createdBy: callerId,
          })),
        );

        return this.productRepository.findDetailWith(tx, product.id);
      });
    } catch (error) {
      rethrowDuplicate(error);
    }

    if (!created) throw this.notFound();
    return created;
  }

  async update(id: string, dto: UpdateProductRequest, callerId: string): Promise<ProductDetail> {
    if (Object.keys(dto).length === 0) throw this.badRequest('Cần gửi ít nhất một trường để cập nhật');

    let updated: ProductDetail | null;
    try {
      updated = await this.transactions.write(async (tx) => {
        // Đọc trong cùng transaction với bước ghi: mọi suy luận bên dưới phải dựa trên trạng thái
        // sẽ được ghi đè, không phải snapshot đọc ngoài (đọc không được tuần tự hoá như ghi).
        const existing = await this.productRepository.findDetailWith(tx, id);
        if (!existing) throw this.notFound();

        const baseUnitId = dto.baseUnitId ?? existing.baseUnitId;
        const baseUnitChanged = dto.baseUnitId !== undefined && dto.baseUnitId !== existing.baseUnitId;

        if (baseUnitChanged && dto.units === undefined) {
          throw this.badRequest('Phải gửi kèm units chứa đơn vị cơ bản mới khi đổi đơn vị cơ bản');
        }
        if (dto.units !== undefined) {
          if (dto.units.length === 0) throw this.badRequest('Sản phẩm phải có ít nhất một đơn vị bán');
          this.assertUnitConfig(dto.units, baseUnitId, dto.barcode ?? null);
        }

        await this.assertUpdatedReferences(tx, dto, baseUnitId);
        await this.assertUpdatedBarcodes(tx, id, dto);

        const written = await this.productRepository.updateProduct(tx, id, this.toUpdateData(dto, callerId));
        if (!written) throw this.notFound();

        if (dto.units) await this.replaceUnits(tx, id, dto.units, callerId);

        return this.productRepository.findDetailWith(tx, id);
      });
    } catch (error) {
      rethrowDuplicate(error);
    }

    if (!updated) throw this.notFound();
    return updated;
  }

  /**
   * Xoá mềm Product cùng toàn bộ ProductUnit đang hoạt động trong một transaction. Không xoá vật lý
   * để chứng từ kho/đơn hàng về sau vẫn tham chiếu được lịch sử.
   */
  async remove(id: string, callerId: string): Promise<{ success: true }> {
    await this.transactions.write(async (tx) => {
      const existing = await this.productRepository.findDetailWith(tx, id);
      if (!existing) throw this.notFound();

      const rows = await this.productRepository.findUnitsForReconcile(tx, id);
      const activeIds = rows.filter((row) => !row.isDeleted).map((row) => row.id);

      await this.productRepository.softDeleteUnits(tx, activeIds, callerId);
      await this.productRepository.softDeleteProduct(tx, id, callerId);
    });

    return { success: true };
  }

  /** Cấu hình đơn vị bán là lỗi dữ liệu client gửi (1002), khác với tham chiếu sai (1602). */
  private assertUnitConfig(units: ProductUnitRequest[], baseUnitId: string, productBarcode: string | null): void {
    const baseRows = units.filter((unit) => unit.isBaseUnit);
    if (baseRows.length !== 1) throw this.badRequest('Sản phẩm phải có đúng một đơn vị cơ bản');

    const baseRow = baseRows[0];
    if (baseRow.unitId !== baseUnitId) {
      throw this.badRequest('Đơn vị cơ bản phải nằm trong cấu hình đơn vị bán và khớp baseUnitId');
    }
    if (baseRow.conversionRate !== 1) throw this.badRequest('Đơn vị cơ bản phải có hệ số quy đổi bằng 1');

    const unitIds = units.map((unit) => unit.unitId);
    if (new Set(unitIds).size !== unitIds.length) {
      throw this.badRequest('Mỗi đơn vị chỉ được xuất hiện một lần trong cấu hình đơn vị bán');
    }

    const barcodes = [productBarcode, ...units.map((unit) => unit.barcode)].filter((barcode): barcode is string =>
      Boolean(barcode),
    );
    if (new Set(barcodes).size !== barcodes.length) {
      throw this.badRequest('Mã vạch của sản phẩm và các đơn vị bán không được trùng nhau');
    }
  }

  private async assertReferences(
    client: Prisma.TransactionClient,
    refs: { categoryId: string; manufacturerId: string | null; unitIds: string[] },
  ): Promise<void> {
    const category = await this.productRepository.findActiveCategory(client, refs.categoryId);
    if (!category) throw this.invalidReference('Nhóm sản phẩm không tồn tại hoặc đã ngừng hoạt động');

    if (refs.manufacturerId) {
      const manufacturer = await this.productRepository.findActiveManufacturer(client, refs.manufacturerId);
      if (!manufacturer) throw this.invalidReference('Hãng sản xuất không tồn tại hoặc đã ngừng hoạt động');
    }

    const wanted = [...new Set(refs.unitIds)];
    const found = await this.productRepository.findUnits(client, wanted);
    if (found.length !== wanted.length) {
      throw this.invalidReference('Đơn vị cơ bản hoặc đơn vị bán không tồn tại hoặc đã bị xoá');
    }
  }

  private async assertBarcodesAvailable(
    client: Prisma.TransactionClient,
    barcodes: (string | null | undefined)[],
    exclude: { productId?: string; productUnitIds?: string[] } = {},
  ): Promise<void> {
    const wanted = barcodes.filter((barcode): barcode is string => Boolean(barcode));
    if (!wanted.length) return;

    const conflict = await this.productRepository.findBarcodeConflict(client, wanted, exclude);
    if (conflict) {
      const target = conflict.source === 'products' ? 'sản phẩm' : 'đơn vị bán';
      throw new ErrorException({
        code: ErrorCode.DUPLICATE_CODE,
        message: `Mã vạch ${conflict.barcode} đã được dùng ở ${target} khác`,
      });
    }
  }

  /**
   * Chỉ kiểm tra tham chiếu mà client thực sự đổi: sản phẩm đang trỏ tới nhóm/hãng đã chuyển INACTIVE
   * vẫn đọc và cập nhật được, miễn không đổi sang tham chiếu mới.
   */
  private async assertUpdatedReferences(
    client: Prisma.TransactionClient,
    dto: UpdateProductRequest,
    baseUnitId: string,
  ): Promise<void> {
    if (dto.categoryId !== undefined) {
      const category = await this.productRepository.findActiveCategory(client, dto.categoryId);
      if (!category) throw this.invalidReference('Nhóm sản phẩm không tồn tại hoặc đã ngừng hoạt động');
    }

    if (dto.manufacturerId !== undefined && dto.manufacturerId !== null) {
      const manufacturer = await this.productRepository.findActiveManufacturer(client, dto.manufacturerId);
      if (!manufacturer) throw this.invalidReference('Hãng sản xuất không tồn tại hoặc đã ngừng hoạt động');
    }

    if (dto.units !== undefined) {
      const wanted = [...new Set([baseUnitId, ...dto.units.map((unit) => unit.unitId)])];
      const found = await this.productRepository.findUnits(client, wanted);
      if (found.length !== wanted.length) {
        throw this.invalidReference('Đơn vị cơ bản hoặc đơn vị bán không tồn tại hoặc đã bị xoá');
      }
    }
  }

  private async assertUpdatedBarcodes(
    client: Prisma.TransactionClient,
    productId: string,
    dto: UpdateProductRequest,
  ): Promise<void> {
    const payloadBarcodes = [dto.barcode, ...(dto.units ?? []).map((unit) => unit.barcode)];
    const wanted = payloadBarcodes.filter((barcode): barcode is string => Boolean(barcode));
    if (!wanted.length) return;

    const ownRows = await this.productRepository.findUnitsForReconcile(client, productId);
    await this.assertBarcodesAvailable(client, wanted, {
      productId,
      productUnitIds: ownRows.map((row) => row.id),
    });
  }

  private toUpdateData(dto: UpdateProductRequest, callerId: string): Prisma.ProductUncheckedUpdateInput {
    const data: Prisma.ProductUncheckedUpdateInput = { updatedBy: callerId };
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.barcode !== undefined) data.barcode = dto.barcode;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.imageUrls !== undefined) data.imageUrls = dto.imageUrls;
    if (dto.categoryId !== undefined) data.categoryId = dto.categoryId;
    if (dto.manufacturerId !== undefined) data.manufacturerId = dto.manufacturerId;
    if (dto.baseUnitId !== undefined) data.baseUnitId = dto.baseUnitId;
    if (dto.activeIngredient !== undefined) data.activeIngredient = dto.activeIngredient;
    if (dto.strength !== undefined) data.strength = dto.strength;
    if (dto.dosageForm !== undefined) data.dosageForm = dto.dosageForm;
    if (dto.packagingSpec !== undefined) data.packagingSpec = dto.packagingSpec;
    if (dto.requiresPrescription !== undefined) data.requiresPrescription = dto.requiresPrescription;
    if (dto.indications !== undefined) data.indications = dto.indications;
    if (dto.dosageNote !== undefined) data.dosageNote = dto.dosageNote;
    if (dto.storageNote !== undefined) data.storageNote = dto.storageNote;
    if (dto.minStockLevel !== undefined) data.minStockLevel = dto.minStockLevel;
    if (dto.status !== undefined) data.status = dto.status;

    return data;
  }

  /** Replace-all: dòng có trong payload được cập nhật hoặc kích hoạt lại, dòng vắng mặt bị xoá mềm. */
  private async replaceUnits(
    client: Prisma.TransactionClient,
    productId: string,
    units: ProductUnitRequest[],
    callerId: string,
  ): Promise<void> {
    const existingRows = await this.productRepository.findUnitsForReconcile(client, productId);
    const existingByUnitId = new Map(existingRows.map((row) => [row.unitId, row]));
    const wantedUnitIds = new Set(units.map((unit) => unit.unitId));

    for (const unit of units) {
      const existingRow = existingByUnitId.get(unit.unitId);
      if (!existingRow) continue;

      const data: Prisma.ProductUnitUncheckedUpdateInput = {
        conversionRate: unit.conversionRate,
        salePrice: unit.salePrice,
        barcode: unit.barcode ?? null,
        isBaseUnit: unit.isBaseUnit ?? false,
        isDeleted: false,
        updatedBy: callerId,
      };
      // Mặc định ACTIVE chỉ dành cho dòng mới hoặc dòng vừa được kích hoạt lại; dòng đang hoạt động
      // mà client không gửi status thì giữ nguyên trạng thái cũ, tránh bật lại dòng INACTIVE ngoài ý muốn.
      if (unit.status !== undefined) data.status = unit.status;
      else if (existingRow.isDeleted) data.status = RecordStatus.ACTIVE;

      await this.productRepository.updateUnit(client, existingRow.id, data);
    }

    const toCreate = units.filter((unit) => !existingByUnitId.has(unit.unitId));
    if (toCreate.length) {
      await this.productRepository.createUnits(
        client,
        toCreate.map((unit) => ({
          productId,
          unitId: unit.unitId,
          conversionRate: unit.conversionRate,
          salePrice: unit.salePrice,
          barcode: unit.barcode ?? null,
          isBaseUnit: unit.isBaseUnit ?? false,
          status: unit.status ?? RecordStatus.ACTIVE,
          createdBy: callerId,
        })),
      );
    }

    const removedIds = existingRows
      .filter((row) => !row.isDeleted && !wantedUnitIds.has(row.unitId))
      .map((row) => row.id);
    await this.productRepository.softDeleteUnits(client, removedIds, callerId);
  }

  private notFound(): ErrorException {
    return new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Sản phẩm không tồn tại' });
  }

  private invalidReference(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.INVALID_REFERENCE, message });
  }

  private badRequest(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
  }
}
