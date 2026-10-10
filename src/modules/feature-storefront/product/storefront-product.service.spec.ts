import { DosageForm, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { StorefrontProductService } from './storefront-product.service';

function makeService(repositoryOverrides: Record<string, jest.Mock> = {}) {
  const repository = {
    findPublicPage: jest.fn(),
    findPublicDetail: jest.fn(),
    ...repositoryOverrides,
  } as never;
  return new StorefrontProductService(repository);
}

const emptyPage = { hits: [], total: 0, page: 1, totalPages: 0, limit: 10 };

describe('StorefrontProductService — danh sách', () => {
  it('luôn ép ACTIVE và truyền bộ lọc, phân trang, trường tìm kiếm', async () => {
    const findPublicPage = jest.fn().mockResolvedValue(emptyPage);
    const service = makeService({ findPublicPage });

    await service.list({
      page: 1,
      limit: 10,
      search: 'paracetamol',
      categoryId: 'category-id',
      manufacturerId: 'manufacturer-id',
      dosageForm: DosageForm.TABLET,
      requiresPrescription: false,
    });

    expect(findPublicPage).toHaveBeenCalledWith(
      {
        status: RecordStatus.ACTIVE,
        categoryId: 'category-id',
        manufacturerId: 'manufacturer-id',
        dosageForm: DosageForm.TABLET,
        requiresPrescription: false,
      },
      expect.objectContaining({ search: 'paracetamol', searchFields: ['name', 'activeIngredient'] }),
    );
  });

  it('không gửi bộ lọc nào thì vẫn chỉ trả sản phẩm ACTIVE', async () => {
    const findPublicPage = jest.fn().mockResolvedValue(emptyPage);
    const service = makeService({ findPublicPage });

    await service.list({ page: 1, limit: 10 });

    expect(findPublicPage).toHaveBeenCalledWith({ status: RecordStatus.ACTIVE }, expect.anything());
  });
});

describe('StorefrontProductService — chi tiết', () => {
  it('không tồn tại hoặc đang ngừng bán thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findPublicDetail: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co')).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });

  it('trả nguyên dữ liệu công khai đọc được', async () => {
    const detail = { id: 'id', name: 'Paracetamol', units: [] };
    const service = makeService({ findPublicDetail: jest.fn().mockResolvedValue(detail) });

    await expect(service.getDetail('id')).resolves.toEqual(detail);
  });
});
