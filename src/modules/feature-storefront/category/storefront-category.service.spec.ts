import { StorefrontCategoryService } from './storefront-category.service';

describe('StorefrontCategoryService', () => {
  it('trả nguyên danh sách nhóm đọc được từ repository', async () => {
    const rows = [{ id: 'id', name: 'Thuốc không kê đơn', parentId: null, sortOrder: 1 }];
    const repository = { findPublicList: jest.fn().mockResolvedValue(rows) } as never;

    await expect(new StorefrontCategoryService(repository).list()).resolves.toEqual(rows);
  });
});
