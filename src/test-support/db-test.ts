import { execFileSync, execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { config as loadEnv } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';

export const DB_TEST_SCHEMA = 'audit_db_test';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

export function buildTestDatabaseUrl(schema: string = DB_TEST_SCHEMA): string {
  if (schema === 'public') throw new Error('Không bao giờ chạy test trên schema public');
  if (!process.env.DATABASE_URL) loadEnv({ quiet: true });
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL chưa được cấu hình');
  const url = new URL(base);
  url.searchParams.set('schema', schema);
  return url.toString();
}

export async function createTestPrisma(): Promise<PrismaClient> {
  const url = buildTestDatabaseUrl();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();
  return prisma;
}

export async function withAuditMaintenance<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    return fn(tx);
  });
}

export async function resetSchema(prisma: PrismaClient): Promise<void> {
  const [row] = await prisma.$queryRaw<{ current_schema: string }[]>`SELECT current_schema() AS current_schema`;
  if (row?.current_schema !== DB_TEST_SCHEMA) {
    throw new Error(`resetSchema từ chối chạy: current_schema() = ${row?.current_schema}, cần ${DB_TEST_SCHEMA}`);
  }
  await withAuditMaintenance(prisma, async (tx) => {
    const tables = await tx.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = ${DB_TEST_SCHEMA} AND tablename <> '_prisma_migrations'`;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"${DB_TEST_SCHEMA}"."${t.tablename.replace(/"/g, '""')}"`).join(', ');
    await tx.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  });
}

/** Thư mục migration theo thứ tự tên (= thứ tự Prisma áp). */
function listMigrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(MIGRATIONS_DIR, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort();
}

/** Khớp tên đầy đủ (`20261104090000_nhat_ky_v21`) hoặc phần tên (`nhat_ky_v21`). */
function matchesMigration(dir: string, name: string): boolean {
  return dir === name || dir.endsWith(`_${name}`);
}

/** Chạy nguyên file migration.sql bằng `prisma db execute` (chạy được nhiều câu lệnh, có $$...$$). */
function executeMigrationDir(schema: string, dir: string): void {
  execFileSync(
    'npx',
    [
      'prisma',
      'db',
      'execute',
      '--file',
      join(MIGRATIONS_DIR, dir, 'migration.sql'),
      '--url',
      buildTestDatabaseUrl(schema),
    ],
    { stdio: 'pipe' },
  );
}

/**
 * Áp các migration theo thứ tự tên lên `schema`, DỪNG trước `exclusiveName` (không chạy nó và mọi migration sau).
 * Dùng để dựng DB "kiểu cũ" rồi kiểm backfill của một migration. Schema phải tồn tại sẵn và khác `public`.
 */
export async function applyMigrationsUntil(prisma: PrismaClient, schema: string, exclusiveName: string): Promise<void> {
  const dirs = listMigrationDirs();
  const stop = dirs.findIndex((d) => matchesMigration(d, exclusiveName));
  if (stop < 0) throw new Error(`Không tìm thấy migration ${exclusiveName}`);
  await assertSchemaExists(prisma, schema);
  for (const dir of dirs.slice(0, stop)) executeMigrationDir(schema, dir);
}

/** Chạy đúng một migration (theo tên) lên `schema`, cùng cách với `applyMigrationsUntil`. */
export function applyMigrationFile(schema: string, name: string): void {
  const dir = listMigrationDirs().find((d) => matchesMigration(d, name));
  if (!dir) throw new Error(`Không tìm thấy migration ${name}`);
  executeMigrationDir(schema, dir);
}

async function assertSchemaExists(prisma: PrismaClient, schema: string): Promise<void> {
  if (schema === 'public') throw new Error('Không bao giờ chạy test trên schema public');
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = ${schema}`;
  if (rows[0]?.n !== 1) throw new Error(`Schema ${schema} chưa tồn tại`);
}
