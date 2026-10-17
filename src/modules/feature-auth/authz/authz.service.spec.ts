import { UserStatus } from '@prisma/client';
import { SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { ErrorCode } from 'src/common/types/error-code';
import { AuthzService } from './authz.service';

function makeService(prisma: { user: Record<string, jest.Mock>; role: Record<string, jest.Mock> }) {
  return new AuthzService({} as never, {} as never, {} as never, {} as never, prisma as never);
}

describe('AuthzService.seedSystemActor', () => {
  it('tạo dòng users đúng id SYSTEM_ACTOR_ID, INACTIVE, vai trò SUPER_ADMIN', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = makeService({
      user: { findUnique: jest.fn().mockResolvedValue(null), create },
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-sa' }) },
    });

    await service.seedSystemActor();

    const [{ data }] = create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({ id: SYSTEM_ACTOR_ID, roleId: 'role-sa', status: UserStatus.INACTIVE });
  });

  it('chạy lại khi đã có thì không tạo thêm', async () => {
    const create = jest.fn();
    const service = makeService({
      user: { findUnique: jest.fn().mockResolvedValue({ id: SYSTEM_ACTOR_ID }), create },
      role: { findFirst: jest.fn() },
    });

    await service.seedSystemActor();

    expect(create).not.toHaveBeenCalled();
  });

  it('chưa seed vai trò thì báo lỗi rõ ràng, không tạo gì', async () => {
    const create = jest.fn();
    const service = makeService({
      user: { findUnique: jest.fn().mockResolvedValue(null), create },
      role: { findFirst: jest.fn().mockResolvedValue(null) },
    });

    await expect(service.seedSystemActor()).rejects.toMatchObject({ errorCode: ErrorCode.ROLE_NOT_FOUND });
    expect(create).not.toHaveBeenCalled();
  });
});
