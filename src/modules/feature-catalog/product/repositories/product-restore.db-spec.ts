import { readFileSync } from 'fs';
import { join } from 'path';
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

/** Xoá nhả mã vạch, khôi phục trả sản phẩm lại — trên PostgreSQL thật (unique + updatedAt khớp mốc xoá). */
describe('ProductService — xoá nhả mã vạch, khôi phục (db)', () => {
  let prisma: PrismaClient;
  let service: ProductService;
  let productId: string;
  let categoryId: string;
  let boxUnitId: string;
  let packUnitId: string;

  beforeAll(async () => {
    prisma = await createTestPrisma();
    const repo = new ProductRepository(prisma as unknown as PrismaService);
    service = new ProductService(
      repo,
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
    // Audit có khoá ngoại tới users.
    const role = await prisma.role.create({ data: { code: 'ADMIN', name: 'Quản trị', level: 90 } });
    await prisma.user.create({ data: { id: ACTOR.user.userId, fullName: 'Admin', roleId: role.id } });
    categoryId = (await prisma.category.create({ data: { name: 'Thuốc' } })).id;
    boxUnitId = (await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } })).id;
    packUnitId = (await prisma.unit.create({ data: { code: 'VI', name: 'Vỉ' } })).id;
    const product = await prisma.product.create({
      data: {
        code: 'SP01',
        name: 'Panadol',
        barcode: 'BC-P',
        categoryId,
        baseUnitId: boxUnitId,
        type: ProductType.GOODS,
      },
    });
    productId = product.id;
    await prisma.productUnit.createMany({
      data: [
        { productId, unitId: boxUnitId, conversionRate: 1, salePrice: 1000, barcode: 'BC-U1', isBaseUnit: true },
        { productId, unitId: packUnitId, conversionRate: 10, salePrice: 9000, barcode: 'BC-U2' },
      ],
    });
  });

  const newProduct = (code: string, barcode: string) =>
    prisma.product.create({
      data: { code, name: 'Mới', barcode, categoryId, baseUnitId: boxUnitId, type: ProductType.GOODS },
    });

  it('xoá nhả mã vạch sản phẩm và đơn vị: tạo sản phẩm mới cùng mã vạch được', async () => {
    await service.remove(productId, ACTOR);

    const deleted = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.barcode).toBeNull();
    expect(deleted.code).toBe('SP01');
    const units = await prisma.productUnit.findMany({ where: { productId } });
    expect(units.every((u) => u.isDeleted && u.barcode === null)).toBe(true);

    await expect(newProduct('SP02', 'BC-P')).resolves.toMatchObject({ barcode: 'BC-P' });
    // Nhật ký xoá vẫn giữ mã vạch gốc.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: productId } });
    expect(JSON.stringify(log.before)).toContain('BC-P');
  });

  it('khôi phục: sản phẩm hiện lại với mã cũ, mã vạch rỗng, chỉ đơn vị xoá cùng lúc được hồi sinh', async () => {
    // Đơn vị Vỉ bị loại từ trước (qua sửa) — không được hồi sinh khi khôi phục.
    await prisma.productUnit.updateMany({
      where: { productId, unitId: packUnitId },
      data: { isDeleted: true, barcode: null, updatedAt: new Date('2020-01-01T00:00:00Z') },
    });

    await service.remove(productId, ACTOR);
    const restored = await service.restore(productId, ACTOR);

    expect(restored.code).toBe('SP01');
    expect(restored.barcode).toBeNull();
    expect(restored.units.map((u) => u.unit.id)).toEqual([boxUnitId]);
    expect((await service.list({ page: 1, limit: 10 })).hits.map((h) => h.code)).toEqual(['SP01']);
  });

  it('khôi phục sản phẩm chưa xoá báo RECORD_NOT_FOUND; danh sách deleted chỉ thấy hàng đã xoá', async () => {
    await expect(service.restore(productId, ACTOR)).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
    await service.remove(productId, ACTOR);
    expect((await service.list({ page: 1, limit: 10 }, true)).hits.map((h) => h.code)).toEqual(['SP01']);
    expect((await service.list({ page: 1, limit: 10 })).hits).toHaveLength(0);
  });

  it('dữ liệu xoá kiểu cũ (dòng đơn vị lệch vài ms so với Product) vẫn khôi phục được', async () => {
    await service.remove(productId, ACTOR);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    await prisma.productUnit.updateMany({
      where: { productId },
      data: { updatedAt: new Date(product.updatedAt!.getTime() - 3) },
    });

    const restored = await service.restore(productId, ACTOR);
    expect(restored.units.map((u) => u.unit.id).sort()).toEqual([boxUnitId, packUnitId].sort());
  });

  it('mốc Product bị đẩy xa (không còn nhận ra dòng đơn vị) → 1701 và không đổi gì', async () => {
    await service.remove(productId, ACTOR);
    await prisma.product.update({ where: { id: productId }, data: { updatedAt: new Date(Date.now() + 86_400_000) } });

    await expect(service.restore(productId, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_DOCUMENT_STATE,
    });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).isDeleted).toBe(true);
    expect(await prisma.productUnit.count({ where: { productId, isDeleted: false } })).toBe(0);
  });

  it('khôi phục bị chặn khi đã có sản phẩm khác cùng thuốc và cùng quy cách', async () => {
    const drug = await prisma.drug.create({ data: { code: 'D1', name: 'Hapacol', syncedAt: new Date() } });
    await prisma.product.update({ where: { id: productId }, data: { drugId: drug.id, type: ProductType.DRUG } });
    await service.remove(productId, ACTOR);
    const twin = await prisma.product.create({
      data: {
        code: 'SP09',
        name: 'Cùng thuốc',
        categoryId,
        baseUnitId: boxUnitId,
        type: ProductType.DRUG,
        drugId: drug.id,
      },
    });
    await prisma.productUnit.create({
      data: { productId: twin.id, unitId: boxUnitId, conversionRate: 1, salePrice: 1000, isBaseUnit: true },
    });
    await prisma.productUnit.create({
      data: { productId: twin.id, unitId: packUnitId, conversionRate: 10, salePrice: 9000 },
    });

    await expect(service.restore(productId, ACTOR)).rejects.toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).isDeleted).toBe(true);
  });

  it('migration dữ liệu: nhả mã vạch của hàng/đơn vị đã xoá mềm từ trước', async () => {
    await prisma.product.update({ where: { id: productId }, data: { isDeleted: true } });
    await prisma.productUnit.updateMany({ where: { productId }, data: { isDeleted: true } });
    const sql = readFileSync(
      join(__dirname, '../../../../../prisma/migrations/20261119090000_nha_gia_tri_duy_nhat_khi_xoa/migration.sql'),
      'utf8',
    );
    for (const statement of sql.split(';').filter((part) => part.replace(/--.*$/gm, '').trim())) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).barcode).toBeNull();
    expect((await prisma.productUnit.findMany({ where: { productId } })).every((u) => u.barcode === null)).toBe(true);
    await expect(newProduct('SP02', 'BC-P')).resolves.toBeDefined();
  });
});
