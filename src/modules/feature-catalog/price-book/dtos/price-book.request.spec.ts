import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetBookItemRequest, SetGeneralPriceRequest } from './price-book-rows.request';
import { PriceBookFormulaRequest } from './price-book.request';

const UUID = '3f6c1a52-6b1e-4c1a-9a3e-2d5b8f0e7a11';
const check = (cls: new () => object, payload: Record<string, unknown>) =>
  validate(plainToInstance(cls, payload), { whitelist: true, forbidNonWhitelisted: true });

describe('DTO bảng giá — trần số', () => {
  it('giá chung vượt int4 bị từ chối, giá hợp lệ qua', async () => {
    const ok = { drugId: UUID, unitId: UUID, price: 25000 };
    expect(await check(SetGeneralPriceRequest, ok)).toHaveLength(0);
    const errors = await check(SetGeneralPriceRequest, { ...ok, price: 2_147_483_648 });
    expect(errors.map((e) => e.property)).toEqual(['price']);
  });

  it('giá dòng bảng giá vượt trần bị từ chối; null (bỏ dòng) vẫn hợp lệ', async () => {
    const ok = { drugId: UUID, unitId: UUID, price: null };
    expect(await check(SetBookItemRequest, ok)).toHaveLength(0);
    const errors = await check(SetBookItemRequest, { ...ok, price: 9_999_999_999 });
    expect(errors.map((e) => e.property)).toEqual(['price']);
  });

  it('giá trị công thức quá lớn bị từ chối', async () => {
    const ok = { base: 'avgCost', op: '+', amount: 10, unit: 'vnd' };
    expect(await check(PriceBookFormulaRequest, ok)).toHaveLength(0);
    const errors = await check(PriceBookFormulaRequest, { ...ok, amount: 5_000_000_000 });
    expect(errors.map((e) => e.property)).toEqual(['amount']);
  });
});
