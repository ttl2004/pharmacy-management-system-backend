import { Injectable } from '@nestjs/common';
import { Auth, User } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

export type AuthWithUser = Auth & { user: User };

@Injectable()
export class AuthzRepository extends PrismaBaseRepository<Auth> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Auth');
  }

  /**
   * Truy vấn đặc thù của luồng đăng nhập: cần kèm `user` để kiểm tra trạng thái.
   * Dùng thẳng delegate có kiểu của Prisma thay vì `include` động của base.
   */
  findByUsernameWithUser(username: string): Promise<AuthWithUser | null> {
    return this.prisma.auth.findFirst({
      where: { username, isDeleted: false },
      include: { user: true },
    });
  }
}
