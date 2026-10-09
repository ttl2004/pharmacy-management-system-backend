import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class RoleRepository extends PrismaBaseRepository<Role> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Role');
  }
}
