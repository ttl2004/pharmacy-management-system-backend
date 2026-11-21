import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductExtraFieldsRequest } from './product-extra-fields.request';
import { ProductUnitRequest } from './product.request';

const UUID = '3f6c1a52-6b1e-4c1a-9a3e-2d5b8f0e7a11';
const base = { unitId: UUID, conversionRate: 1, salePrice: 1000 };
const errorsFor = (payload: Record<string, unknown>) =>
  validate(plainToInstance(ProductUnitRequest, payload), { whitelist: true, forbidNonWhitelisted: true });

describe('ProductUnitRequest — trần số', () => {
  it('chấp nhận giá trị hợp lệ', async () => {
    expect(await errorsFor(base)).toHaveLength(0);
  });

  it('giá bán vượt int4 bị từ chối', async () => {
    const errors = await errorsFor({ ...base, salePrice: 2_147_483_648 });
    expect(errors.map((e) => e.property)).toEqual(['salePrice']);
  });

  it('quy đổi quá lớn bị từ chối', async () => {
    const errors = await errorsFor({ ...base, conversionRate: 2_147_483_648 });
    expect(errors.map((e) => e.property)).toEqual(['conversionRate']);
  });
});

describe('ProductExtraFieldsRequest — trần trọng lượng', () => {
  it('weight vượt Decimal(12,3) bị từ chối', async () => {
    expect(await validate(plainToInstance(ProductExtraFieldsRequest, { weight: 12.5 }))).toHaveLength(0);
    const errors = await validate(plainToInstance(ProductExtraFieldsRequest, { weight: 1_000_000_000 }));
    expect(errors.map((e) => e.property)).toEqual(['weight']);
  });
});
