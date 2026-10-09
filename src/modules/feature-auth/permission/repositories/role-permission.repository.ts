import { Injectable } from '@nestjs/common';
import { Prisma, RolePermission } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class RolePermissionRepository extends PrismaBaseRepository<RolePermission> {
  constructor(prisma: PrismaService) {
    super(prisma, 'RolePermission');
  }

  /** Mã các quyền đang hoạt động của một vai trò. Guard gọi hàm này ở mỗi request. */
  async findGrantedCodes(roleId: string): Promise<string[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId, isDeleted: false },
      select: { permission: { select: { code: true } } },
    });

    return rows.map((row) => row.permission.code);
  }

  /** Số quyền đang hoạt động của từng vai trò, dùng cho màn hình danh sách vai trò. */
  async countActivePerRole(): Promise<Map<string, number>> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { isDeleted: false },
      select: { roleId: true },
    });

    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.roleId, (counts.get(row.roleId) ?? 0) + 1);
    return counts;
  }

  /** Vai trò đã từng được cấu hình quyền chưa, **kể cả** bản ghi đã xoá mềm. Seed dùng để không ghi đè cấu hình đã chỉnh. */
  async hasAnyGrant(roleId: string): Promise<boolean> {
    return (await this.prisma.rolePermission.count({ where: { roleId } })) > 0;
  }

  /**
   * Ghi đè toàn bộ tập quyền của một vai trò.
   *
   * Bảng có ràng buộc `@@unique([roleId, permissionId])` nên không thể xoá cứng rồi tạo lại:
   * bản ghi xoá mềm vẫn chiếm chỗ và lần `create` sau sẽ vi phạm ràng buộc. Vì vậy quyền bị thu
   * hồi thì đánh dấu `isDeleted`, quyền được cấp lại thì bật lại bản ghi cũ.
   */
  async replaceForRole(
    tx: Prisma.TransactionClient,
    roleId: string,
    permissionIds: string[],
    actorId: string,
  ): Promise<void> {
    const now = new Date();
    const wanted = new Set(permissionIds);
    const existing = await tx.rolePermission.findMany({ where: { roleId } });

    const known = new Set(existing.map((row) => row.permissionId));
    const toCreate = permissionIds.filter((permissionId) => !known.has(permissionId));
    const toRestore = existing.filter((row) => wanted.has(row.permissionId) && row.isDeleted);
    const toRevoke = existing.filter((row) => !wanted.has(row.permissionId) && !row.isDeleted);

    if (toCreate.length) {
      await tx.rolePermission.createMany({
        data: toCreate.map((permissionId) => ({ roleId, permissionId, createdBy: actorId })),
      });
    }
    if (toRestore.length) {
      await tx.rolePermission.updateMany({
        where: { id: { in: toRestore.map((row) => row.id) } },
        data: { isDeleted: false, updatedAt: now, updatedBy: actorId },
      });
    }
    if (toRevoke.length) {
      await tx.rolePermission.updateMany({
        where: { id: { in: toRevoke.map((row) => row.id) } },
        data: { isDeleted: true, updatedAt: now, updatedBy: actorId },
      });
    }
  }
}
