import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { Prisma, PrismaClient } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { PrismaService } from 'src/common/databases/prisma.service';
import { AuthRole } from 'src/common/types/common.enum';
import { ProductRepository } from 'src/modules/feature-catalog/product/repositories/product.repository';
import { toProductListFilter } from 'src/common/dtos/product-list-filter.query';
import { buildTestDatabaseUrl } from 'src/test-support/db-test';
import { BranchProductListService } from './branch-product-list.service';
import { BranchProductListQuery } from './dtos/branch-product-list.query';
import { BranchProductListRepository } from './repositories/branch-product-list.repository';

/**
 * ĐO HIỆU NĂNG Hàng hoá chi nhánh / Danh mục trên dữ liệu lớn — chỉ chạy khi `PERF=1`:
 *
 *   PERF=1 npm run test:db -- branch-product-list.perf
 *
 * Dữ liệu sinh bằng SQL (generate_series) trong schema RIÊNG `perf_branch_products` (không đụng `public`, không đụng
 * `audit_db_test` của các db-spec khác): 5 chi nhánh, 5.000 hàng (4.500 có lô), 30.000 lô, 200.000 bút toán sổ kho,
 * 20.000 dòng phiếu nhập, 90.000 dòng bán theo ngày. Sinh một lần, lần sau dùng lại (`PERF_RESEED=1` để sinh lại).
 * Mục tiêu: mỗi màn (mọi câu SQL của một request) < 300 ms. `PERF_PLAN_FILE=…` ghi EXPLAIN ANALYZE các câu chính.
 */
const PERF_SCHEMA = 'perf_branch_products';
const TARGET_MS = 300;
const RUNS = 7;
const run = process.env.PERF === '1' ? describe : describe.skip;

const SEED_SQL: string[] = [
  `INSERT INTO units (id, code, name) VALUES (gen_random_uuid(), 'VIEN', 'Viên'), (gen_random_uuid(), 'HOP', 'Hộp')`,
  `INSERT INTO categories (id, name) SELECT gen_random_uuid(), 'Nhóm ' || g FROM generate_series(1, 10) g`,
  `INSERT INTO categories (id, name, "parentId")
   SELECT gen_random_uuid(), 'Nhóm con ' || g, (SELECT id FROM categories WHERE name = 'Nhóm ' || (1 + g % 10))
   FROM generate_series(1, 40) g`,
  `INSERT INTO branches (id, code, name, phone, address)
   SELECT gen_random_uuid(), 'CN' || lpad(g::text, 2, '0'), 'Chi nhánh ' || g, '0900000000', 'HN' FROM generate_series(1, 5) g`,
  `INSERT INTO suppliers (id, code, name, phone)
   SELECT gen_random_uuid(), 'NCC' || lpad(g::text, 4, '0'), 'Nhà cung cấp ' || g, '0911111111' FROM generate_series(1, 50) g`,
  `INSERT INTO manufacturers (id, code, name)
   SELECT gen_random_uuid(), 'NSX' || lpad(g::text, 4, '0'), 'Hãng ' || g FROM generate_series(1, 200) g`,
  `INSERT INTO shelf_locations (id, name) SELECT gen_random_uuid(), 'Kệ ' || g FROM generate_series(1, 30) g`,
  `INSERT INTO drugs (id, code, name, ingredients, strength, "registrationNumber", "syncedAt")
   SELECT gen_random_uuid(), 'VD-' || lpad(g::text, 5, '0'), x.base || ' ' || (g % 50 * 10 + 50) || 'mg', x.base,
          (g % 50 * 10 + 50) || 'mg', 'VD-' || lpad(g::text, 5, '0') || '-20', now()
   FROM generate_series(1, 3000) g,
   LATERAL (SELECT (ARRAY['Paracetamol','Amoxicillin','Ibuprofen','Cefuroxim','Vitamin C','Omeprazol','Metformin',
     'Amlodipin','Losartan','Azithromycin','Loratadin','Cetirizin','Esomeprazol','Diclofenac','Prednisolon',
     'Clarithromycin','Simvastatin','Atorvastatin','Gliclazid','Domperidon'])[1 + g % 20] AS base) x`,
  `WITH d AS (SELECT id, name, row_number() OVER (ORDER BY code) AS rn FROM drugs),
        c AS (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM categories),
        m AS (SELECT id, row_number() OVER (ORDER BY code) AS rn FROM manufacturers),
        u AS (SELECT id FROM units WHERE code = 'VIEN')
   INSERT INTO products (id, code, name, type, "drugId", "categoryId", "manufacturerId", "baseUnitId", "minStockLevel",
                         "maxStockLevel", status, "createdAt", "shortName", "requiresPrescription")
   SELECT gen_random_uuid(), CASE WHEN g <= 3000 THEN 'TH' ELSE 'HH' END || lpad(g::text, 5, '0'),
          COALESCE(d.name, 'Hàng hoá thường ' || g), (CASE WHEN g <= 3000 THEN 'DRUG' ELSE 'GOODS' END)::"ProductType",
          d.id, c.id, m.id, u.id, (g % 5) * 40, CASE WHEN g % 3 = 0 THEN 1500 END,
          (CASE WHEN g % 20 = 0 THEN 'INACTIVE' ELSE 'ACTIVE' END)::"RecordStatus",
          now() - ((5000 - g) || ' minutes')::interval, 'SP' || g, g <= 3000 AND g % 4 = 0
   FROM generate_series(1, 5000) g
   LEFT JOIN d ON d.rn = g
   JOIN c ON c.rn = 1 + g % 50
   JOIN m ON m.rn = 1 + g % 200
   CROSS JOIN u`,
  `INSERT INTO product_units (id, "productId", "unitId", "conversionRate", "salePrice", "isBaseUnit")
   SELECT gen_random_uuid(), p.id, u.id, 1, 1000 + abs(hashtext(p.code)) % 50000, true
   FROM products p CROSS JOIN units u WHERE u.code = 'VIEN'`,
  `INSERT INTO product_units (id, "productId", "unitId", "conversionRate", "salePrice", "isBaseUnit", barcode)
   SELECT gen_random_uuid(), p.id, u.id, 10, 10000 + abs(hashtext(p.code)) % 500000, false, '893' || lpad(substr(p.code, 3), 10, '0')
   FROM products p CROSS JOIN units u WHERE u.code = 'HOP' AND p.type = 'DRUG'`,
  `WITH l AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS rn FROM shelf_locations),
        p AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM products)
   INSERT INTO product_locations ("productId", "locationId")
   SELECT p.id, l.id FROM p JOIN l ON l.rn = p.rn % 30 WHERE p.rn % 10 < 7`,
  `WITH p AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM products),
        b AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM branches)
   INSERT INTO branch_products (id, "branchId", "productId", "minStockLevel")
   SELECT gen_random_uuid(), b.id, p.id, 30 + p.rn % 100 FROM p CROSS JOIN b WHERE (p.rn + b.rn) % 5 = 0`,
  `WITH p AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM products),
        b AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM branches),
        s AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM suppliers)
   INSERT INTO stock_batches (id, "branchId", "productId", "batchNumber", "expiryDate", "quantityOnHand", "importPrice",
                              "supplierId", status, "blockedReason")
   SELECT gen_random_uuid(), b.id, p.id, 'LO' || lpad(g::text, 6, '0'), current_date + (g % 900) - 60,
          CASE WHEN g % 7 = 0 THEN 0 ELSE g % 300 END, 500 + g % 2000, s.id,
          (CASE WHEN g % 97 = 0 THEN 'QUARANTINE' ELSE 'AVAILABLE' END)::"BatchStatus",
          CASE WHEN g % 97 = 0 THEN 'Kiểm tra chất lượng' END
   FROM generate_series(0, 29999) g
   JOIN p ON p.rn = g % 4500
   JOIN b ON b.rn = (g / 4500) % 5
   JOIN s ON s.rn = g % 50`,
  `WITH b AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM branches),
        s AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM suppliers)
   INSERT INTO goods_receipts (id, code, "branchId", "supplierId", status, "confirmedAt", "createdAt")
   SELECT gen_random_uuid(), 'PN' || lpad(g::text, 6, '0'), b.id, s.id,
          (CASE WHEN g % 10 = 0 THEN 'DRAFT' ELSE 'CONFIRMED' END)::"ReceiptStatus",
          CASE WHEN g % 10 <> 0 THEN now() - ((2000 - g) || ' hours')::interval END,
          now() - ((2000 - g) || ' hours')::interval
   FROM generate_series(1, 2000) g JOIN b ON b.rn = g % 5 JOIN s ON s.rn = g % 50`,
  `WITH r AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM goods_receipts),
        p AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM products)
   INSERT INTO goods_receipt_items (id, "receiptId", "productId", "productUnitId", quantity, "conversionRate",
                                    "baseQuantity", "importPrice", "unitDiscount", "totalPrice", "batchNumber", "expiryDate")
   SELECT gen_random_uuid(), r.id, p.id, pu.id, 10, 1, 10, 600 + g % 1500, g % 50, 10 * (600 + g % 1500 - g % 50),
          'LO' || g, current_date + 365
   FROM generate_series(0, 19999) g
   JOIN r ON r.rn = g / 10
   JOIN p ON p.rn = (g * 7) % 4500
   JOIN product_units pu ON pu."productId" = p.id AND pu."isBaseUnit"`,
  `WITH bt AS (SELECT id, "branchId", "productId", row_number() OVER (ORDER BY "batchNumber") - 1 AS rn FROM stock_batches)
   INSERT INTO stock_movements (id, "branchId", "productId", "batchId", type, quantity, "balanceAfter", "unitCost",
                                "refType", "refId", "createdAt")
   SELECT gen_random_uuid(), bt."branchId", bt."productId", bt.id,
          (CASE WHEN g % 10 = 0 THEN 'IMPORT' ELSE 'SALE' END)::"StockMovementType",
          CASE WHEN g % 10 = 0 THEN 50 ELSE -(1 + g % 5) END, 0, 600,
          (CASE WHEN g % 10 = 0 THEN 'GOODS_RECEIPT' ELSE 'ORDER' END)::"StockRefType", gen_random_uuid(),
          now() - ((g % 4320) || ' hours')::interval
   FROM generate_series(0, 199999) g JOIN bt ON bt.rn = g % 30000`,
  `WITH p AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM products),
        b AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS rn FROM branches)
   INSERT INTO sales_daily_product ("branchId", date, channel, "productId", "qtyBase", revenue, "cogsAmount")
   SELECT b.id, current_date - d, 'POS', p.id, 1 + (d + j) % 20, 0, 0
   FROM generate_series(0, 59) d CROSS JOIN generate_series(0, 4) bi CROSS JOIN generate_series(0, 299) j
   JOIN b ON b.rn = bi
   JOIN p ON p.rn = (d * 37 + bi * 101 + j) % 4500`,
];

run('Hàng hoá chi nhánh — hiệu năng (PERF=1)', () => {
  let prisma: PrismaClient;
  let service: BranchProductListService;
  let catalog: ProductRepository;
  let branchId: string;
  const captured: { query: string; params: string }[] = [];
  let capture = false;

  const ADMIN: RequestActor = {
    user: { userId: 'u', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
    ip: null,
    userAgent: null,
    requestId: null,
  };

  beforeAll(async () => {
    const url = buildTestDatabaseUrl(PERF_SCHEMA);
    const admin = new PrismaClient({ datasources: { db: { url: buildTestDatabaseUrl() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${PERF_SCHEMA}"`);
    await admin.$disconnect();
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });

    prisma = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
    (prisma as unknown as { $on: (e: 'query', cb: (ev: Prisma.QueryEvent) => void) => void }).$on('query', (ev) => {
      if (capture) captured.push({ query: ev.query, params: ev.params });
    });
    const [{ schema }] = await prisma.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS schema`;
    if (schema !== PERF_SCHEMA) throw new Error(`Sai schema: ${schema}`);

    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM products`;
    if (n !== 5000 || process.env.PERF_RESEED === '1') {
      const tables = await prisma.$queryRaw<{ t: string }[]>`
        SELECT tablename AS t FROM pg_tables WHERE schemaname = ${PERF_SCHEMA} AND tablename <> '_prisma_migrations'`;
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
        await tx.$executeRawUnsafe(
          `TRUNCATE ${tables.map((r) => `"${PERF_SCHEMA}"."${r.t}"`).join(', ')} RESTART IDENTITY CASCADE`,
        );
      });
      const started = Date.now();
      for (const sql of SEED_SQL) await prisma.$executeRawUnsafe(sql);
      console.log(`Sinh dữ liệu: ${Date.now() - started} ms`);
    }
    await prisma.$executeRawUnsafe('ANALYZE');
    const counts = await prisma.$queryRaw<Record<string, number>[]>`
      SELECT (SELECT count(*)::int FROM branches) AS branches, (SELECT count(*)::int FROM products) AS products,
             (SELECT count(*)::int FROM stock_batches) AS batches, (SELECT count(*)::int FROM stock_movements) AS movements,
             (SELECT count(*)::int FROM goods_receipt_items) AS receipt_lines,
             (SELECT count(*)::int FROM sales_daily_product) AS sales_rows`;
    console.log('Quy mô dữ liệu', counts[0]);

    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'CN01' } })).id;
    const permissions = { getGrantedCodes: () => Promise.resolve(new Set(['goods-receipt:create'])) };
    service = new BranchProductListService(
      new BranchProductListRepository(prisma as unknown as PrismaService),
      permissions as never,
    );
    catalog = new ProductRepository(prisma as unknown as PrismaService);
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const q = (over: Partial<BranchProductListQuery>) =>
    Object.assign(new BranchProductListQuery(), { page: 1, limit: 20, statuses: ['ACTIVE'], ...over });

  const scenarios: [string, () => Promise<unknown>][] = [
    ['CN: trang 1 mặc định', () => service.list(q({ branchId }), ADMIN)],
    ['CN: sort tồn kho giảm dần', () => service.list(q({ branchId, sortBy: 'qtyOnHand', sortDir: 'desc' }), ADMIN)],
    ['CN: lọc dưới định mức', () => service.list(q({ branchId, stockFilter: 'below_min' }), ADMIN)],
    ['CN: tìm "para"', () => service.list(q({ branchId, q: 'para' }), ADMIN)],
    ['CN: tìm nâng cao số lô', () => service.list(q({ branchId, qLot: 'LO0012' }), ADMIN)],
    ['CN: sort giá nhập cuối', () => service.list(q({ branchId, sortBy: 'lastPurchaseCost', sortDir: 'desc' }), ADMIN)],
    ['CN: sort dự kiến hết hàng', () => service.list(q({ branchId, sortBy: 'stockoutDate' }), ADMIN)],
    ['CN: lọc NCC', () => service.list(q({ branchId, supplierIds: [] }), ADMIN)],
    ['CN: trang 40 (OFFSET sâu)', () => service.list(q({ branchId, page: 40 }), ADMIN)],
    ['Toàn chuỗi: trang 1 (kèm branches)', () => service.list(q({}), ADMIN)],
    ['Toàn chuỗi: sort tồn kho', () => service.list(q({ sortBy: 'qtyOnHand', sortDir: 'desc' }), ADMIN)],
    ['Toàn chuỗi: lọc dưới định mức', () => service.list(q({ stockFilter: 'below_min' }), ADMIN)],
    ['Toàn chuỗi: sort giá vốn', () => service.list(q({ sortBy: 'avgCost' }), ADMIN)],
    ['Toàn chuỗi: sort dự kiến hết hàng', () => service.list(q({ sortBy: 'stockoutDate' }), ADMIN)],
    ['Toàn chuỗi: tìm "amox"', () => service.list(q({ q: 'amox' }), ADMIN)],
    // Từ khoá khớp gần hết bảng: planner ước lượng ít dòng → kiểm không rơi vào nested loop với lượng bán / giá nhập.
    ['Toàn chuỗi: tìm "a" + sort dự kiến hết', () => service.list(q({ q: 'a', sortBy: 'stockoutDate' }), ADMIN)],
    [
      'CN: tìm "a" + sort giá nhập cuối',
      () => service.list(q({ branchId, q: 'a', sortBy: 'lastPurchaseCost' }), ADMIN),
    ],
    [
      'CN: nhóm + dạng bào chế + kê đơn + sort dự kiến hết',
      () =>
        service.list(
          q({ branchId, types: ['DRUG'], isPrescriptionOnly: true, trackLots: true, sortBy: 'stockoutDate' }),
          ADMIN,
        ),
    ],
    [
      'Danh mục: trang 1',
      () => catalog.findCatalogPage(toProductListFilter(q({})), { page: 1, limit: 20, sortDir: 'asc', deleted: false }),
    ],
    [
      'Danh mục: tìm "para" + sort giá',
      () =>
        catalog.findCatalogPage(toProductListFilter(q({ q: 'para' })), {
          page: 1,
          limit: 20,
          sortBy: 'price',
          sortDir: 'desc',
          deleted: false,
        }),
    ],
  ];

  it(`mọi màn < ${TARGET_MS} ms (trung vị ${RUNS} lần, sau 1 lần làm nóng)`, async () => {
    // Lọc NCC cần id thật — lấy 2 NCC đầu.
    const suppliers = await prisma.supplier.findMany({ take: 2, orderBy: { code: 'asc' }, select: { id: true } });
    scenarios[7][1] = () => service.list(q({ branchId, supplierIds: suppliers.map((s) => s.id) }), ADMIN);

    const results: { scenario: string; median: number; max: number }[] = [];
    for (const [name, fn] of scenarios) {
      await fn();
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const t = process.hrtime.bigint();
        await fn();
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      times.sort((a, b) => a - b);
      results.push({ scenario: name, median: +times[RUNS >> 1].toFixed(1), max: +times[RUNS - 1].toFixed(1) });
    }
    console.table(results);

    if (process.env.PERF_PLAN_FILE) {
      const plans: string[] = [];
      for (const [name, fn] of scenarios) {
        captured.length = 0;
        capture = true;
        await fn();
        capture = false;
        for (const { query, params } of captured.filter(
          (c) => c.query.includes('WITH') || c.query.includes('FROM "products" p'),
        )) {
          const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
            `EXPLAIN (ANALYZE, BUFFERS) ${query}`,
            ...(JSON.parse(params) as unknown[]),
          );
          plans.push(`### ${name}\n${query}\n\n${rows.map((r) => r['QUERY PLAN']).join('\n')}\n`);
        }
      }
      writeFileSync(process.env.PERF_PLAN_FILE, plans.join('\n'));
    }

    for (const r of results)
      expect({ scenario: r.scenario, ok: r.median < TARGET_MS }).toEqual({ scenario: r.scenario, ok: true });
  }, 600_000);
});
