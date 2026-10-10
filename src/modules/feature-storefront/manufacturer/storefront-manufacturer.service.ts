import { Injectable } from '@nestjs/common';
import { ManufacturerRepository } from '../../feature-catalog/manufacturer/repositories/manufacturer.repository';

@Injectable()
export class StorefrontManufacturerService {
  constructor(private readonly manufacturerRepository: ManufacturerRepository) {}

  /** Danh sách hãng cho bộ lọc storefront; repository đã lọc ACTIVE và chỉ lấy trường công khai. */
  list() {
    return this.manufacturerRepository.findPublicList();
  }
}
