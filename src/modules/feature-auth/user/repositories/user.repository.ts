import { Injectable } from '@nestjs/common';
import { Role, User } from '@prisma/client';
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

  /** Lấy user kèm vai trò — vai trò nằm ở bảng `roles` từ khi chuyển sang khoá ngoại. */
  async findByIdWithRole(id: string): Promise<(User & { role: Role }) | null> {
    return this.prisma.user.findFirst({ where: { id, isDeleted: false }, include: { role: true } });
  }

  /**
   * Đổi `roleCode` thành `roleId` để lọc được bằng base repository — `BaseWhere` chỉ nhận tên
   * cột, không nhận điều kiện trên quan hệ.
   */
  async findRoleIdByCode(code: string): Promise<string | null> {
    const role = await this.prisma.role.findFirst({
      where: { code, isDeleted: false },
      select: { id: true },
    });
    return role?.id ?? null;
  }

  /** Chi tiết người dùng kèm vai trò và chi nhánh. */
  findByIdWithRoleAndBranch(id: string) {
    return this.prisma.user.findFirst({
      where: { id, isDeleted: false },
      include: { role: true, branch: true },
    });
  }
}
