import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OpeningStockRequest } from './opening-stock.request';

const UUID = '3f6c1a52-6b1e-4c1a-9a3e-2d5b8f0e7a11';
const base = { branchId: UUID, productId: UUID, quantity: 10, unitCost: 1000 };
const errorsFor = (payload: Record<string, unknown>) =>
  validate(plainToInstance(OpeningStockRequest, payload), { whitelist: true, forbidNonWhitelisted: true });

describe('OpeningStockRequest — trần số', () => {
  it('chấp nhận giá trị hợp lệ', async () => {
    expect(await errorsFor(base)).toHaveLength(0);
  });

  it('số lượng vượt int4 bị từ chối bằng 400 (validation) thay vì 500', async () => {
    const errors = await errorsFor({ ...base, quantity: 2_147_483_648 });
    expect(errors.map((e) => e.property)).toEqual(['quantity']);
  });

  it('giá vốn vượt trần bị từ chối', async () => {
    const errors = await errorsFor({ ...base, unitCost: 5_000_000_000 });
    expect(errors.map((e) => e.property)).toEqual(['unitCost']);
  });
});
