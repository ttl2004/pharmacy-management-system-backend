import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PriceRowsQuery } from './price-book-rows.request';

describe('PriceRowsQuery — trần trang', () => {
  it('page quá lớn bị từ chối, page hợp lệ qua', async () => {
    expect(await validate(plainToInstance(PriceRowsQuery, { page: '10000', pageSize: '100000' }))).toHaveLength(0);
    const errors = await validate(plainToInstance(PriceRowsQuery, { page: '1e300' }));
    expect(errors.map((e) => e.property)).toEqual(['page']);
  });
});
