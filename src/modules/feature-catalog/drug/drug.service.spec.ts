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

function makeService(
  repositoryOverrides: Record<string, jest.Mock> = {},
  fetchAll: jest.Mock = jest.fn().mockResolvedValue([]),
) {
  const repository = {
    findManyWithPagination: jest.fn().mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 }),
    findOne: jest.fn(),
    replaceFromSource: jest.fn().mockResolvedValue({ upserted: 0, deactivated: 0 }),
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

  it('chi tiết không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const { service } = makeService({ findOne: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co')).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });
});

describe('DrugService — đồng bộ', () => {
  it('ghi toàn bộ danh mục nguồn kèm người gọi và trả số liệu', async () => {
    const drugs = [sourceDrug('0536-1292'), sourceDrug('64380-799')];
    const replaceFromSource = jest.fn().mockResolvedValue({ upserted: 2, deactivated: 1 });
    const { service } = makeService({ replaceFromSource }, jest.fn().mockResolvedValue(drugs));

    const result = await service.sync('caller-id');

    expect(replaceFromSource).toHaveBeenCalledWith(drugs, expect.any(Date), 'caller-id');
    expect(result).toMatchObject({ total: 2, upserted: 2, deactivated: 1 });
    expect(result.syncedAt).toBeInstanceOf(Date);
  });

  it('nguồn trả rỗng thì huỷ, không chuyển INACTIVE cả danh mục', async () => {
    const replaceFromSource = jest.fn();
    const { service } = makeService({ replaceFromSource }, jest.fn().mockResolvedValue([]));

    await expect(service.sync('caller-id')).rejects.toMatchObject({ errorCode: ErrorCode.DRUG_SOURCE_UNAVAILABLE });
    expect(replaceFromSource).not.toHaveBeenCalled();
  });

  it('nguồn lỗi thì ném nguyên lỗi, không ghi gì', async () => {
    const replaceFromSource = jest.fn();
    const failure = new ErrorException({ code: ErrorCode.DRUG_SOURCE_UNAVAILABLE, message: 'down' });
    const { service } = makeService({ replaceFromSource }, jest.fn().mockRejectedValue(failure));

    await expect(service.sync('caller-id')).rejects.toBe(failure);
    expect(replaceFromSource).not.toHaveBeenCalled();
  });

  it('lọc theo trạng thái khi client gửi', async () => {
    const { service, repository } = makeService();

    await service.list({ page: 1, limit: 10, status: RecordStatus.INACTIVE });

    expect(repository.findManyWithPagination).toHaveBeenCalledWith(
      { status: RecordStatus.INACTIVE },
      expect.anything(),
    );
  });
});
