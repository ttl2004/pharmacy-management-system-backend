import { Injectable } from '@nestjs/common';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { CreateLocationRequest } from './dtos/location.request';
import { LocationRepository, LocationSummary } from './repositories/location.repository';

/** Vị trí (kệ/tủ) dùng chung toàn chuỗi — chỉ xem và tạo (tạo ngay trong form sản phẩm). */
@Injectable()
export class LocationService {
  constructor(private readonly locationRepository: LocationRepository) {}

  list(): Promise<LocationSummary[]> {
    return this.locationRepository.listAll();
  }

  async create(dto: CreateLocationRequest, callerId: string): Promise<LocationSummary> {
    if (await this.locationRepository.findByNameInsensitive(dto.name)) {
      throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Vị trí "${dto.name}" đã tồn tại` });
    }
    try {
      const created = await this.locationRepository.create({ name: dto.name, createdBy: callerId });
      return { id: created.id, name: created.name };
    } catch (error) {
      rethrowDuplicate(error);
    }
  }
}
