import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductQuery } from 'src/modules/feature-catalog/product/dtos/product.query';
import { BranchProductListQuery } from './branch-product-list.query';

const UUID = '3f6c1a52-6b1e-4c1a-9a3e-2d5b8f0e7a11';
const UUID2 = '4f6c1a52-6b1e-4c1a-9a3e-2d5b8f0e7a12';
const parse = (payload: Record<string, unknown>) => plainToInstance(BranchProductListQuery, payload);
const errorsFor = async (payload: Record<string, unknown>) =>
  (await validate(parse(payload), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

describe('BranchProductListQuery — tham số query từ FE', () => {
  it('mảng nối dấu phẩy, boolean chuỗi, số chuỗi', async () => {
    const q = parse({
      categoryIds: `${UUID},${UUID2}`,
      statuses: 'ACTIVE',
      types: 'DRUG,GOODS',
      dosageForms: 'TABLET',
      supplierIds: UUID,
      locationIds: `none,${UUID}`,
      isPrescriptionOnly: 'false',
      trackLots: 'true',
      stockFilter: 'custom',
      stockOp: 'gte',
      stockValue: '10',
      sortBy: 'stockoutDate',
      sortDir: 'desc',
      page: '2',
      limit: '50',
    });
    expect(q).toMatchObject({
      categoryIds: [UUID, UUID2],
      statuses: ['ACTIVE'],
      types: ['DRUG', 'GOODS'],
      locationIds: ['none', UUID],
      isPrescriptionOnly: false,
      trackLots: true,
      stockValue: 10,
      page: 2,
      limit: 50,
    });
    expect(await validate(q, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });

  it('giá trị sai → 400 thay vì lỗi SQL', async () => {
    expect(await errorsFor({ statuses: 'active' })).toEqual(['statuses']); // enum theo BE (ACTIVE)
    expect(await errorsFor({ locationIds: 'abc' })).toEqual(['locationIds']);
    expect(await errorsFor({ supplierIds: 'x' })).toEqual(['supplierIds']);
    expect(await errorsFor({ stockFilter: 'low' })).toEqual(['stockFilter']);
    expect(await errorsFor({ sortBy: 'foo' })).toEqual(['sortBy']);
    expect(await errorsFor({ createdFrom: '26/11/2026' })).toEqual(['createdFrom']);
    expect(await errorsFor({ isPrescriptionOnly: 'yes' })).toEqual(['isPrescriptionOnly']);
    expect(await errorsFor({ limit: '101' })).toEqual(['limit']);
  });

  it('GET /product: sortBy chỉ nhận cột danh mục (không có cột kho)', async () => {
    const errors = await validate(plainToInstance(ProductQuery, { sortBy: 'qtyOnHand' }));
    expect(errors.map((e) => e.property)).toEqual(['sortBy']);
    expect(await validate(plainToInstance(ProductQuery, { sortBy: 'price', q: 'para' }))).toHaveLength(0);
  });
});
