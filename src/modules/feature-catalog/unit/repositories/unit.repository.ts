import { Injectable } from '@nestjs/common';
import { Unit } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class UnitRepository extends PrismaBaseRepository<Unit> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Unit');
  }

  /** Đếm sản phẩm lấy đơn vị này làm đơn vị cơ bản, **kể cả** sản phẩm đã xoá mềm. */
  countBaseProducts(unitId: string): Promise<number> {
    return this.prisma.product.count({ where: { baseUnitId: unitId } });
  }

  /** Đếm cấu hình đơn vị bán tham chiếu, **kể cả** dòng đã xoá mềm. */
  countProductUnits(unitId: string): Promise<number> {
    return this.prisma.productUnit.count({ where: { unitId } });
  }
}
