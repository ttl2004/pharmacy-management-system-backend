import { Injectable } from '@nestjs/common';
import { Category, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

@Injectable()
export class CategoryRepository extends PrismaBaseRepository<Category> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Category');
  }

  /** Danh sách cho storefront: chỉ nhóm ACTIVE, chỉ trường công khai, sắp theo thứ tự hiển thị. */
  findPublicList(): Promise<{ id: string; name: string; parentId: string | null; sortOrder: number }[]> {
    return this.prisma.category.findMany({
      where: { isDeleted: false, status: RecordStatus.ACTIVE },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, parentId: true, sortOrder: true },
    });
  }

  /** Đếm nhóm con **kể cả** bản ghi đã xoá mềm: xoá mềm không giải phóng quan hệ cha–con. */
  countChildren(categoryId: string): Promise<number> {
    return this.prisma.category.count({ where: { parentId: categoryId } });
  }

  /** Đếm sản phẩm tham chiếu **kể cả** bản ghi đã xoá mềm, cùng lý do như `countChildren`. */
  countProducts(categoryId: string): Promise<number> {
    return this.prisma.product.count({ where: { categoryId } });
  }

  /**
   * Số hàng đang kinh doanh của từng nhóm, **cộng dồn** nhóm con cháu (như mock: chọn nhóm cha thấy cả hàng
   * nhóm con). Danh mục nhóm nhỏ nên đọc cả cây một lần rồi cộng trong bộ nhớ.
   */
  async countActiveProductsWithDescendants(): Promise<Map<string, number>> {
    const [categories, grouped] = await Promise.all([
      this.prisma.category.findMany({ where: { isDeleted: false }, select: { id: true, parentId: true } }),
      this.prisma.product.groupBy({
        by: ['categoryId'],
        where: { isDeleted: false, status: RecordStatus.ACTIVE },
        _count: { _all: true },
      }),
    ]);
    const own = new Map(grouped.map((g) => [g.categoryId, g._count._all]));
    const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
    const totals = new Map<string, number>(categories.map((c) => [c.id, 0]));
    // Mỗi nhóm cộng số hàng của mình lên chính nó và mọi tổ tiên (chặn vòng nếu dữ liệu lỗi).
    for (const c of categories) {
      const n = own.get(c.id) ?? 0;
      if (!n) continue;
      const seen = new Set<string>();
      for (let id: string | null | undefined = c.id; id && !seen.has(id); id = parentOf.get(id)) {
        seen.add(id);
        totals.set(id, (totals.get(id) ?? 0) + n);
      }
    }
    return totals;
  }

  /**
   * `candidateId` có nằm trong cây con của `ancestorId` không — duyệt ngược chuỗi cha.
   * Không lọc `isDeleted`: nhánh đã xoá mềm vẫn là một phần cấu trúc cây nên vẫn tạo được vòng.
   */
  async isInSubtreeOf(candidateId: string, ancestorId: string): Promise<boolean> {
    const visited = new Set<string>();
    let currentId: string | null = candidateId;

    while (currentId) {
      if (currentId === ancestorId) return true;
      // Dữ liệu vòng có sẵn (nếu có) không được làm treo vòng lặp.
      if (visited.has(currentId)) return false;
      visited.add(currentId);

      const row: { parentId: string | null } | null = await this.prisma.category.findFirst({
        where: { id: currentId },
        select: { parentId: true },
      });
      currentId = row?.parentId ?? null;
    }

    return false;
  }
}
