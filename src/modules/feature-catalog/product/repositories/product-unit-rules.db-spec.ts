import { PrismaClient, ProductType } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorCode } from 'src/common/types/error-code';
import { AuthRole } from 'src/common/types/common.enum';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { CatalogTransactions } from '../../catalog-transactions';
import { ProductService } from '../product.service';
import { ProductRepository } from './product.repository';

const ACTOR: RequestActor = {
  user: {
    userId: '3f6c1a52-6b1e-4c1a-9a3e-2d5b8f0e7a11',
    sid: 's',
    email: null,
    role: AuthRole.ADMIN,
    branchId: null,
    roleLevel: 80,
  },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

/** Đổi quy cách đơn vị (D4) và CHECK đơn vị bán (D11) — trên PostgreSQL thật. */
describe('ProductService — quy cách đơn vị bán (db)', () => {
  let prisma: PrismaClient;
  let service: ProductService;
  let productId: string;
  let categoryId: string;
  let vienId: string;
  let hopId: string;
  let hopRowId: string;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    service = new ProductService(
      new ProductRepository(prisma as unknown as PrismaService),
      new CatalogTransactions(prisma as unknown as PrismaService),
      new AuditLogService(),
      {} as never, // RegistrationDuplicateChecker — luồng tạo/khôi phục không dùng
      {} as never, // ManualDrugWriter — luồng tạo/khôi phục không dùng
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    await prisma.user.create({ data: { id: ACTOR.user.userId, fullName: 'Admin', roleId: role.id } });
    categoryId = (await prisma.category.create({ data: { name: 'Thuốc' } })).id;
    vienId = (await prisma.unit.create({ data: { code: 'VIEN', name: 'Viên' } })).id;
    hopId = (await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } })).id;
    productId = (
      await prisma.product.create({
        data: { code: 'SP01', name: 'Panadol', categoryId, baseUnitId: vienId, type: ProductType.GOODS },
      })
    ).id;
    await prisma.productUnit.create({
      data: { productId, unitId: vienId, conversionRate: 1, salePrice: 500, isBaseUnit: true },
    });
    hopRowId = (
      await prisma.productUnit.create({ data: { productId, unitId: hopId, conversionRate: 10, salePrice: 4500 } })
    ).id;
  });

  const units = (hopRate: number, hopPrice = 4500, barcode?: string) => ({
    units: [
      { unitId: vienId, conversionRate: 1, salePrice: 500, isBaseUnit: true },
      { unitId: hopId, conversionRate: hopRate, salePrice: hopPrice, isBaseUnit: false, barcode },
    ],
  });

  it('chưa có kho / bảng giá / bán: đổi quy cách được, nhật ký có diff đơn vị', async () => {
    const result = await service.update(productId, units(20, 4500, 'BC-HOP'), ACTOR);

    expect(result.units.find((u) => u.unit.id === hopId)).toMatchObject({ conversionRate: 20, barcode: 'BC-HOP' });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: productId, event: 'PRODUCT.UPDATED' } });
    expect(log.before).toEqual({ units: [{ unitId: hopId, conversionRate: 10, barcode: null }] });
    expect(log.after).toEqual({ units: [{ unitId: hopId, conversionRate: 20, barcode: 'BC-HOP' }] });
  });

  it('đã có lô tồn: đổi quy cách bị chặn, đổi giá/mã vạch và thêm đơn vị mới vẫn được', async () => {
    const branch = await prisma.branch.create({
      data: { code: 'CN01', name: 'CN 1', phone: '0900000001', address: 'HN' },
    });
    await prisma.stockBatch.create({
      data: {
        branchId: branch.id,
        productId,
        batchNumber: 'L1',
        expiryDate: new Date('2030-01-01'),
        quantityOnHand: 100,
        importPrice: 300,
      },
    });

    await expect(service.update(productId, units(20), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.PRODUCT_HAS_STOCK,
    });
    expect((await prisma.productUnit.findUniqueOrThrow({ where: { id: hopRowId } })).conversionRate).toBe(10);

    await expect(service.update(productId, units(10, 5000, 'BC-NEW'), ACTOR)).resolves.toBeDefined();
    const thungId = (await prisma.unit.create({ data: { code: 'THUNG', name: 'Thùng' } })).id;
    await expect(
      service.update(
        productId,
        { units: [...units(10).units, { unitId: thungId, conversionRate: 100, salePrice: 40000 }] },
        ACTOR,
      ),
    ).resolves.toBeDefined();
  });

  it('đơn vị nằm trong bảng giá: đổi quy cách bị chặn', async () => {
    const book = await prisma.priceBook.create({
      data: { name: 'Giá sỉ', startAt: new Date('2026-01-01'), endAt: new Date('2036-01-01') },
    });
    await prisma.priceBookItem.create({ data: { priceBookId: book.id, productUnitId: hopRowId, price: 90000 } });

    await expect(service.update(productId, units(20), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
  });

  it('CHECK: conversionRate 0, giá âm, đơn vị cơ bản khác 1 đều bị DB từ chối', async () => {
    const other = await prisma.unit.create({ data: { code: 'VI', name: 'Vỉ' } });
    const insert = (data: { conversionRate: number; salePrice: number; isBaseUnit?: boolean }) =>
      prisma.productUnit.create({ data: { productId, unitId: other.id, ...data } });

    await expect(insert({ conversionRate: 0, salePrice: 1 })).rejects.toThrow();
    await expect(insert({ conversionRate: 5, salePrice: -1 })).rejects.toThrow();
    await expect(insert({ conversionRate: 5, salePrice: 1, isBaseUnit: true })).rejects.toThrow();
    await expect(insert({ conversionRate: 5, salePrice: 0 })).resolves.toBeDefined();
  });
});
