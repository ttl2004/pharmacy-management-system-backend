import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AbstractBaseQuery, MAX_PAGE_LIMIT } from './abstract-base.query';

async function errorsFor(query: Record<string, string>) {
  return validate(plainToInstance(AbstractBaseQuery, query));
}

describe('AbstractBaseQuery.limit', () => {
  it(`nhận đúng trần ${MAX_PAGE_LIMIT}`, async () => {
    await expect(errorsFor({ limit: String(MAX_PAGE_LIMIT) })).resolves.toHaveLength(0);
  });

  it('từ chối limit vượt trần — không cho một request kéo về cả bảng', async () => {
    const errors = await errorsFor({ limit: String(MAX_PAGE_LIMIT + 1) });
    expect(errors.map((error) => error.property)).toEqual(['limit']);
  });

  it('không gửi limit thì mặc định 10', () => {
    expect(plainToInstance(AbstractBaseQuery, {}).limit).toBe(10);
  });
});
