import { execSync } from 'child_process';
import { config as loadEnv } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';

export const DB_TEST_SCHEMA = 'audit_db_test';

function buildTestDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) loadEnv();
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL chưa được cấu hình');
  const url = new URL(base);
  url.searchParams.set('schema', DB_TEST_SCHEMA);
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
