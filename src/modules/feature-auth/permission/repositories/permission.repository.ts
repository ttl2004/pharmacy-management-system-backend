import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class PermissionRepository extends PrismaBaseRepository<Permission> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Permission');
  }

  /** Toàn bộ danh mục quyền, sắp theo module rồi thứ tự hiển thị. */
  async findAllOrdered(): Promise<Permission[]> {
    return this.prisma.permission.findMany({
      where: { isDeleted: false },
      orderBy: [{ module: 'asc' }, { sortOrder: 'asc' }],
    });
  }
}
