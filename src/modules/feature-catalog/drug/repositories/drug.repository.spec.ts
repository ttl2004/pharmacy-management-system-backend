import type { DrugSourceRecord } from '../drug-source.client';
import { DrugRepository, UPSERT_BATCH_SIZE } from './drug.repository';

const drug = (code: string) => ({ code, name: code }) as DrugSourceRecord;

describe('DrugRepository — upsert theo lô', () => {
  it('chia danh mục lớn thành từng lô, mỗi lô một câu lệnh — không vượt giới hạn tham số của Postgres', async () => {
    const executeRaw = jest.fn().mockImplementation((_strings: unknown, ...values: unknown[]) => {
      // Tham số thứ nhất sau mẫu SQL là Prisma.join(rows) — đếm số dòng của lô.
      return Promise.resolve((values[0] as { values: unknown[] }).values.length / 25);
    });
    const tx = { $executeRaw: executeRaw };
    const repository = new DrugRepository({} as never);
    const drugs = Array.from({ length: UPSERT_BATCH_SIZE * 2 + 1 }, (_, i) => drug(`M${i}`));

    const upserted = await repository.upsertAll(tx as never, drugs, new Date(), 'actor-id');

    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(upserted).toBe(drugs.length);
  });
});
