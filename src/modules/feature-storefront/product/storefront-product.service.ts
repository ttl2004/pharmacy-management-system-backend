import { Injectable } from '@nestjs/common';
import { Product, RecordStatus } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { BaseWhere } from 'src/providers/abstract-base/repositories/abstract-base.repository';
import { ProductRepository } from '../../feature-catalog/product/repositories/product.repository';
import { StorefrontProductQuery } from './dtos/storefront-product.query';

@Injectable()
export class StorefrontProductService {
  constructor(private readonly productRepository: ProductRepository) {}

  async list(query: StorefrontProductQuery) {
    // Ép cứng trạng thái: DTO công khai không có `status` nên client không thể tự nới bộ lọc này.
    const filter: BaseWhere<Product> = { status: RecordStatus.ACTIVE };
    if (query.categoryId) filter.categoryId = query.categoryId;
    if (query.manufacturerId) filter.manufacturerId = query.manufacturerId;
    if (query.dosageForm) filter.dosageForm = query.dosageForm;
    if (query.requiresPrescription !== undefined) filter.requiresPrescription = query.requiresPrescription;

    return this.productRepository.findPublicPage(filter, {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      search: query.search,
      searchFields: ['name', 'activeIngredient'],
    });
  }

  async getDetail(id: string) {
    const product = await this.productRepository.findPublicDetail(id);
    if (!product) {
      // Sản phẩm ngừng bán trả về như không tồn tại, không để lộ là nó có nhưng đang ẩn.
      throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Sản phẩm không tồn tại' });
    }
    return product;
  }
}
