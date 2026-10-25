import { Injectable } from '@nestjs/common';
import { Prisma, PriceBookPolicy, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { BranchScope } from '../../../feature-auth/permission/branch-scope';
import { AuthRole } from 'src/common/types/common.enum';

/** Ghi bảng giá gồm nhiều lệnh (bảng + chi nhánh + người bán + dòng giá) nên cần timeout rộng hơn mặc định. */
const PRICE_BOOK_TX_TIMEOUT_MS = 15_000;

const BOOK_INCLUDE = {
  branches: { select: { branchId: true } },
  users: { select: { userId: true } },
  _count: { select: { items: true } },
} satisfies Prisma.PriceBookInclude;

export type PriceBookRow = Prisma.PriceBookGetPayload<{ include: typeof BOOK_INCLUDE }>;

/** Bảng áp dụng được cho POS kèm dòng giá; `productUnit` để đổi sang cặp (hàng, đơn vị) cho FE. */
const APPLICABLE_INCLUDE = {
  ...BOOK_INCLUDE,
  items: { select: { productUnitId: true, price: true, productUnit: { select: { productId: true, unitId: true } } } },
} satisfies Prisma.PriceBookInclude;

export type ApplicableBookRow = Prisma.PriceBookGetPayload<{ include: typeof APPLICABLE_INCLUDE }>;

/** Trường vô hướng của bảng giá (chưa gồm phạm vi chi nhánh / người bán). */
export interface PriceBookScalars {
  name: string;
  startAt: Date;
  endAt: Date;
  status: RecordStatus;
  outOfBookPolicy: PriceBookPolicy;
  formulaBase: string | null;
  formulaOp: string | null;
  formulaAmount: number | null;
  formulaUnit: string | null;
}

export interface PriceBookScopeIds {
  branchIds: string[];
  userIds: string[];
}

/** Điều kiện "bảng áp dụng cho chi nhánh này": không giới hạn chi nhánh, hoặc có chi nhánh đó. */
const branchApplies = (branchId: string): Prisma.PriceBookWhereInput => ({
  OR: [{ branches: { none: {} } }, { branches: { some: { branchId } } }],
});

/** Truy vấn bảng giá. Hàm ghi nhận `db` là transaction để service gom nhiều bước vào một lần commit. */
@Injectable()
export class PriceBookRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { timeout: PRICE_BOOK_TX_TIMEOUT_MS });
  }

  /** Bảng người gọi được xem: toàn chuỗi thấy hết; chi nhánh thấy bảng toàn hệ thống + bảng có chi nhánh mình. */
  listVisible(scope: BranchScope): Promise<PriceBookRow[]> {
    return this.prisma.priceBook.findMany({
      where: scope.kind === 'ALL' ? {} : branchApplies(scope.branchId),
      include: BOOK_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  findById(id: string, db: Prisma.TransactionClient = this.prisma): Promise<PriceBookRow | null> {
    return db.priceBook.findUnique({ where: { id }, include: BOOK_INCLUDE });
  }

  /** Tên trùng không phân biệt hoa thường ("Giá sỉ" và "giá SỈ" là một). */
  findNameConflict(name: string, exceptId: string | null, db: Prisma.TransactionClient = this.prisma) {
    return db.priceBook.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
  }

  create(db: Prisma.TransactionClient, data: PriceBookScalars & PriceBookScopeIds, actorId: string): Promise<PriceBookRow> {
    const { branchIds, userIds, ...scalars } = data;
    return db.priceBook.create({
      data: {
        ...scalars,
        createdBy: actorId,
        branches: { create: branchIds.map((branchId) => ({ branchId })) },
        users: { create: userIds.map((userId) => ({ userId })) },
      },
      include: BOOK_INCLUDE,
    });
  }

  /** Thay toàn bộ phạm vi chi nhánh / người bán bằng danh sách mới (xoá dòng cũ, ghi dòng mới) trong một lệnh. */
  update(
    db: Prisma.TransactionClient,
    id: string,
    data: PriceBookScalars & PriceBookScopeIds,
    actorId: string,
  ): Promise<PriceBookRow> {
    const { branchIds, userIds, ...scalars } = data;
    return db.priceBook.update({
      where: { id },
      data: {
        ...scalars,
        updatedAt: new Date(),
        updatedBy: actorId,
        branches: { deleteMany: {}, create: branchIds.map((branchId) => ({ branchId })) },
        users: { deleteMany: {}, create: userIds.map((userId) => ({ userId })) },
      },
      include: BOOK_INCLUDE,
    });
  }

  /** Xoá cứng — dòng giá, chi nhánh, người bán xoá theo (cascade); đơn cũ về `priceBookId = null`. */
  async delete(db: Prisma.TransactionClient, id: string): Promise<void> {
    await db.priceBook.delete({ where: { id } });
  }

  /** Các bảng lấy bảng `id` làm giá gốc công thức. */
  findDependents(db: Prisma.TransactionClient, id: string): Promise<PriceBookRow[]> {
    return db.priceBook.findMany({ where: { formulaBase: id }, include: BOOK_INCLUDE });
  }

  /** Gỡ công thức của các bảng (giá gốc đã bị xoá). Giữ nguyên dòng giá đã tính. */
  async clearFormula(db: Prisma.TransactionClient, ids: string[], actorId: string): Promise<void> {
    if (!ids.length) return;
    await db.priceBook.updateMany({
      where: { id: { in: ids } },
      data: { formulaBase: null, formulaOp: null, formulaAmount: null, formulaUnit: null, updatedAt: new Date(), updatedBy: actorId },
    });
  }

  async countBranches(ids: string[], db: Prisma.TransactionClient = this.prisma): Promise<number> {
    if (!ids.length) return 0;
    return db.branch.count({ where: { id: { in: ids }, isDeleted: false } });
  }

  async findUsers(
    ids: string[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<{ id: string; branchId: string | null }[]> {
    if (!ids.length) return [];
    return db.user.findMany({ where: { id: { in: ids }, isDeleted: false }, select: { id: true, branchId: true } });
  }

  /** Người bán chọn được: nhân viên đang hoạt động (không phải khách); quản lý chi nhánh chỉ thấy người cùng chi nhánh. */
  findSellers(scope: BranchScope) {
    return this.prisma.user.findMany({
      where: {
        isDeleted: false,
        status: 'ACTIVE',
        role: { code: { not: AuthRole.CUSTOMER } },
        ...(scope.kind === 'BRANCH' ? { branchId: scope.branchId } : {}),
      },
      select: { id: true, fullName: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
  }

  /** Bảng ACTIVE, còn hiệu lực lúc `at`, áp dụng cho (chi nhánh, người bán), kèm dòng giá. */
  findApplicable(branchId: string, userId: string, at: Date): Promise<ApplicableBookRow[]> {
    return this.prisma.priceBook.findMany({
      where: {
        status: RecordStatus.ACTIVE,
        startAt: { lte: at },
        endAt: { gte: at },
        AND: [branchApplies(branchId), { OR: [{ users: { none: {} } }, { users: { some: { userId } } }] }],
      },
      include: APPLICABLE_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Một bảng kèm dòng giá, không lọc hiệu lực — `getUsableBook` tự kiểm để báo đúng lý do. */
  findWithItems(id: string) {
    return this.prisma.priceBook.findUnique({
      where: { id },
      include: { ...BOOK_INCLUDE, items: { select: { productUnitId: true, price: true } } },
    });
  }
}
