import { StorefrontManufacturerService } from './storefront-manufacturer.service';

describe('StorefrontManufacturerService', () => {
  it('trả nguyên danh sách hãng đọc được từ repository', async () => {
    const rows = [{ id: 'id', name: 'Dược Hậu Giang', country: 'Việt Nam' }];
    const repository = { findPublicList: jest.fn().mockResolvedValue(rows) } as never;

    await expect(new StorefrontManufacturerService(repository).list()).resolves.toEqual(rows);
  });
});
