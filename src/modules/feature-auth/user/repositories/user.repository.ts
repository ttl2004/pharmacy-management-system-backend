import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class UserRepository extends PrismaBaseRepository<User> {
  constructor(prisma: PrismaService) {
    super(prisma, 'User');
  }

  /**
   * Tìm user theo email bất kể đã bị soft delete hay chưa.
   *
   * `findOne()` của base repository luôn chèn `isDeleted: false`, nhưng seed cần
   * nhìn thấy cả bản ghi đã soft delete để không cố tạo trùng — cột `email` là UNIQUE
   * nên lần tạo lại sẽ vi phạm ràng buộc.
   */
  async findByEmailIgnoringSoftDelete(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email } });
  }
}
