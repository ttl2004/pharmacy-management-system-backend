import { PrismaClient, ProductType } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { AdjustmentService } from './adjustment.service';
import { AdjustmentRepository } from './repositories/adjustment.repository';

/** Tổng SL / giá trị ở danh sách phiếu điều chỉnh khớp đúng số cộng từ chi tiết, trên schema `audit_db_test`. */
describe('danh sách phiếu điều chỉnh — totalQuantity / totalValue (db)', () => {
  let prisma: PrismaClient;
  let repository: AdjustmentRepository;
  let service: AdjustmentService;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    repository = new AdjustmentRepository(prisma as never);
    const none = {} as never;
    const permissions = { getGrantedCodes: () => Promise.resolve(new Set(['goods-receipt:create'])) };
    service = new AdjustmentService(repository, none, none, none, none, none, none, permissions as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
  });

  it('huỷ + trả NCC + phiếu rỗng: tổng khớp chi tiết, dòng xoá mềm bị loại', async () => {
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    const user = await prisma.user.create({ data: { fullName: 'Người lập', roleId: role.id } });
    const branch = await prisma.branch.create({
      data: { code: 'CN01', name: 'Chi nhánh 1', phone: '0900000001', address: 'Hà Nội' },
    });
    const supplier = await prisma.supplier.create({ data: { code: 'NCC01', name: 'NCC', phone: '0900000002' } });
    const unit = await prisma.unit.create({ data: { code: 'VIEN', name: 'Viên' } });
    const category = await prisma.category.create({ data: { name: 'Thuốc' } });
    const product = await prisma.product.create({
      data: { code: 'SP01', name: 'Khẩu trang', type: ProductType.GOODS, categoryId: category.id, baseUnitId: unit.id },
    });
    const expiryDate = new Date('2030-01-01');
    const batches: { id: string }[] = [];
    for (const n of ['L1', 'L2', 'L3']) {
      batches.push(
        await prisma.stockBatch.create({
          data: { branchId: branch.id, productId: product.id, batchNumber: n, expiryDate, importPrice: 700 },
        }),
      );
    }
    const base = { branchId: branch.id, reason: 'x', createdBy: user.id };
    const dispose = await prisma.stockAdjustment.create({ data: { ...base, code: 'XH1', type: 'DISPOSE' } });
    const ret = await prisma.stockAdjustment.create({
      data: {
        ...base,
        code: 'TH1',
        type: 'RETURN_TO_SUPPLIER',
        supplierId: supplier.id,
        goodsAmount: 5000n,
        discountAmount: 500n,
        totalAmount: 4500n,
      },
    });
    await prisma.stockAdjustment.create({ data: { ...base, code: 'XH2', type: 'DISPOSE' } });
    const item = (adjustmentId: string, i: number, quantity: number, unitCost: number, isDeleted = false) => ({
      adjustmentId,
      batchId: batches[i].id,
      productId: product.id,
      quantity,
      unitCost,
      isDeleted,
    });
    await prisma.stockAdjustmentItem.createMany({
      data: [
        item(dispose.id, 0, -3, 700),
        item(dispose.id, 1, -2, 1_000_000_000),
        item(dispose.id, 2, -50, 999, true),
        { ...item(ret.id, 0, -4, 700), returnPrice: 900 },
        { ...item(ret.id, 1, -1, 700), returnPrice: 900 },
      ],
    });

    const page = await service.list(
      { page: 1, limit: 10 } as never,
      {
        user: { userId: user.id, role: AuthRole.ADMIN, branchId: null, email: null, sid: 's', roleLevel: 90 },
        ip: null,
        userAgent: null,
        requestId: null,
      } as unknown as RequestActor,
    );
    const byCode = new Map(page.hits.map((h) => [h.code, h]));

    // Huỷ: 3 + 2 = 5; 3×700 + 2×1.000.000.000 = 2.000.002.100 (vượt Int32 vẫn đúng).
    expect(byCode.get('XH1')).toMatchObject({ totalQuantity: 5, totalValue: 2_000_002_100 });
    // Trả NCC: SL 4 + 1; giá trị = tổng tiền phiếu như chi tiết.
    expect(byCode.get('TH1')).toMatchObject({ totalQuantity: 5, totalValue: 4500 });
    expect(byCode.get('XH2')).toMatchObject({ totalQuantity: 0, totalValue: 0 });

    // Khớp chi tiết: cộng lại từ các dòng chi tiết.
    for (const adj of [dispose, ret]) {
      const detail = await repository.findDetail(adj.id, {});
      const qty = detail!.items.reduce((s, it) => s + Math.abs(it.quantity), 0);
      expect(byCode.get(adj.code)!.totalQuantity).toBe(qty);
    }
    const disposeDetail = await repository.findDetail(dispose.id, {});
    const value = disposeDetail!.items.reduce((s, it) => s + Math.abs(it.quantity) * it.unitCost, 0);
    expect(byCode.get('XH1')!.totalValue).toBe(value);
  });
});
