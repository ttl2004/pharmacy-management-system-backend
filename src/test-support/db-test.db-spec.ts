import { PrismaClient } from '@prisma/client';
import { DB_TEST_SCHEMA, createTestPrisma, resetSchema } from './db-test';

describe('db-test helper', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = await createTestPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('current_schema() là audit_db_test', async () => {
    const rows = await prisma.$queryRaw<{ current_schema: string }[]>`SELECT current_schema()`;
    expect(rows[0].current_schema).toBe(DB_TEST_SCHEMA);
  });

  it('resetSchema throw nếu current_schema khác audit_db_test', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ current_schema: 'public' }]);
    const transaction = jest.fn();
    const executeRawUnsafe = jest.fn();
    const fake = {
      $queryRaw: queryRaw,
      $transaction: transaction,
      $executeRawUnsafe: executeRawUnsafe,
    } as unknown as PrismaClient;

    await expect(resetSchema(fake)).rejects.toThrow(/audit_db_test/);
    expect(transaction).not.toHaveBeenCalled();
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });
});
