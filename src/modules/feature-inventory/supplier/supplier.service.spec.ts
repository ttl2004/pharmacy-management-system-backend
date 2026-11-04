import { RecordStatus } from '@prisma/client';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { SupplierService } from './supplier.service';

const ADMIN: RequestActor = {
  user: { userId: 'admin-1', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: null,
};

const EXISTING = {
  id: 'sup-1',
  code: 'NCC001',
  name: 'Dược TW1',
  phone: '0901234567',
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
  it('tạo: ghi createdBy là người gọi và một dòng SUPPLIER.CREATED, nhãn = mã, SĐT đã che', async () => {
    const { service, repository, audit } = makeService();

    await service.create({ code: 'NCC002', name: 'NCC', phone: '0901234567' }, ADMIN);

    expect(repository.createWith).toHaveBeenCalledWith({}, expect.objectContaining({ createdBy: 'admin-1' }));
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, actor, entries] = audit.record.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      Record<string, unknown>[],
    ];
    expect(actor).toMatchObject({ userId: 'admin-1', type: 'USER', ip: '10.0.0.1' });
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'SUPPLIER.CREATED',
        entityType: 'suppliers',
        entityId: 'sup-new',
        entityLabel: 'NCC002',
        branchIds: [],
        searchTerms: ['NCC002', 'NCC'],
      }),
    ]);
    const after = entries[0].after as Record<string, unknown>;
    expect(after.code).toBe('NCC002');
    expect(after.phone).not.toBe('0901234567');
    expect(String(after.phone)).toMatch(/4567$/);
  });

  it('sửa: nhật ký chỉ chứa trường thực sự đổi; đổi status thì ghi SUPPLIER.STATUS_CHANGED', async () => {
    const { service, audit } = makeService();

    await service.update('sup-1', { name: 'Dược TW1', status: RecordStatus.INACTIVE }, ADMIN);

    const [, , entries] = audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]];
    expect(entries).toEqual([
      {
        event: 'SUPPLIER.STATUS_CHANGED',
        entityType: 'suppliers',
        entityId: 'sup-1',
        entityLabel: 'NCC001',
        branchIds: [],
        before: { status: 'ACTIVE' },
        after: { status: 'INACTIVE' },
        searchTerms: ['NCC001', 'Dược TW1'],
      },
    ]);
  });

  it('sửa tên ghi SUPPLIER.UPDATED; đổi SĐT thì trước/sau đều đã che', async () => {
    const { service, audit } = makeService();

    await service.update('sup-1', { name: 'Dược TW2', phone: '0987654321' }, ADMIN);

    const [, , entries] = audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]];
    expect(entries[0]).toMatchObject({ event: 'SUPPLIER.UPDATED', searchTerms: ['NCC001', 'Dược TW2'] });
    const { before, after } = entries[0] as { before: Record<string, string>; after: Record<string, string> };
    expect(before.name).toBe('Dược TW1');
    expect(after.name).toBe('Dược TW2');
    expect(before.phone).toMatch(/4567$/);
    expect(before.phone).not.toBe('0901234567');
    expect(after.phone).toMatch(/4321$/);
    expect(after.phone).not.toBe('0987654321');
  });

  it('xoá ghi SUPPLIER.DELETED với ảnh chụp trước', async () => {
    const { service, audit } = makeService();

    await service.remove('sup-1', ADMIN);

    const [, , entries] = audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]];
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'SUPPLIER.DELETED',
        entityId: 'sup-1',
        entityLabel: 'NCC001',
        branchIds: [],
        before: expect.objectContaining({ code: 'NCC001', name: 'Dược TW1' }) as unknown,
      }),
    ]);
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

  describe('không ghi CCCD / email thô', () => {
    const ID = '079123456789';
    const MAIL = 'an.nguyen@nhacungcap.vn';
    const entriesOf = (audit: { record: jest.Mock }) => (audit.record.mock.calls[0] as unknown[])[2] as unknown[];

    it('SUPPLIER.CREATED: bỏ idNumber (ghi tên trường), che email', async () => {
      const { service, audit } = makeService();
      await service.create({ code: 'NCC002', name: 'NCC', phone: '0901234567', email: MAIL, idNumber: ID }, ADMIN);
      const json = JSON.stringify(entriesOf(audit));
      expect(json).not.toContain(ID);
      expect(json).not.toContain(MAIL);
      expect(entriesOf(audit)[0]).toMatchObject({
        after: { email: 'a***@nhacungcap.vn' },
        metadata: { changedFields: ['idNumber'] },
      });
    });

    it('SUPPLIER.UPDATED: đổi idNumber/email chỉ để lại tên trường và email đã che', async () => {
      const { service, audit } = makeService({
        findActiveWith: jest.fn().mockResolvedValue({ ...EXISTING, email: 'cu@x.vn', idNumber: '011111111111' }),
      });
      await service.update('sup-1', { idNumber: ID, email: MAIL }, ADMIN);
      const json = JSON.stringify(entriesOf(audit));
      for (const raw of [ID, '011111111111', MAIL, 'cu@x.vn']) expect(json).not.toContain(raw);
      expect(entriesOf(audit)[0]).toMatchObject({
        event: 'SUPPLIER.UPDATED',
        metadata: { changedFields: ['idNumber'] },
      });
    });

    it('SUPPLIER.UPDATED: không đổi idNumber thì không có metadata', async () => {
      const { service, audit } = makeService();
      await service.update('sup-1', { name: 'Tên mới' }, ADMIN);
      expect(entriesOf(audit)[0]).not.toHaveProperty('metadata');
    });

    it('SUPPLIER.DELETED: ảnh chụp trước không chứa idNumber/email thô', async () => {
      const { service, audit } = makeService({
        findActiveWith: jest.fn().mockResolvedValue({ ...EXISTING, email: MAIL, idNumber: ID }),
      });
      await service.remove('sup-1', ADMIN);
      const json = JSON.stringify(entriesOf(audit));
      expect(json).not.toContain(ID);
      expect(json).not.toContain(MAIL);
    });
  });
});
