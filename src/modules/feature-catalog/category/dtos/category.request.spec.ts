import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCategoryRequest, UpdateCategoryRequest } from './category.request';

describe('DTO nhóm hàng — trần sortOrder', () => {
  it.each([CreateCategoryRequest, UpdateCategoryRequest])('%p từ chối sortOrder vượt int4', async (cls) => {
    const errors = await validate(plainToInstance(cls, { name: 'Thuốc', sortOrder: 2_147_483_648 }));
    expect(errors.map((e) => e.property)).toContain('sortOrder');
  });
});
