import { Injectable } from '@nestjs/common';
import { Manufacturer, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class ManufacturerRepository extends PrismaBaseRepository<Manufacturer> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Manufacturer');
  }

  /** Danh sách cho storefront: chỉ hãng ACTIVE, chỉ trường công khai. */
  findPublicList(): Promise<{ id: string; name: string; country: string | null }[]> {
    return this.prisma.manufacturer.findMany({
      where: { isDeleted: false, status: RecordStatus.ACTIVE },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, country: true },
    });
  }

  /** Đếm sản phẩm tham chiếu **kể cả** bản ghi đã xoá mềm: xoá mềm không giải phóng quan hệ. */
  countProducts(manufacturerId: string): Promise<number> {
    return this.prisma.product.count({ where: { manufacturerId } });
  }
}
