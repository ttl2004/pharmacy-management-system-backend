import { RecordStatus } from '@prisma/client';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import type { DrugSourceRecord } from './drug-source.client';
import { DrugService } from './drug.service';

const sourceDrug = (code: string): DrugSourceRecord => ({
  code,
  name: `Thuốc ${code}`,
  drugGroup: 'Hóa dược',
  controlType: null,
  isPrescription: true,
  registrationNumber: 'VN-0001',
  registeredAt: '2020-05-13',
  registrationExpiresAt: null,
  strength: '500mg',
  ingredients: 'Paracetamol 500mg',
  manufacturerName: 'Hãng A',
  countryOfOrigin: 'US',
  packagingSpec: 'Hộp 10 vỉ',
  route: 'Uống',
});

const TX = { marker: 'tx' };

function makeService(
  repositoryOverrides: Record<string, jest.Mock> = {},
  fetchAll: jest.Mock = jest.fn().mockResolvedValue([]),
) {
  const repository = {
    findManyWithPagination: jest.fn().mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 }),
    findOne: jest.fn(),
    withSyncLock: jest.fn().mockImplementation((work: (tx: unknown) => unknown) => work(TX)),
    countActive: jest.fn().mockResolvedValue(0),
    upsertAll: jest.fn().mockImplementation((_tx: unknown, drugs: unknown[]) => drugs.length),
    countStale: jest.fn().mockResolvedValue(0),
    deactivateStale: jest.fn().mockResolvedValue(0),
    syncProductPrescription: jest.fn().mockResolvedValue(0),
    ...repositoryOverrides,
  };
  const service = new DrugService(repository as never, { fetchAll } as never);
  return { service, repository };
}

describe('DrugService — danh sách', () => {
  it('mặc định sắp theo tên, tìm trên mã/tên/thành phần/số đăng ký', async () => {
    const { service, repository } = makeService();

    await service.list({ page: 1, limit: 10, search: 'para', isPrescription: false });

    expect(repository.findManyWithPagination).toHaveBeenCalledWith(
      { isPrescription: false },
      expect.objectContaining({
        sort: 'name:asc',
        search: 'para',
        searchFields: ['code', 'name', 'ingredients', 'registrationNumber'],
      }),
    );
  });

  it('lọc theo trạng thái khi client gửi', async () => {
    const { service, repository } = makeService();

    await service.list({ page: 1, limit: 10, status: RecordStatus.INACTIVE });

    expect(repository.findManyWithPagination).toHaveBeenCalledWith(
      { status: RecordStatus.INACTIVE },
      expect.anything(),
    );
  });

  it('chi tiết không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const { service } = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co')).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });
});

describe('DrugService — đồng bộ', () => {
  it('ghi danh mục trong transaction giữ khoá, chuyển INACTIVE thuốc vắng mặt, sửa cờ kê đơn hàng hoá', async () => {
    const drugs = [sourceDrug('0536-1292'), sourceDrug('64380-799')];
    const { service, repository } = makeService(
      {
        countActive: jest.fn().mockResolvedValue(20),
        countStale: jest.fn().mockResolvedValue(1),
        deactivateStale: jest.fn().mockResolvedValue(1),
        syncProductPrescription: jest.fn().mockResolvedValue(3),
      },
      jest.fn().mockResolvedValue(drugs),
    );

    const result = await service.sync('caller-id');

    expect(repository.upsertAll).toHaveBeenCalledWith(TX, drugs, expect.any(Date), 'caller-id');
    const syncedAt = (repository.upsertAll.mock.calls[0] as unknown[])[2] as Date;
    expect(repository.deactivateStale).toHaveBeenCalledWith(TX, syncedAt, 'caller-id');
    expect(repository.syncProductPrescription).toHaveBeenCalledWith(TX, syncedAt, 'caller-id');
    expect(result).toEqual({ total: 2, upserted: 2, deactivated: 1, productsUpdated: 3, syncedAt });
  });

  it('tải nguồn BÊN TRONG khoá — hai lần đồng bộ không thể tải hai snapshot song song', async () => {
    const order: string[] = [];
    const fetchAll = jest.fn().mockImplementation(() => {
      order.push('fetch');
      return [sourceDrug('A')];
    });
    const withSyncLock = jest.fn().mockImplementation((work: (tx: unknown) => unknown) => {
      order.push('lock');
      return work(TX);
    });
    const { service } = makeService({ withSyncLock }, fetchAll);

    await service.sync('caller-id');

    expect(order).toEqual(['lock', 'fetch']);
  });

  it('đang có lần đồng bộ khác thì ném nguyên lỗi khoá, không tải nguồn', async () => {
    const busy = new ErrorException({ code: ErrorCode.DRUG_SYNC_IN_PROGRESS, message: 'busy' });
    const fetchAll = jest.fn();
    const { service } = makeService({ withSyncLock: jest.fn().mockRejectedValue(busy) }, fetchAll);

    await expect(service.sync('caller-id')).rejects.toBe(busy);
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it('nguồn trả rỗng thì huỷ, không ghi gì', async () => {
    const { service, repository } = makeService({}, jest.fn().mockResolvedValue([]));

    await expect(service.sync('caller-id')).rejects.toMatchObject({ errorCode: ErrorCode.DRUG_SOURCE_UNAVAILABLE });
    expect(repository.upsertAll).not.toHaveBeenCalled();
  });

  it('nguồn lỗi thì ném nguyên lỗi, không ghi gì', async () => {
    const failure = new ErrorException({ code: ErrorCode.DRUG_SOURCE_UNAVAILABLE, message: 'down' });
    const { service, repository } = makeService({}, jest.fn().mockRejectedValue(failure));

    await expect(service.sync('caller-id')).rejects.toBe(failure);
    expect(repository.upsertAll).not.toHaveBeenCalled();
  });

  it('sẽ chuyển INACTIVE quá 10% thuốc đang hoạt động thì từ chối (rollback), không deactivate', async () => {
    const { service, repository } = makeService(
      { countActive: jest.fn().mockResolvedValue(100), countStale: jest.fn().mockResolvedValue(11) },
      jest.fn().mockResolvedValue([sourceDrug('A')]),
    );

    await expect(service.sync('caller-id')).rejects.toMatchObject({ errorCode: ErrorCode.DRUG_SYNC_SUSPICIOUS });
    expect(repository.deactivateStale).not.toHaveBeenCalled();
  });

  it('đúng 10% vẫn chạy; force=true thì vượt rào', async () => {
    const drugs = [sourceDrug('A')];
    const atLimit = makeService(
      { countActive: jest.fn().mockResolvedValue(100), countStale: jest.fn().mockResolvedValue(10) },
      jest.fn().mockResolvedValue(drugs),
    );
    await atLimit.service.sync('caller-id');
    expect(atLimit.repository.deactivateStale).toHaveBeenCalled();

    const forced = makeService(
      { countActive: jest.fn().mockResolvedValue(100), countStale: jest.fn().mockResolvedValue(90) },
      jest.fn().mockResolvedValue(drugs),
    );
    await forced.service.sync('caller-id', true);
    expect(forced.repository.deactivateStale).toHaveBeenCalled();
  });

  it('lần đồng bộ đầu (chưa có thuốc nào) không bị rào chặn', async () => {
    const { service, repository } = makeService({}, jest.fn().mockResolvedValue([sourceDrug('A')]));

    await service.sync('caller-id');

    expect(repository.deactivateStale).toHaveBeenCalled();
  });
});
