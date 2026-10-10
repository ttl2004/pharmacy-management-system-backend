import { Injectable } from '@nestjs/common';
import { CategoryRepository } from '../../feature-catalog/category/repositories/category.repository';

@Injectable()
export class StorefrontCategoryService {
  constructor(private readonly categoryRepository: CategoryRepository) {}

  /** Danh sách nhóm cho menu storefront; repository đã lọc ACTIVE và chỉ lấy trường công khai. */
  list() {
    return this.categoryRepository.findPublicList();
  }
}
