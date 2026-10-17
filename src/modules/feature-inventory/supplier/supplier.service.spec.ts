import { AuditAction, RecordStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { SupplierService } from './supplier.service';

const ADMIN: RequestActor = {
  user: { userId: 'admin-1', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
};

const EXISTING = {
  id: 'sup-1',
  code: 'NCC001',
  name: 'Dược TW1',
  phone: '0900',
  email: null,
  address: null,
  taxCode: null,
  contactName: null,
  note: null,
  status: RecordStatus.ACTIVE,
};

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findActiveWith: jest.fn().mockResolvedValue(EXISTING),
    createWith: jest
      .fn()
      .mockImplementation((_tx: unknown, data: object) => Promise.resolve({ id: 'sup-new', ...data })),
    updateWith: jest
      .fn()
      .mockImplementation((_tx: unknown, _id: string, data: object) => Promise.resolve({ ...EXISTING, ...data })),
    countReferences: jest.fn().mockResolvedValue(0),
    ...repositoryOverrides,
  };
  const transactions = { run: jest.fn((work: (ctx: unknown) => unknown) => work({ tx: {}, afterCommit: jest.fn() })) };
  const audit = { record: jest.fn() };
  return {
    service: new SupplierService(repository as never, transactions as never, audit as never),
    repository,
    audit,
  };
}

describe('SupplierService', () => {
  it('tạo: ghi createdBy là người gọi và một dòng nhật ký CREATE kèm IP', async () => {
    const { service, repository, audit } = makeService();

    await service.create({ code: 'NCC002', name: 'NCC', phone: '0901' }, ADMIN);

    expect(repository.createWith).toHaveBeenCalledWith({}, expect.objectContaining({ createdBy: 'admin-1' }));
    const [, entries] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(entries[0]).toMatchObject({ action: AuditAction.CREATE, entityType: 'suppliers', ipAddress: '10.0.0.1' });
  });

  it('sửa: nhật ký chỉ chứa trường thực sự đổi; đổi status thì ghi STATUS_CHANGE', async () => {
    const { service, audit } = makeService();

    await service.update('sup-1', { name: 'Dược TW1', status: RecordStatus.INACTIVE }, ADMIN);

    const [, entries] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>[]];
    expect(entries[0]).toMatchObject({
      action: AuditAction.STATUS_CHANGE,
      before: { status: 'ACTIVE' },
      after: { status: 'INACTIVE' },
    });
  });

  it('sửa không đổi gì thì không ghi nhật ký rỗng', async () => {
    const { service, audit } = makeService();
    await service.update('sup-1', { name: 'Dược TW1' }, ADMIN);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('xoá nhà cung cấp đã có chứng từ → 1602, không xoá', async () => {
    const { service, repository } = makeService({ countReferences: jest.fn().mockResolvedValue(3) });
    await expect(service.remove('sup-1', ADMIN)).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
    expect(repository.updateWith).not.toHaveBeenCalled();
  });

  it('không tồn tại → 1600', async () => {
    const { service } = makeService({ findActiveWith: jest.fn().mockResolvedValue(null) });
    await expect(service.update('x', { name: 'A' }, ADMIN)).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });
});
