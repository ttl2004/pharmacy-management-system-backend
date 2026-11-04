import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { CreateLocationRequest } from './dtos/location.request';
import { LocationRepository, LocationSummary } from './repositories/location.repository';

/** Vị trí (kệ/tủ) dùng chung toàn chuỗi — chỉ xem và tạo (tạo ngay trong form sản phẩm). */
@Injectable()
export class LocationService {
  constructor(
    private readonly locationRepository: LocationRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  list(): Promise<LocationSummary[]> {
    return this.locationRepository.listAll();
  }

  async create(dto: CreateLocationRequest, actor: RequestActor): Promise<LocationSummary> {
    if (await this.locationRepository.findByNameInsensitive(dto.name)) {
      throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Vị trí "${dto.name}" đã tồn tại` });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await this.locationRepository.create({ name: dto.name, createdBy: actor.user.userId }, tx);
        await this.audit.record(tx, auditActorOf(actor), [
          {
            event: 'LOCATION.CREATED',
            entityType: 'shelf_locations',
            entityId: created.id,
            entityLabel: created.name,
            branchIds: [],
            after: { name: created.name },
            searchTerms: [created.name],
          },
        ]);
        return { id: created.id, name: created.name };
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }
}
