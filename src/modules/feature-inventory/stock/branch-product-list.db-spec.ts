import { BatchStatus, Branch, Product, ProductType, PrismaClient, ReceiptStatus, Supplier } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { toProductListFilter } from 'src/common/dtos/product-list-filter.query';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { addDaysToDateOnly, parseDateOnly, todayInVietnam } from 'src/common/utils/date-only.util';
import { PriceBookRowsRepository } from 'src/modules/feature-catalog/price-book/repositories/price-book-rows.repository';
import { ProductRepository } from 'src/modules/feature-catalog/product/repositories/product.repository';
import { createTestPrisma, resetSchema } from 'src/test-support/db-test';
import { BranchProductListService } from './branch-product-list.service';
import { BranchProductListQuery } from './dtos/branch-product-list.query';
import { BranchProductListRepository } from './repositories/branch-product-list.repository';

/**
 * Hàng hoá chi nhánh trên PostgreSQL thật: chỉ hàng đã có lô, lô tồn 0 vẫn hiện, giá vốn / giá nhập cuối khớp Thiết lập
 * giá, toàn chuỗi gộp đúng + `branches`, phạm vi PM, ẩn giá; kèm Danh mục hàng hoá (`findCatalogPage`).
 */
describe('Hàng hoá chi nhánh + Danh mục hàng hoá (db)', () => {
  let prisma: PrismaClient;
  let service: BranchProductListService;
  let costVisible = true;
  const today = todayInVietnam();

  let cn1: Branch, cn2: Branch, cn3: Branch;
  let s1: Supplier, s2: Supplier;
  let para: Product, vitc: Product, mask: Product, cotton: Product, ghost: Product;
  let childCategoryId: string, parentCategoryId: string, locationId: string;

  const actor = (role: AuthRole, branchId: string | null = null): RequestActor => ({
    user: { userId: 'u', sid: 's', email: null, role, branchId, roleLevel: 80 },
    ip: null,
    userAgent: null,
    requestId: null,
  });
  const ADMIN = actor(AuthRole.ADMIN);
  const query = (q: Partial<BranchProductListQuery> = {}) =>
    Object.assign(new BranchProductListQuery(), { page: 1, limit: 50, ...q });

  beforeAll(async () => {
    prisma = await createTestPrisma();
    await resetSchema(prisma);
    const permissions = {
      getGrantedCodes: () => Promise.resolve(new Set(costVisible ? ['goods-receipt:create'] : ['stock:read'])),
    };
    service = new BranchProductListService(
      new BranchProductListRepository(prisma as unknown as PrismaService),
      permissions as never,
    );
    await seed();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(() => {
    costVisible = true;
  });

  async function seed() {
    const vien = await prisma.unit.create({ data: { code: 'VIEN', name: 'Viên' } });
    const hop = await prisma.unit.create({ data: { code: 'HOP', name: 'Hộp' } });
    const parent = await prisma.category.create({ data: { name: 'Thuốc' } });
    const child = await prisma.category.create({ data: { name: 'Giảm đau', parentId: parent.id } });
    const other = await prisma.category.create({ data: { name: 'Vật tư' } });
    parentCategoryId = parent.id;
    childCategoryId = child.id;
    locationId = (await prisma.shelfLocation.create({ data: { name: 'Kệ A1' } })).id;
    [cn1, cn2, cn3] = await Promise.all(
      [1, 2, 3].map((i) =>
        prisma.branch.create({ data: { code: `CN0${i}`, name: `Chi nhánh ${i}`, phone: '0900000000', address: 'HN' } }),
      ),
    );
    [s1, s2] = await Promise.all(
      [1, 2].map((i) => prisma.supplier.create({ data: { code: `NCC0${i}`, name: `NCC ${i}`, phone: '0911111111' } })),
    );
    const drug = await prisma.drug.create({
      data: {
        code: 'VD-1',
        name: 'Paracetamol',
        ingredients: 'Paracetamol',
        strength: '500mg',
        registrationNumber: 'VD-12345-20',
        syncedAt: new Date(),
      },
    });
    // `createdAt` tăng dần tường minh: thứ tự mặc định là "tạo trước đứng trước", không để trùng mili-giây.
    const base = Date.now();
    let order = 0;
    const product = async (code: string, name: string, extra: Partial<Product> = {}) => {
      order += 1;
      const p = await prisma.product.create({
        data: {
          createdAt: new Date(base + order * 10),
          code,
          name,
          type: ProductType.GOODS,
          categoryId: other.id,
          baseUnitId: vien.id,
          ...(extra as object),
        },
      });
      await prisma.productUnit.create({
        data: { productId: p.id, unitId: vien.id, conversionRate: 1, salePrice: 1000 + code.length, isBaseUnit: true },
      });
      return p;
    };
    para = await product('TH0001', 'Paracetamol 500mg', {
      type: ProductType.DRUG,
      drugId: drug.id,
      categoryId: child.id,
      minStockLevel: 200,
      maxStockLevel: 1000,
    });
    await prisma.productUnit.create({
      data: { productId: para.id, unitId: hop.id, conversionRate: 10, salePrice: 9000, barcode: '8930000000999' },
    });
    vitc = await product('HH0001', 'Vitamin C');
    mask = await product('HH0002', 'Khẩu trang');
    cotton = await product('HH0003', 'Bông y tế', { maxStockLevel: 10 });
    ghost = await product('HH0004', 'Hàng lô đã xoá');
    await prisma.productLocation.create({ data: { productId: para.id, locationId } });
    await prisma.branchProduct.create({ data: { branchId: cn2.id, productId: para.id, minStockLevel: 10 } });

    const batch = (
      branch: Branch,
      p: Product,
      batchNumber: string,
      qty: number,
      price: number,
      extra: Record<string, unknown> = {},
    ) =>
      prisma.stockBatch.create({
        data: {
          branchId: branch.id,
          productId: p.id,
          batchNumber,
          quantityOnHand: qty,
          importPrice: price,
          expiryDate: new Date('2030-01-01T00:00:00Z'),
          ...extra,
        },
      });
    await batch(cn1, para, 'P-01', 100, 500, { expiryDate: new Date('2029-06-30T00:00:00Z') });
    await batch(cn1, para, 'P-02', 50, 800);
    await batch(cn2, para, 'P-03', 30, 700);
    await batch(cn1, vitc, 'V-01', 0, 300);
    await batch(cn2, cotton, 'B-01', 20, 400, { status: BatchStatus.QUARANTINE, blockedReason: 'Kiểm tra' });
    await batch(cn1, ghost, 'G-01', 5, 100, { isDeleted: true });
    // Hàng đã xoá mềm (còn lô) — không bao giờ hiện ở Hàng hoá chi nhánh / Danh mục (deleted=false).
    const gone = await product('HH0009', 'Hàng đã xoá', { isDeleted: true });
    await batch(cn1, gone, 'X-01', 7, 100);
    await batch(cn2, gone, 'X-02', 7, 100);

    let seq = 0;
    const receipt = async (
      branch: Branch,
      supplier: Supplier,
      status: ReceiptStatus,
      confirmedAt: Date,
      line: { product: Product; unitId: string; rate: number; price: number; discount: number },
    ) => {
      seq += 1;
      const r = await prisma.goodsReceipt.create({
        data: {
          code: `PN${String(seq).padStart(6, '0')}`,
          branchId: branch.id,
          supplierId: supplier.id,
          status,
          confirmedAt: status === ReceiptStatus.CONFIRMED ? confirmedAt : null,
          createdAt: confirmedAt,
        },
      });
      const pu = await prisma.productUnit.findFirstOrThrow({
        where: { productId: line.product.id, unitId: line.unitId },
      });
      await prisma.goodsReceiptItem.create({
        data: {
          receiptId: r.id,
          productId: line.product.id,
          productUnitId: pu.id,
          quantity: 1,
          conversionRate: line.rate,
          baseQuantity: line.rate,
          importPrice: line.price,
          unitDiscount: line.discount,
          totalPrice: BigInt(line.price - line.discount),
          batchNumber: 'X',
          expiryDate: new Date('2030-01-01T00:00:00Z'),
        },
      });
    };
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    // CN01: phiếu cũ (NCC 2) rồi phiếu mới (NCC 1, theo hộp 10 viên, giảm 1.000/hộp) → giá nhập cuối = 1.100/viên.
    await receipt(cn1, s2, ReceiptStatus.CONFIRMED, daysAgo(10), {
      product: para,
      unitId: vien.id,
      rate: 1,
      price: 900,
      discount: 0,
    });
    await receipt(cn1, s1, ReceiptStatus.CONFIRMED, daysAgo(3), {
      product: para,
      unitId: hop.id,
      rate: 10,
      price: 12000,
      discount: 1000,
    });
    // Phiếu nháp mới hơn không được tính.
    await receipt(cn1, s1, ReceiptStatus.DRAFT, daysAgo(1), {
      product: para,
      unitId: vien.id,
      rate: 1,
      price: 9999,
      discount: 0,
    });
    // CN02: phiếu mới nhất cả chuỗi → giá nhập cuối toàn chuỗi = 700.
    await receipt(cn2, s2, ReceiptStatus.CONFIRMED, daysAgo(2), {
      product: para,
      unitId: vien.id,
      rate: 1,
      price: 700,
      discount: 0,
    });

    // Bán 30 ngày: CN01 60 viên trong kỳ (+30 viên ngoài kỳ không tính), CN02 10 viên.
    const sale = (branch: Branch, p: Product, daysBack: number, qtyBase: number) =>
      prisma.salesDailyProduct.create({
        data: {
          branchId: branch.id,
          productId: p.id,
          date: parseDateOnly(addDaysToDateOnly(today, -daysBack)),
          channel: 'POS',
          qtyBase,
        },
      });
    await sale(cn1, para, 5, 40);
    await sale(cn1, para, 29, 20);
    await sale(cn1, para, 30, 30);
    await sale(cn2, para, 1, 10);
  }

  const codes = (hits: { code: string }[]) => hits.map((h) => h.code);

  it('chi nhánh: chỉ hàng có lô (kể cả tồn 0), bỏ lô đã xoá, số liệu đúng', async () => {
    const res = await service.list(query({ branchId: cn1.id }), ADMIN);
    expect(codes(res.hits)).toEqual(['TH0001', 'HH0001']);
    expect(res.total).toBe(2);
    expect(res.branchId).toBe(cn1.id);
    expect(res.summary).toEqual({ totalQtyOnHand: 150 });
    const [p, v] = res.hits;
    expect(p).toMatchObject({
      qtyOnHand: 150,
      sellable: 150,
      avgCost: 600, // (100×500 + 50×800) / 150
      lastPurchaseCost: 1100, // (12.000 − 1.000) / 10
      soldLast30Days: 60,
      stockoutDate: addDaysToDateOnly(today, 75), // floor(150 × 30 / 60)
      nearestExpiry: '2029-06-30',
      minStock: 200,
      maxStock: 1000,
      branches: null,
    });
    expect(p.units).toHaveLength(2);
    expect(p.locations).toEqual([{ location: { id: locationId, name: 'Kệ A1' } }]);
    expect(p.drug?.registrationNumber).toBe('VD-12345-20');
    expect(v).toMatchObject({
      qtyOnHand: 0,
      avgCost: null,
      lastPurchaseCost: null,
      stockoutDate: null,
      nearestExpiry: null,
    });
  });

  it('chi nhánh 3 chưa có lô nào → rỗng', async () => {
    const res = await service.list(query({ branchId: cn3.id }), ADMIN);
    expect(res.hits).toEqual([]);
    expect(res.summary.totalQtyOnHand).toBe(0);
  });

  it('giá vốn / giá nhập cuối khớp Thiết lập giá (dòng đơn vị gốc) cùng chi nhánh', async () => {
    const priceRows = new PriceBookRowsRepository(prisma as unknown as PrismaService);
    for (const branch of [cn1, cn2]) {
      const { items } = await priceRows.findPage(
        { codes: ['TH0001'], categoryIds: [], stock: 'all', branchId: branch.id },
        1,
        10,
      );
      const base = items.find((r) => r.factor === 1)!;
      const res = await service.list(query({ branchId: branch.id, q: 'TH0001' }), ADMIN);
      expect(res.hits[0]).toMatchObject({ avgCost: base.avgCost, lastPurchaseCost: base.lastPurchaseCost });
    }
  });

  it('toàn chuỗi: mỗi hàng một dòng, cộng cả chuỗi, bình quân gia quyền, kèm branches', async () => {
    const res = await service.list(query(), ADMIN);
    expect(res.branchId).toBeNull();
    expect(codes(res.hits)).toEqual(['TH0001', 'HH0001', 'HH0003']);
    expect(res.summary.totalQtyOnHand).toBe(200);
    const p = res.hits[0];
    expect(p).toMatchObject({
      qtyOnHand: 180,
      avgCost: 617, // (50.000 + 40.000 + 21.000) / 180 = 616,67
      lastPurchaseCost: 700, // phiếu CONFIRMED mới nhất cả chuỗi (CN02)
      soldLast30Days: 70,
      stockoutDate: addDaysToDateOnly(today, 77), // floor(180 × 30 / 70)
      minStock: null,
      maxStock: null,
    });
    expect(p.branches).toEqual([
      expect.objectContaining({
        branchCode: 'CN01',
        qtyOnHand: 150,
        avgCost: 600,
        lastPurchaseCost: 1100,
        minStock: 200,
        maxStock: 1000,
        soldLast30Days: 60,
      }),
      expect.objectContaining({
        branchCode: 'CN02',
        qtyOnHand: 30,
        avgCost: 700,
        lastPurchaseCost: 700,
        minStock: 10,
        soldLast30Days: 10,
        stockoutDate: addDaysToDateOnly(today, 90),
      }),
    ]);
    // Lô bị khoá: tồn vẫn tính, giá vốn không (không còn lô AVAILABLE), sellable 0.
    expect(res.hits[2]).toMatchObject({ qtyOnHand: 20, sellable: 0, avgCost: null });
    expect(res.hits[2].branches).toEqual([expect.objectContaining({ branchCode: 'CN02', qtyOnHand: 20 })]);
  });

  it('PM: không gửi branchId = chi nhánh mình; gửi chi nhánh khác → 1506', async () => {
    const pm = actor(AuthRole.PHARMACY_MANAGER, cn1.id);
    const res = await service.list(query(), pm);
    expect(res.branchId).toBe(cn1.id);
    expect(codes(res.hits)).toEqual(['TH0001', 'HH0001']);
    // Tìm theo số lô / lọc NCC không lộ chi nhánh khác: lô P-03 chỉ ở CN02, NCC 1 chỉ nhập cho CN01.
    expect(codes((await service.list(query({ qLot: 'P-03' }), ADMIN)).hits)).toEqual(['TH0001']);
    expect(codes((await service.list(query({ qLot: 'P-03' }), pm)).hits)).toEqual([]);
    const pm2 = actor(AuthRole.PHARMACY_MANAGER, cn2.id);
    expect(codes((await service.list(query({ supplierIds: [s1.id] }), pm2)).hits)).toEqual([]);
    await expect(service.list(query({ branchId: cn2.id }), pm)).rejects.toMatchObject({
      response: { code: ErrorCode.BRANCH_ACCESS_DENIED },
    });
  });

  it('không được xem giá vốn → avgCost/lastPurchaseCost null (cả trong branches), sort theo giá vốn bị bỏ qua', async () => {
    costVisible = false;
    const res = await service.list(query({ sortBy: 'avgCost', sortDir: 'desc' }), ADMIN);
    expect(codes(res.hits)).toEqual(['TH0001', 'HH0001', 'HH0003']); // thứ tự mặc định
    for (const hit of res.hits) {
      expect(hit.avgCost).toBeNull();
      expect(hit.lastPurchaseCost).toBeNull();
      for (const b of hit.branches ?? []) {
        expect(b.avgCost).toBeNull();
        expect(b.lastPurchaseCost).toBeNull();
      }
    }
  });

  it('lọc tồn: below_min / above_max / in_stock / out_of_stock / custom', async () => {
    const at = async (branchId: string | undefined, q: Partial<BranchProductListQuery>) =>
      codes((await service.list(query({ branchId, ...q }), ADMIN)).hits);
    expect(await at(cn1.id, { stockFilter: 'below_min' })).toEqual(['TH0001']); // 150 < 200
    expect(await at(cn2.id, { stockFilter: 'below_min' })).toEqual([]); // 30 ≥ ngưỡng riêng 10
    expect(await at(undefined, { stockFilter: 'below_min' })).toEqual(['TH0001']); // có CN01 dưới định mức
    expect(await at(undefined, { stockFilter: 'above_max' })).toEqual(['HH0003']); // 20 > 10
    expect(await at(cn1.id, { stockFilter: 'out_of_stock' })).toEqual(['HH0001']);
    expect(await at(cn1.id, { stockFilter: 'in_stock' })).toEqual(['TH0001']);
    expect(await at(undefined, { stockFilter: 'custom', stockOp: 'gte', stockValue: 20 })).toEqual([
      'TH0001',
      'HH0003',
    ]);
    expect(await at(undefined, { stockFilter: 'custom', stockOp: 'eq' })).toHaveLength(3); // thiếu số → bỏ qua
  });

  it('lọc NCC theo phạm vi, sắp xếp theo cột kho, tìm kiếm', async () => {
    const at = async (branchId: string | undefined, q: Partial<BranchProductListQuery>) =>
      codes((await service.list(query({ branchId, ...q }), ADMIN)).hits);
    expect(await at(cn2.id, { supplierIds: [s2.id] })).toEqual(['TH0001']);
    expect(await at(cn2.id, { supplierIds: [s1.id] })).toEqual([]); // NCC 1 chỉ nhập cho CN01
    expect(await at(undefined, { supplierIds: [s1.id] })).toEqual(['TH0001']);
    expect(await at(undefined, { sortBy: 'qtyOnHand', sortDir: 'asc' })).toEqual(['HH0001', 'HH0003', 'TH0001']);
    expect(await at(undefined, { sortBy: 'avgCost', sortDir: 'asc' })).toEqual(['TH0001', 'HH0001', 'HH0003']);
    expect(await at(undefined, { sortBy: 'lastPurchaseCost', sortDir: 'desc' })).toEqual([
      'TH0001',
      'HH0001',
      'HH0003',
    ]);
    expect(await at(undefined, { sortBy: 'stockoutDate', sortDir: 'desc' })).toEqual(['TH0001', 'HH0001', 'HH0003']);
    expect(await at(undefined, { q: 'paracet', searchField: 'generic' })).toEqual(['TH0001']);
    expect(await at(undefined, { q: '8930000000999' })).toEqual(['TH0001']); // mã vạch đơn vị hộp
    expect(await at(cn1.id, { qLot: 'P-02' })).toEqual(['TH0001']);
    expect(await at(cn2.id, { qLot: 'P-02' })).toEqual([]);
    expect(await at(undefined, { qLot: '30/06/2029' })).toEqual(['TH0001']);
    expect(await at(undefined, { categoryIds: [parentCategoryId] })).toEqual(['TH0001']); // gồm nhóm con
    expect(await at(undefined, { locationIds: ['none'] })).toEqual(['HH0001', 'HH0003']);
    expect(await at(undefined, { limit: 2, page: 2 })).toEqual(['HH0003']);
  });

  it('Danh mục hàng hoá: không phụ thuộc lô, lọc + sắp xếp ở SQL, đủ trường cột', async () => {
    const repo = new ProductRepository(prisma as unknown as PrismaService);
    const page = (q: Partial<BranchProductListQuery>, sortBy?: 'price' | 'name', sortDir: 'asc' | 'desc' = 'asc') =>
      repo.findCatalogPage(toProductListFilter(Object.assign(new BranchProductListQuery(), q)), {
        page: 1,
        limit: 50,
        sortBy,
        sortDir,
        deleted: false,
      });
    const all = await page({});
    expect(codes(all.hits)).toEqual(['TH0001', 'HH0001', 'HH0002', 'HH0003', 'HH0004']);
    expect(all.hits[0].units).toHaveLength(2);
    expect(codes((await page({ types: ['DRUG'] })).hits)).toEqual(['TH0001']);
    expect(codes((await page({ categoryIds: [childCategoryId] })).hits)).toEqual(['TH0001']);
    expect(codes((await page({ q: 'khẩu' })).hits)).toEqual(['HH0002']);
    // Không phân biệt dấu / hoa thường ở cột chữ; gõ có dấu cũng khớp.
    expect(codes((await page({ q: 'khau trang' })).hits)).toEqual(['HH0002']);
    expect(codes((await page({ q: 'BONG Y TE' })).hits)).toEqual(['HH0003']);
    expect(codes((await page({ qCodeName: 'bông' })).hits)).toEqual(['HH0003']);
    expect(codes((await page({ q: 'da xoa' })).hits)).toEqual(['HH0004']); // HH0009 đã xoá mềm → ẩn
    expect(codes((await page({ q: 'para', searchField: 'generic' })).hits)).toEqual(['TH0001']);
    expect(codes((await page({ locationIds: [locationId] })).hits)).toEqual(['TH0001']);
    expect(codes((await page({ createdFrom: today, createdTo: today })).hits)).toHaveLength(5);
    expect(codes((await page({ createdTo: addDaysToDateOnly(today, -1) })).hits)).toEqual([]);
    expect(codes((await page({ statuses: ['INACTIVE'] })).hits)).toEqual([]);
    // Giá bán đơn vị cơ bản = 1000 + độ dài mã (6) cho mọi hàng → hoà, rơi về thứ tự tạo.
    expect(codes((await page({}, 'name', 'desc')).hits)).toEqual(['HH0001', 'TH0001', 'HH0002', 'HH0004', 'HH0003']);
    expect(mask.id).toBeDefined();
  });
});
