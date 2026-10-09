import { ErrorCode } from 'src/common/types/error-code';
import { UserService } from './user.service';

/**
 * Repository giả — chỉ cắm đúng những method mà service gọi.
 * `findByIdWithRole` có mặc định vì gần như mọi luật bảo vệ đều tra vai trò của bản ghi đích trước.
 */
function makeService(
  repositoryOverrides: Record<string, jest.Mock> = {},
  sessionOverrides: Record<string, jest.Mock> = {},
) {
  const repository = {
    findRoleIdByCode: jest.fn(),
    findByIdWithRole: jest.fn().mockResolvedValue({ id: 'target', role: { code: 'SALES_STAFF' } }),
    ...repositoryOverrides,
  } as never;
  const prisma = { role: { findFirst: jest.fn() }, branch: { findFirst: jest.fn() } } as never;
  const transactions = { write: jest.fn((work: (tx: unknown) => unknown) => work({})) } as never;
  const sessions = {
    revokeAllByUser: jest.fn().mockResolvedValue(undefined),
    ...sessionOverrides,
  } as never;
  return new UserService(repository, prisma, transactions, sessions);
}

describe('UserService — danh sách người dùng', () => {
  it('không truyền roleCode thì không lọc theo vai trò', async () => {
    const findManyWithPagination = jest.fn().mockResolvedValue({
      hits: [],
      total: 0,
      page: 1,
      totalPages: 0,
      limit: 10,
    });
    const service = makeService({ findManyWithPagination });
    await service.list({ page: 1, limit: 10 });
    expect(findManyWithPagination).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ searchFields: ['phoneNumber', 'fullName', 'email'] }),
    );
  });
});
