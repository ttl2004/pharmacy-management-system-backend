import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { foldVn } from 'src/common/utils/vn-fold.util';
import {
  applyMigrationFile,
  applyMigrationsUntil,
  buildTestDatabaseUrl,
  createTestPrisma,
  resetSchema,
  withAuditMaintenance,
} from 'src/test-support/db-test';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const BACKFILL_SCHEMA = 'audit_db_backfill';

/** 67 chữ thường có dấu (kể cả đ) và 67 chữ hoa tương ứng. */
const VN_LOWER = 'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ';
const VN_LETTERS = [...VN_LOWER, ...VN_LOWER.toUpperCase()];

async function seedRoleAndUser(db: PrismaClient, userIds: string[]): Promise<void> {
  const roleId = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO roles (id, code, name, level) VALUES ($1::uuid, 'R_TEST', 'Vai trò test', 1)`,
    roleId,
  );
  for (const id of userIds) {
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, "fullName", "roleId") VALUES ($1::uuid, 'Người test', $2::uuid)`,
      id,
      roleId,
    );
  }
}

async function seedBranch(db: PrismaClient, code: string): Promise<string> {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO branches (id, code, name, phone, address) VALUES ($1::uuid, $2, $2, '0900000000', 'Địa chỉ test')`,
    id,
    code,
  );
  return id;
}

describe('migration nhat_ky_v21', () => {
  let prisma: PrismaClient;
  let actorId: string;

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetSchema(prisma);
    actorId = randomUUID();
    await seedRoleAndUser(prisma, [actorId]);
  });

  async function seedAuditRows(): Promise<void> {
    await prisma.auditLog.create({
      data: { actorId, action: 'CREATE', event: 'ORDER.CREATED', entityType: 'orders', entityId: randomUUID() },
    });
    await prisma.securityEvent.create({ data: { type: 'AUTH.LOGIN', outcome: 'SUCCESS', actorId } });
  }

  it('id sinh bằng uuid v7', async () => {
    await seedAuditRows();
    const log = await prisma.auditLog.findFirstOrThrow();
    const sec = await prisma.securityEvent.findFirstOrThrow();
    expect(log.id[14]).toBe('7');
    expect(sec.id[14]).toBe('7');
  });

  it('chặn UPDATE/DELETE/TRUNCATE audit_logs và security_events', async () => {
    await seedAuditRows();
    for (const table of ['audit_logs', 'security_events']) {
      await expect(prisma.$executeRawUnsafe(`UPDATE ${table} SET "severity" = 1`)).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only/);
    }
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.securityEvent.count()).toBe(1);
  });

  it('withAuditMaintenance cho phép xoá', async () => {
    await seedAuditRows();
    await withAuditMaintenance(prisma, async (tx) => {
      await tx.auditLog.deleteMany();
      await tx.securityEvent.deleteMany();
    });
    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.securityEvent.count()).toBe(0);
  });

  it('CHECK từ chối event, actorType, severity, outcome và type sai', async () => {
    const base = { actorId, action: 'CREATE' as const, entityType: 'orders', entityId: randomUUID() };
    await expect(prisma.auditLog.create({ data: { ...base, event: 'order.created' } })).rejects.toThrow(
      /audit_logs_event_chk/,
    );
    await expect(
      prisma.auditLog.create({ data: { ...base, event: 'ORDER.CREATED', actorType: 'BOT' } }),
    ).rejects.toThrow(/audit_logs_actor_type_chk/);
    await expect(prisma.auditLog.create({ data: { ...base, event: 'ORDER.CREATED', severity: 3 } })).rejects.toThrow(
      /audit_logs_severity_chk/,
    );
    await expect(prisma.securityEvent.create({ data: { type: 'AUTH.LOGIN', outcome: 'OK' } })).rejects.toThrow(
      /security_events_outcome_chk/,
    );
    await expect(prisma.securityEvent.create({ data: { type: 'login', outcome: 'FAILED' } })).rejects.toThrow(
      /security_events_type_chk/,
    );
  });

  it('vn_fold(SQL) === foldVn(TS) cho đủ 134 ký tự có dấu (hoa + thường) và chuỗi NFD', async () => {
    expect(VN_LETTERS).toHaveLength(134);
    expect(new Set(VN_LETTERS).size).toBe(134);
    const inputs = [
      ...VN_LETTERS,
      VN_LETTERS.join(''),
      '  Nguyễn   Văn ĐỨC — Huỷ đơn ĐH000123  '.normalize('NFD'),
      'Thuốc HẾT hạn'.normalize('NFD'),
    ];
    for (const input of inputs) {
      const [row] = await prisma.$queryRaw<{ v: string }[]>`SELECT vn_fold(${input}) AS v`;
      expect({ input, v: row.v }).toEqual({ input, v: foldVn(input) });
    }
    const [nul] = await prisma.$queryRaw<{ v: string }[]>`SELECT vn_fold(NULL) AS v`;
    expect(nul.v).toBe(foldVn(null));
    const [fn] = await prisma.$queryRaw<{ provolatile: string }[]>`
      SELECT provolatile FROM pg_proc WHERE proname = 'vn_fold' AND pronamespace = current_schema()::regnamespace`;
    expect(fn.provolatile).toBe('i');
  });

  it('index audit_logs_search_trgm_idx dùng gin_trgm_ops; index (branchId, createdAt) cũ đã xoá', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'audit_logs'`;
    const trgm = rows.find((r) => r.indexname === 'audit_logs_search_trgm_idx');
    expect(trgm?.indexdef).toMatch(/USING gin \("searchText" extensions\.gin_trgm_ops\)/);
    expect(rows.map((r) => r.indexname)).not.toContain('audit_logs_branchId_createdAt_idx');
  });

  describe('backfill trên schema riêng audit_db_backfill', () => {
    let old: PrismaClient;

    beforeAll(async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${BACKFILL_SCHEMA}" CASCADE`);
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${BACKFILL_SCHEMA}"`);
      await applyMigrationsUntil(prisma, BACKFILL_SCHEMA, 'nhat_ky_v21');
      old = new PrismaClient({ datasources: { db: { url: buildTestDatabaseUrl(BACKFILL_SCHEMA) } } });
      await old.$connect();
    });

    afterAll(async () => {
      await old?.$disconnect();
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${BACKFILL_SCHEMA}" CASCADE`);
    });

    it('backfill: mọi event khớp regex, branchIds không null, metadataVersion = 0, searchText đã fold', async () => {
      const [schemaRow] = await old.$queryRaw<{ s: string }[]>`SELECT current_schema() AS s`;
      expect(schemaRow.s).toBe(BACKFILL_SCHEMA);

      const userId = randomUUID();
      await seedRoleAndUser(old, [userId, SYSTEM_ACTOR_ID]);
      const b1 = await seedBranch(old, 'CN1');
      const b2 = await seedBranch(old, 'CN2');
      const adjustmentId = randomUUID();
      await old.$executeRawUnsafe(
        `INSERT INTO stock_adjustments (id, code, "branchId", type, reason) VALUES ($1::uuid, 'XH0001', $2::uuid, 'DISPOSE', 'Hết hạn')`,
        adjustmentId,
        b1,
      );
      const transferId = randomUUID();
      await old.$executeRawUnsafe(
        `INSERT INTO stock_transfers (id, code, "fromBranchId", "toBranchId") VALUES ($1::uuid, 'CK0001', $2::uuid, $3::uuid)`,
        transferId,
        b1,
        b2,
      );

      const ids = {
        voidPaid: randomUUID(),
        autoExpired: randomUUID(),
        disposal: randomUUID(),
        transfer: randomUUID(),
        priceBook: randomUUID(),
        supplier: randomUUID(),
      };
      const insert = (
        id: string,
        actor: string,
        action: string,
        entityType: string,
        entityId: string,
        branchId: string | null,
        before: object | null,
        after: object | null,
        reason: string | null,
      ) =>
        old.$executeRawUnsafe(
          `INSERT INTO audit_logs (id, "actorId", action, "entityType", "entityId", "branchId", before, after, reason)
           VALUES ($1::uuid, $2::uuid, $3::"AuditAction", $4, $5::uuid, $6::uuid, $7::jsonb, $8::jsonb, $9)`,
          id,
          actor,
          action,
          entityType,
          entityId,
          branchId,
          before === null ? null : JSON.stringify(before),
          after === null ? null : JSON.stringify(after),
          reason,
        );
      await insert(
        ids.voidPaid,
        userId,
        'STATUS_CHANGE',
        'orders',
        randomUUID(),
        b1,
        { status: 'COMPLETED', code: 'ĐH000123' },
        { status: 'CANCELLED', refunded: '150000' },
        'Khách  ĐỔI ý',
      );
      await insert(
        ids.autoExpired,
        SYSTEM_ACTOR_ID,
        'STATUS_CHANGE',
        'orders',
        randomUUID(),
        b1,
        { status: 'PENDING' },
        { status: 'CANCELLED', code: 'ĐH000124' },
        null,
      );
      await insert(
        ids.disposal,
        userId,
        'STATUS_CHANGE',
        'stock_adjustments',
        adjustmentId,
        b1,
        { status: 'DRAFT' },
        { status: 'CONFIRMED', code: 'XH0001' },
        null,
      );
      await insert(
        ids.transfer,
        userId,
        'STATUS_CHANGE',
        'stock_transfers',
        transferId,
        b1,
        { status: 'PENDING' },
        { status: 'IN_TRANSIT', code: 'CK0001' },
        null,
      );
      await insert(
        ids.priceBook,
        userId,
        'CREATE',
        'price_books',
        randomUUID(),
        null,
        null,
        { name: 'Bảng giá Hè', branchIds: [b1, b2] },
        null,
      );
      await insert(
        ids.supplier,
        userId,
        'UPDATE',
        'suppliers',
        randomUUID(),
        null,
        { code: 'NCC001', name: 'Dược Hậu Giang' },
        { name: 'Công ty Dược Hậu Giang' },
        null,
      );

      applyMigrationFile(BACKFILL_SCHEMA, 'nhat_ky_v21');

      const rows = await old.$queryRawUnsafe<
        {
          id: string;
          event: string;
          actorType: string;
          branchIds: string[] | null;
          metadataVersion: number;
          searchText: string;
          amount: bigint | null;
          actorRoleCode: string | null;
          actorBranchId: string | null;
          requestId: string | null;
          entityLabel: string | null;
        }[]
      >(
        `SELECT id::text, event, "actorType", "branchIds"::text[] AS "branchIds", "metadataVersion", "searchText", amount,
                "actorRoleCode", "actorBranchId"::text, "requestId"::text, "entityLabel"
         FROM audit_logs`,
      );
      expect(rows).toHaveLength(6);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const pick = (id: string) => {
        const r = byId.get(id);
        if (!r) throw new Error(`thiếu dòng ${id}`);
        return r;
      };

      for (const r of rows) {
        expect(r.event).toMatch(/^[A-Z_]+\.[A-Z_]+$/);
        expect(r.branchIds).not.toBeNull();
        expect(r.metadataVersion).toBe(0);
        expect(r.amount).toBeNull();
        expect(r.actorRoleCode).toBeNull();
        expect(r.actorBranchId).toBeNull();
        expect(r.requestId).toBeNull();
        expect(r.entityLabel).toBeNull();
      }

      expect(pick(ids.voidPaid)).toMatchObject({
        event: 'ORDER.VOID_PAID',
        actorType: 'USER',
        branchIds: [b1],
        searchText: 'dh000123 khach doi y',
      });
      expect(pick(ids.autoExpired)).toMatchObject({
        event: 'ORDER.AUTO_EXPIRED',
        actorType: 'SYSTEM',
        branchIds: [b1],
        searchText: 'dh000124',
      });
      expect(pick(ids.disposal)).toMatchObject({ event: 'DISPOSAL.CONFIRMED', branchIds: [b1], searchText: 'xh0001' });
      expect(pick(ids.transfer)).toMatchObject({
        event: 'TRANSFER.SHIPPED',
        branchIds: [b1, b2],
        searchText: 'ck0001',
      });
      expect(pick(ids.priceBook)).toMatchObject({
        event: 'PRICE_BOOK.CREATED',
        branchIds: [b1, b2],
        searchText: 'bang gia he',
      });
      expect(pick(ids.supplier)).toMatchObject({ event: 'SUPPLIER.UPDATED', branchIds: [], searchText: 'ncc001' });

      const [col] = await old.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_logs' AND column_name = 'event'`;
      expect(col.is_nullable).toBe('NO');
    });
  });
});
