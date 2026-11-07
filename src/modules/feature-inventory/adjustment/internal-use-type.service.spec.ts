import { ErrorCode } from 'src/common/types/error-code';
import { ADMIN_ACTOR, entriesOf } from 'src/test-support/audit-harness';
import { InternalUseTypeService } from './internal-use-type.service';

const audit = { record: jest.fn() };
beforeEach(() => audit.record.mockClear());

function makeService(over: Record<string, unknown> = {}) {
  const model = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'iut-1', ...data })),
    update: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'iut-1', ...data })),
    ...over,
  };
  const tx = { internalUseType: model, stockAdjustment: { count: jest.fn().mockResolvedValue(0) } };
  const prisma = {
    internalUseType: model,
    stockAdjustment: tx.stockAdjustment,
    $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)),
  };
  return new InternalUseTypeService(prisma as never, audit as never);
}

describe('InternalUseTypeService — nhật ký', () => {
  it('create ghi INTERNAL_USE_TYPE.CREATED, branchIds []', async () => {
    const service = makeService();

    await service.create({ name: 'Văn phòng phẩm' }, ADMIN_ACTOR);

    expect(entriesOf(audit)).toEqual([
      expect.objectContaining({
        event: 'INTERNAL_USE_TYPE.CREATED',
        entityType: 'internal_use_types',
        entityId: 'iut-1',
        entityLabel: 'Văn phòng phẩm',
        branchIds: [],
        after: { name: 'Văn phòng phẩm' },
      }),
    ]);
  });

  it('internal-use-type update ghi INTERNAL_USE_TYPE.UPDATED kèm diff name', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'iut-1', name: 'Cũ' }) // mustExist (đọc kèm name)
      .mockResolvedValueOnce(null); // assertNameFree
    const service = makeService({ findFirst });

    await service.update('iut-1', { name: 'Mới' }, ADMIN_ACTOR);

    expect(entriesOf(audit)).toEqual([
      expect.objectContaining({
        event: 'INTERNAL_USE_TYPE.UPDATED',
        entityId: 'iut-1',
        entityLabel: 'Mới',
        branchIds: [],
        before: { name: 'Cũ' },
        after: { name: 'Mới' },
      }),
    ]);
  });

  it('update giữ nguyên tên thì không ghi entry', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({ id: 'iut-1', name: 'Cũ' }).mockResolvedValueOnce(null);
    const service = makeService({ findFirst });

    await service.update('iut-1', { name: 'Cũ' }, ADMIN_ACTOR);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('remove ghi INTERNAL_USE_TYPE.DELETED với tên gốc (không phải tên đã đổi để giải phóng unique)', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'iut-1', name: 'Cũ' });
    const service = makeService({ findFirst });

    await service.remove('iut-1', ADMIN_ACTOR);

    expect(entriesOf(audit)).toEqual([
      expect.objectContaining({
        event: 'INTERNAL_USE_TYPE.DELETED',
        entityLabel: 'Cũ',
        branchIds: [],
        before: { name: 'Cũ' },
      }),
    ]);
  });

  it('loại đã có phiếu dùng thì từ chối và không ghi nhật ký', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'iut-1', name: 'Cũ' });
    const service = makeService({ findFirst });
    (
      service as unknown as { prisma: { stockAdjustment: { count: jest.Mock } } }
    ).prisma.stockAdjustment.count.mockResolvedValue(1);

    await expect(service.remove('iut-1', ADMIN_ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
