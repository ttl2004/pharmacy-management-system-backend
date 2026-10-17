import { Injectable } from '@nestjs/common';
import { OrderChannel, OrderStatus, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import type { SellableUnit } from '../../core/order-lines';

const BRANCH_BRIEF = { select: { id: true, code: true, name: true } } as const;
const USER_BRIEF = { select: { id: true, fullName: true } } as const;

const ORDER_LIST_SELECT = {
  id: true,
  code: true,
  channel: true,
  status: true,
  paymentStatus: true,
  totalAmount: true,
  createdAt: true,
  completedAt: true,
  cancelledAt: true,
  branch: BRANCH_BRIEF,
  customer: { select: { id: true, fullName: true, phoneNumber: true } },
  staff: USER_BRIEF,
  _count: { select: { items: { where: { isDeleted: false } } } },
} satisfies Prisma.OrderSelect;

const ORDER_DETAIL_SELECT = {
  ...ORDER_LIST_SELECT,
  branchId: true,
  subtotalAmount: true,
  shippingFee: true,
  prescriptionCode: true,
  prescriberName: true,
  prescriptionImageUrl: true,
  note: true,
  cancelReason: true,
  confirmedAt: true,
  updatedAt: true,
  items: {
    where: { isDeleted: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      productId: true,
      productUnitId: true,
      productName: true,
      unitName: true,
      conversionRate: true,
      quantity: true,
      baseQuantity: true,
      unitPrice: true,
      totalPrice: true,
      batches: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          quantity: true,
          unitCost: true,
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
        },
      },
    },
  },
  payments: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      method: true,
      amount: true,
      status: true,
      transactionCode: true,
      paidAt: true,
      createdAt: true,
    },
  },
} satisfies Prisma.OrderSelect;

export type OrderDetail = Prisma.OrderGetPayload<{ select: typeof ORDER_DETAIL_SELECT }>;

/** Kết quả tìm-hoặc-tạo hồ sơ người mua tại quầy. */
export interface WalkInCustomer {
  id: string;
  /** false = SĐT thuộc tài khoản nhân viên. */
  isCustomer: boolean;
  isDeleted: boolean;
  status: UserStatus;
  /** true = hồ sơ vừa được tạo trong câu lệnh này. */
  created: boolean;
}

/** Phần đầu đơn đủ để kiểm phạm vi, trạng thái và thu tiền — kèm số dòng có thuốc kê đơn. */
export interface OrderHead {
  id: string;
  code: string;
  branchId: string;
  channel: OrderChannel;
  status: OrderStatus;
  totalAmount: bigint;
  prescriptionCode: string | null;
  prescriberName: string | null;
  updatedAt: Date | null;
  lineCount: number;
  prescriptionLineCount: number;
}

@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(where: Prisma.OrderWhereInput, page: number, limit: number) {
    const fullWhere = { AND: [where, { isDeleted: false }] };
    const [hits, total] = await Promise.all([
      this.prisma.order.findMany({
        where: fullWhere,
        select: ORDER_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.order.count({ where: fullWhere }),
    ]);
    return { hits, total, page, totalPages: Math.ceil(total / limit), limit };
  }

  findDetail(id: string, scopeWhere: Prisma.OrderWhereInput, client: Prisma.TransactionClient = this.prisma) {
    return client.order.findFirst({
      where: { AND: [{ id, isDeleted: false }, scopeWhere] },
      select: ORDER_DETAIL_SELECT,
    });
  }

  async findHead(
    tx: Prisma.TransactionClient,
    id: string,
    scopeWhere: Prisma.OrderWhereInput,
  ): Promise<OrderHead | null> {
    const row = await tx.order.findFirst({
      where: { AND: [{ id, isDeleted: false }, scopeWhere] },
      select: {
        id: true,
        code: true,
        branchId: true,
        channel: true,
        status: true,
        totalAmount: true,
        prescriptionCode: true,
        prescriberName: true,
        updatedAt: true,
        _count: { select: { items: { where: { isDeleted: false } } } },
      },
    });
    if (!row) return null;
    const prescriptionLineCount = await tx.orderItem.count({
      where: { orderId: id, isDeleted: false, product: { requiresPrescription: true } },
    });
    const { _count, ...head } = row;
    return { ...head, lineCount: _count.items, prescriptionLineCount };
  }

  findBranch(tx: Prisma.TransactionClient, id: string) {
    return tx.branch.findFirst({ where: { id, isDeleted: false }, select: { id: true, status: true } });
  }

  /**
   * Hồ sơ người mua theo SĐT — chưa có thì tạo (vai trò CUSTOMER, KHÔNG có dòng `auths` nên chưa đăng nhập được). MỘT câu
   * `INSERT … ON CONFLICT`: hai quầy cùng nhập một SĐT mới cũng chỉ ra một hồ sơ. SĐT đã có thì trả nguyên bản ghi cũ (không
   * đổi tên) để service tự quyết có dùng được không. `xmax = 0` chỉ đúng với dòng vừa INSERT — dùng để biết có tạo mới.
   * `id` sinh ở DB vì `@default(uuid())` của Prisma không áp cho SQL thô.
   */
  async upsertWalkInCustomer(
    tx: Prisma.TransactionClient,
    input: { phoneNumber: string; fullName: string; actorId: string },
  ): Promise<WalkInCustomer> {
    const [row] = await tx.$queryRaw<WalkInCustomer[]>(Prisma.sql`
      WITH upserted AS (
        INSERT INTO "users" ("id", "phoneNumber", "fullName", "roleId", "createdBy")
        SELECT gen_random_uuid(), ${input.phoneNumber}, ${input.fullName}, r."id", ${input.actorId}::uuid
        FROM "roles" r
        WHERE r."code" = ${AuthRole.CUSTOMER}
        ON CONFLICT ("phoneNumber") DO UPDATE SET "phoneNumber" = EXCLUDED."phoneNumber"
        RETURNING "id", "roleId", "isDeleted", "status", (xmax = 0) AS "created"
      )
      SELECT u."id", (r."code" = ${AuthRole.CUSTOMER}) AS "isCustomer", u."isDeleted", u."status"::text AS "status",
             u."created"
      FROM upserted u
      JOIN "roles" r ON r."id" = u."roleId"`);
    if (!row) throw new Error('Chưa seed vai trò CUSTOMER — chạy npm run seed:permissions');
    return row;
  }

  /** Đơn vị bán kèm sản phẩm — một câu lệnh cho cả đơn. Bản ghi đã xoá coi như không tồn tại (→ 1801). */
  findSellableUnits(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<SellableUnit[]> {
    return tx.productUnit.findMany({
      where: { id: { in: [...ids] }, isDeleted: false, product: { isDeleted: false } },
      select: {
        id: true,
        conversionRate: true,
        salePrice: true,
        status: true,
        unit: { select: { name: true } },
        product: { select: { id: true, name: true, status: true, requiresPrescription: true } },
      },
    });
  }

  createHeader(tx: Prisma.TransactionClient, data: Prisma.OrderUncheckedCreateInput) {
    return tx.order.create({ data, select: { id: true } });
  }

  createItems(tx: Prisma.TransactionClient, rows: Prisma.OrderItemCreateManyInput[]) {
    return tx.orderItem.createMany({ data: rows });
  }

  /** Xoá cứng dòng của đơn PENDING (phân bổ phải xoá trước) — chưa có chứng từ nào trỏ tới. */
  deleteItems(tx: Prisma.TransactionClient, orderId: string) {
    return tx.orderItem.deleteMany({ where: { orderId } });
  }

  /**
   * Chiếm đơn: cập nhật có điều kiện, khoá dòng `orders` tới hết transaction — mọi thao tác ghi khác trên cùng đơn phải xếp
   * hàng sau. 0 nghĩa là đơn vừa đổi trạng thái/bị sửa bởi request khác.
   */
  async claim(
    tx: Prisma.TransactionClient,
    id: string,
    condition: Prisma.OrderWhereInput,
    data: Prisma.OrderUncheckedUpdateManyInput,
  ): Promise<number> {
    const result = await tx.order.updateMany({ where: { AND: [{ id, isDeleted: false }, condition] }, data });
    return result.count;
  }

  createPayment(tx: Prisma.TransactionClient, data: Prisma.PaymentUncheckedCreateInput) {
    return tx.payment.create({ data, select: { id: true } });
  }

  /** Đơn tại quầy PENDING không ai đụng tới từ trước `cutoff`. */
  findAbandonedPos(cutoff: Date, take: number) {
    return this.prisma.order.findMany({
      where: {
        isDeleted: false,
        channel: OrderChannel.POS,
        status: OrderStatus.PENDING,
        OR: [{ updatedAt: { lt: cutoff } }, { updatedAt: null, createdAt: { lt: cutoff } }],
      },
      select: { id: true, branchId: true, status: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }
}
