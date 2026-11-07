import { DosageForm, Prisma, ProductType, RecordStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { ProductService } from './product.service';
import { DRUG_INGREDIENTS_SEARCH_FIELD } from './repositories/product.repository';

const ACTOR: RequestActor = {
  user: { userId: 'caller-id', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

type AuditMock = { record: jest.Mock };
const makeAudit = (): AuditMock => ({ record: jest.fn().mockResolvedValue(undefined) });

/** Các entry của lần `record` duy nhất. */
function recordedEntries(audit: AuditMock): Record<string, unknown>[] {
  expect(audit.record).toHaveBeenCalledTimes(1);
  return (audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]])[2];
}

function makeService(
  repositoryOverrides: Record<string, jest.Mock> = {},
  transactionOverrides: Record<string, jest.Mock> = {},
  audit: AuditMock = makeAudit(),
) {
  const repository = {
    findPageWithSummary: jest.fn(),
    findDetail: jest.fn(),
    findDetailWith: jest.fn(),
    findActiveCategory: jest.fn().mockResolvedValue({ id: 'category-id' }),
    findActiveManufacturer: jest.fn().mockResolvedValue({ id: 'manufacturer-id' }),
    findUnits: jest.fn().mockImplementation((_client: unknown, ids: string[]) => ids.map((id) => ({ id }))),
    findBarcodeConflict: jest.fn().mockResolvedValue(null),
    createProduct: jest.fn().mockResolvedValue({ id: 'product-id' }),
    createUnits: jest.fn().mockResolvedValue(undefined),
    findUnitsForReconcile: jest.fn().mockResolvedValue([]),
    updateProduct: jest.fn().mockResolvedValue(1),
    updateUnit: jest.fn().mockResolvedValue(undefined),
    softDeleteUnits: jest.fn().mockResolvedValue(undefined),
    softDeleteProduct: jest.fn().mockResolvedValue(undefined),
    hasInventoryHistory: jest.fn().mockResolvedValue(false),
    hasOpenInventory: jest.fn().mockResolvedValue(false),
    findActiveDrug: jest.fn().mockResolvedValue({ id: 'drug-id', isPrescription: false }),
    findPacksByDrug: jest.fn().mockResolvedValue([]),
    replaceLocations: jest.fn().mockResolvedValue(undefined),
    ...repositoryOverrides,
  } as never;
  const transactions = {
    // `$executeRaw` cho khoá advisory theo thuốc khi chống trùng.
    write: jest
      .fn()
      .mockImplementation((_locks: string[], work: (tx: unknown) => unknown) =>
        work({ $executeRaw: jest.fn().mockResolvedValue(0) }),
      ),
    ...transactionOverrides,
  } as never;
  return new ProductService(repository, transactions, audit as never);
}

function duplicateError(target = 'code'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: [target] },
  });
}

const validCreatePayload = (overrides: Record<string, unknown> = {}) =>
  ({
    code: 'SP0001',
    name: 'Paracetamol 500mg',
    categoryId: 'category-id',
    baseUnitId: 'unit-vien',
    drugId: 'drug-id',
    units: [
      { unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true },
      { unitId: 'unit-vi', conversionRate: 10, salePrice: 4500, isBaseUnit: false },
    ],
    ...overrides,
  }) as never;

describe('ProductService — danh sách', () => {
  it('truyền đúng bộ lọc, phân trang và bốn trường tìm kiếm', async () => {
    const findPageWithSummary = jest.fn().mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 });
    const service = makeService({ findPageWithSummary });

    await service.list({
      page: 1,
      limit: 10,
      search: 'paracetamol',
      categoryId: 'category-id',
      manufacturerId: 'manufacturer-id',
      baseUnitId: 'unit-id',
      status: RecordStatus.ACTIVE,
      dosageForm: DosageForm.TABLET,
      requiresPrescription: false,
    });

    expect(findPageWithSummary).toHaveBeenCalledWith(
      {
        categoryId: 'category-id',
        manufacturerId: 'manufacturer-id',
        baseUnitId: 'unit-id',
        status: RecordStatus.ACTIVE,
        dosageForm: DosageForm.TABLET,
        requiresPrescription: false,
      },
      expect.objectContaining({
        page: 1,
        limit: 10,
        search: 'paracetamol',
        searchFields: ['code', 'barcode', 'name', DRUG_INGREDIENTS_SEARCH_FIELD],
      }),
    );
  });

  it('requiresPrescription = false vẫn được áp vào bộ lọc', async () => {
    const findPageWithSummary = jest.fn().mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 });
    const service = makeService({ findPageWithSummary });

    await service.list({ page: 1, limit: 10, requiresPrescription: false });

    expect(findPageWithSummary).toHaveBeenCalledWith({ requiresPrescription: false }, expect.anything());
  });

  it('không gửi bộ lọc thì không lọc gì', async () => {
    const findPageWithSummary = jest.fn().mockResolvedValue({ hits: [], total: 0, page: 1, totalPages: 0, limit: 10 });
    const service = makeService({ findPageWithSummary });

    await service.list({ page: 1, limit: 10 });

    expect(findPageWithSummary).toHaveBeenCalledWith({}, expect.anything());
  });
});

describe('ProductService — chi tiết', () => {
  it('không tồn tại thì báo RECORD_NOT_FOUND', async () => {
    const service = makeService({ findDetail: jest.fn().mockResolvedValue(null) });

    await expect(service.getDetail('khong-co')).rejects.toMatchObject({ errorCode: ErrorCode.RECORD_NOT_FOUND });
  });

  it('trả nguyên aggregate đọc được từ repository', async () => {
    const detail = { id: 'id', units: [{ id: 'unit-row' }] };
    const service = makeService({ findDetail: jest.fn().mockResolvedValue(detail) });

    await expect(service.getDetail('id')).resolves.toEqual(detail);
  });
});

describe('ProductService — tạo', () => {
  it('tạo Product và các ProductUnit trong một transaction rồi trả chi tiết', async () => {
    const detail = { id: 'product-id', units: [] };
    const createProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const createUnits = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      createProduct,
      createUnits,
      findDetailWith: jest.fn().mockResolvedValue(detail),
    });

    await expect(service.create(validCreatePayload(), ACTOR)).resolves.toEqual(detail);

    expect(createProduct).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: 'SP0001', createdBy: 'caller-id', status: RecordStatus.ACTIVE }),
    );
    expect(createUnits).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true }),
      expect.objectContaining({ unitId: 'unit-vi', conversionRate: 10, salePrice: 4500, isBaseUnit: false }),
    ]);
  });

  it('không gửi manufacturer thì lưu null', async () => {
    const createProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const service = makeService({
      createProduct,
      findDetailWith: jest.fn().mockResolvedValue({ id: 'product-id' }),
    });

    await service.create(validCreatePayload(), ACTOR);

    expect(createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ manufacturerId: null }));
  });

  it('nhóm sản phẩm không tồn tại hoặc đã ngừng hoạt động thì báo INVALID_REFERENCE', async () => {
    const service = makeService({ findActiveCategory: jest.fn().mockResolvedValue(null) });

    await expect(service.create(validCreatePayload(), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('hãng sản xuất không hợp lệ thì báo INVALID_REFERENCE', async () => {
    const service = makeService({ findActiveManufacturer: jest.fn().mockResolvedValue(null) });

    await expect(
      service.create(validCreatePayload({ manufacturerId: 'manufacturer-id' }), ACTOR),
    ).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
  });

  it('đơn vị không tồn tại hoặc đã xoá mềm thì báo INVALID_REFERENCE', async () => {
    const service = makeService({ findUnits: jest.fn().mockResolvedValue([{ id: 'unit-vien' }]) });

    await expect(service.create(validCreatePayload(), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('không có dòng nào là đơn vị cơ bản thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(
      service.create(
        validCreatePayload({
          units: [
            { unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: false },
            { unitId: 'unit-vi', conversionRate: 10, salePrice: 4500, isBaseUnit: false },
          ],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('có hai dòng đơn vị cơ bản thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(
      service.create(
        validCreatePayload({
          units: [
            { unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true },
            { unitId: 'unit-vi', conversionRate: 1, salePrice: 4500, isBaseUnit: true },
          ],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('dòng cơ bản không khớp baseUnitId thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(
      service.create(
        validCreatePayload({
          units: [
            { unitId: 'unit-hop', conversionRate: 1, salePrice: 42000, isBaseUnit: true },
            { unitId: 'unit-vi', conversionRate: 10, salePrice: 4500, isBaseUnit: false },
          ],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('đơn vị cơ bản có conversionRate khác 1 thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(
      service.create(
        validCreatePayload({
          units: [
            { unitId: 'unit-vien', conversionRate: 10, salePrice: 500, isBaseUnit: true },
            { unitId: 'unit-vi', conversionRate: 1, salePrice: 4500, isBaseUnit: false },
          ],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('trùng unitId trong payload thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(
      service.create(
        validCreatePayload({
          units: [
            { unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true },
            { unitId: 'unit-vien', conversionRate: 10, salePrice: 4500, isBaseUnit: false },
          ],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('barcode sản phẩm trùng barcode một dòng đơn vị bán thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(
      service.create(
        validCreatePayload({
          barcode: '8935000002',
          units: [{ unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true, barcode: '8935000002' }],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('trùng barcode giữa các dòng units thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(
      service.create(
        validCreatePayload({
          units: [
            { unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true, barcode: '8935000001' },
            { unitId: 'unit-vi', conversionRate: 10, salePrice: 4500, isBaseUnit: false, barcode: '8935000001' },
          ],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('barcode đã dùng ở bảng khác thì báo DUPLICATE_CODE', async () => {
    const service = makeService({
      findBarcodeConflict: jest.fn().mockResolvedValue({ barcode: '8935000001', source: 'product_units' }),
    });

    await expect(service.create(validCreatePayload({ barcode: '8935000001' }), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });

  it('trùng code sản phẩm thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ createProduct: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.create(validCreatePayload(), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });

  it('ghi ProductUnit lỗi thì lỗi ném ra ngoài, không trả chi tiết', async () => {
    const findDetailWith = jest.fn();
    const service = makeService({
      createUnits: jest.fn().mockRejectedValue(new Error('insert failed')),
      findDetailWith,
    });

    await expect(service.create(validCreatePayload(), ACTOR)).rejects.toThrow('insert failed');
    expect(findDetailWith).not.toHaveBeenCalled();
  });
});

const existingProduct = {
  id: 'product-id',
  code: 'SP0001',
  barcode: '8935000000',
  categoryId: 'category-id',
  manufacturerId: null,
  baseUnitId: 'unit-vien',
  type: ProductType.DRUG,
  drugId: null as string | null,
  drug: null as { id: string; isPrescription: boolean } | null,
  indications: null as string | null,
  dosageNote: null as string | null,
  storageNote: null as string | null,
  units: [] as { conversionRate: number; unit: { id: string } }[],
};

describe('ProductService — liên kết danh mục thuốc (luật A)', () => {
  it('tạo hàng DRUG không gửi drugId thì báo INVALID_REFERENCE, không ghi gì', async () => {
    const createProduct = jest.fn();
    const service = makeService({ createProduct });

    await expect(service.create(validCreatePayload({ drugId: undefined }), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('tạo hàng DRUG gửi drugId null cũng bị từ chối', async () => {
    const service = makeService({});

    await expect(service.create(validCreatePayload({ drugId: null }), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('thuốc không tồn tại hoặc đã INACTIVE thì báo INVALID_REFERENCE', async () => {
    const service = makeService({ findActiveDrug: jest.fn().mockResolvedValue(null) });

    await expect(service.create(validCreatePayload(), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('tạo hàng DRUG hợp lệ thì lưu drugId', async () => {
    const createProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const service = makeService({ createProduct, findDetailWith: jest.fn().mockResolvedValue({ id: 'product-id' }) });

    await service.create(validCreatePayload(), ACTOR);

    expect(createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ drugId: 'drug-id' }));
  });

  it('hàng GOODS không cần drugId; gửi drugId thì báo HTTP_BAD_REQUEST', async () => {
    const createProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const service = makeService({ createProduct, findDetailWith: jest.fn().mockResolvedValue({ id: 'product-id' }) });

    await service.create(validCreatePayload({ type: ProductType.GOODS, drugId: undefined }), ACTOR);
    expect(createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ drugId: null }));

    await expect(service.create(validCreatePayload({ type: ProductType.GOODS }), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('sửa: hàng DRUG đã liên kết không được bỏ liên kết', async () => {
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue({ ...existingProduct, drugId: 'drug-id' }),
    });

    await expect(service.update('product-id', { drugId: null }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('sửa: hàng DRUG cũ chưa liên kết vẫn sửa trường khác bình thường, không kiểm danh mục', async () => {
    const findActiveDrug = jest.fn();
    const updateProduct = jest.fn().mockResolvedValue(1);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findActiveDrug,
      updateProduct,
    });

    await service.update('product-id', { name: 'Tên mới' }, ACTOR);

    expect(findActiveDrug).not.toHaveBeenCalled();
    expect(updateProduct).toHaveBeenCalled();
  });

  it('sửa: gắn liên kết cho hàng DRUG cũ thì kiểm thuốc ACTIVE rồi ghi drugId', async () => {
    const updateProduct = jest.fn().mockResolvedValue(1);
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct), updateProduct });

    await service.update('product-id', { drugId: 'drug-id' }, ACTOR);

    expect(updateProduct).toHaveBeenCalledWith(
      expect.anything(),
      'product-id',
      expect.objectContaining({ drugId: 'drug-id' }),
    );
  });

  it('sửa: đổi sang thuốc khác khi đã phát sinh kho thì báo PRODUCT_HAS_STOCK, không ghi gì', async () => {
    const updateProduct = jest.fn();
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue({ ...existingProduct, drugId: 'drug-id' }),
      hasInventoryHistory: jest.fn().mockResolvedValue(true),
      updateProduct,
    });

    await expect(service.update('product-id', { drugId: 'drug-khac' }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.PRODUCT_HAS_STOCK,
    });
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it('sửa: gắn lần đầu cho hàng cũ đã có kho vẫn được — chưa có thuốc nào để nhầm', async () => {
    const hasInventoryHistory = jest.fn().mockResolvedValue(true);
    const updateProduct = jest.fn().mockResolvedValue(1);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      hasInventoryHistory,
      updateProduct,
    });

    await service.update('product-id', { drugId: 'drug-id' }, ACTOR);

    expect(hasInventoryHistory).not.toHaveBeenCalled();
    expect(updateProduct).toHaveBeenCalled();
  });
});

describe('ProductService — cờ kê đơn theo danh mục thuốc', () => {
  const prescriptionDrug = { id: 'drug-id', isPrescription: true };

  it('tạo: không gửi cờ kê đơn thì lấy theo thuốc trong danh mục', async () => {
    const createProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const service = makeService({
      createProduct,
      findActiveDrug: jest.fn().mockResolvedValue(prescriptionDrug),
      findDetailWith: jest.fn().mockResolvedValue({ id: 'product-id' }),
    });

    await service.create(validCreatePayload(), ACTOR);

    expect(createProduct).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requiresPrescription: true }),
    );
  });

  it('tạo: thuốc kê đơn mà gửi requiresPrescription=false thì báo HTTP_BAD_REQUEST, không ghi gì', async () => {
    const createProduct = jest.fn();
    const service = makeService({ createProduct, findActiveDrug: jest.fn().mockResolvedValue(prescriptionDrug) });

    await expect(service.create(validCreatePayload({ requiresPrescription: false }), ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('sửa: hàng đã liên kết chỉ gửi cờ kê đơn ngược danh mục thì bị từ chối', async () => {
    const updateProduct = jest.fn();
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue({ ...existingProduct, drugId: 'drug-id', drug: prescriptionDrug }),
      updateProduct,
    });

    await expect(service.update('product-id', { requiresPrescription: false }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it('sửa: gắn thuốc kê đơn cho hàng cũ thì cờ kê đơn đổi theo danh mục', async () => {
    const updateProduct = jest.fn().mockResolvedValue(1);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findActiveDrug: jest.fn().mockResolvedValue(prescriptionDrug),
      updateProduct,
    });

    await service.update('product-id', { drugId: 'drug-id' }, ACTOR);

    expect(updateProduct).toHaveBeenCalledWith(
      expect.anything(),
      'product-id',
      expect.objectContaining({ drugId: 'drug-id', requiresPrescription: true }),
    );
  });

  it('hàng DRUG cũ chưa liên kết vẫn tự nhập cờ kê đơn', async () => {
    const updateProduct = jest.fn().mockResolvedValue(1);
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct), updateProduct });

    await service.update('product-id', { requiresPrescription: true }, ACTOR);

    expect(updateProduct).toHaveBeenCalledWith(
      expect.anything(),
      'product-id',
      expect.objectContaining({ requiresPrescription: true }),
    );
  });
});

describe('ProductService — điền sẵn từ danh mục thuốc', () => {
  const drugWithTexts = {
    id: 'drug-id',
    isPrescription: false,
    indications: 'Giảm đau, hạ sốt',
    dosage: '1 viên/lần',
    storage: 'Nơi khô ráo',
  };

  it('tạo: không gửi chỉ định/liều/bảo quản thì lấy từ thuốc; gửi thì dùng của ADMIN', async () => {
    const createProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const service = makeService({
      createProduct,
      findActiveDrug: jest.fn().mockResolvedValue(drugWithTexts),
      findDetailWith: jest.fn().mockResolvedValue({ id: 'product-id' }),
    });

    await service.create(validCreatePayload({ dosageNote: 'Trẻ em nửa viên' }), ACTOR);

    expect(createProduct).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        indications: 'Giảm đau, hạ sốt',
        dosageNote: 'Trẻ em nửa viên',
        storageNote: 'Nơi khô ráo',
      }),
    );
  });

  it('sửa: gắn thuốc lần đầu chỉ điền ô đang trống, không đè nội dung đã có', async () => {
    const updateProduct = jest.fn().mockResolvedValue(1);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue({
        ...existingProduct,
        indications: 'Ghi chú cũ của ADMIN',
        dosageNote: null,
        storageNote: null,
        units: [],
      }),
      findActiveDrug: jest.fn().mockResolvedValue(drugWithTexts),
      updateProduct,
    });

    await service.update('product-id', { drugId: 'drug-id' }, ACTOR);

    const data = (updateProduct.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(data).not.toHaveProperty('indications');
    expect(data).toMatchObject({ dosageNote: '1 viên/lần', storageNote: 'Nơi khô ráo' });
  });
});

describe('ProductService — chống trùng thuốc + bộ đơn vị', () => {
  const pack = (code: string, units: [string, number][]) => ({
    code,
    units: units.map(([unitId, conversionRate]) => ({ unitId, conversionRate })),
  });
  // Cùng bộ đơn vị với validCreatePayload: viên ×1, vỉ ×10.
  const samePack = pack('SP0099', [
    ['unit-vi', 10],
    ['unit-vien', 1],
  ]);

  it('tạo: cùng thuốc và cùng bộ đơn vị (khác thứ tự) thì báo DUPLICATE_CODE, không ghi gì', async () => {
    const createProduct = jest.fn();
    const service = makeService({ createProduct, findPacksByDrug: jest.fn().mockResolvedValue([samePack]) });

    const attempt = service.create(validCreatePayload(), ACTOR);
    await expect(attempt).rejects.toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE });
    await expect(attempt).rejects.toThrow('SP0099');
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('tạo: cùng thuốc nhưng khác tỉ lệ quy đổi là quy cách khác — được tạo', async () => {
    const createProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const service = makeService({
      createProduct,
      findPacksByDrug: jest.fn().mockResolvedValue([
        pack('SP0099', [
          ['unit-vien', 1],
          ['unit-vi', 20],
        ]),
      ]),
      findDetailWith: jest.fn().mockResolvedValue({ id: 'product-id' }),
    });

    await service.create(validCreatePayload(), ACTOR);

    expect(createProduct).toHaveBeenCalled();
  });

  it('tạo: khoá theo thuốc trước khi đọc các quy cách đã có', async () => {
    const order: string[] = [];
    const tx = {
      $executeRaw: jest.fn().mockImplementation(() => {
        order.push('lock');
        return 0;
      }),
    };
    const findPacksByDrug = jest.fn().mockImplementation(() => {
      order.push('read');
      return [];
    });
    const service = makeService(
      { findPacksByDrug, findDetailWith: jest.fn().mockResolvedValue({ id: 'product-id' }) },
      { write: jest.fn().mockImplementation((_locks: string[], work: (client: unknown) => unknown) => work(tx)) },
    );

    await service.create(validCreatePayload(), ACTOR);

    expect(order).toEqual(['lock', 'read']);
    expect(findPacksByDrug).toHaveBeenCalledWith(tx, 'drug-id', undefined);
  });

  it('sửa units thành trùng quy cách hàng khác thì bị chặn; so trừ chính nó', async () => {
    const findPacksByDrug = jest.fn().mockResolvedValue([samePack]);
    const service = makeService({
      findDetailWith: jest
        .fn()
        .mockResolvedValue({ ...existingProduct, drugId: 'drug-id', drug: { id: 'drug-id', isPrescription: false } }),
      findPacksByDrug,
    });

    await expect(
      service.update(
        'product-id',
        {
          units: [
            { unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true },
            { unitId: 'unit-vi', conversionRate: 10, salePrice: 4500, isBaseUnit: false },
          ],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.DUPLICATE_CODE });
    expect(findPacksByDrug).toHaveBeenCalledWith(expect.anything(), 'drug-id', 'product-id');
  });

  it('sửa trường khác (không đổi units, không đổi thuốc) thì không kiểm trùng', async () => {
    const findPacksByDrug = jest.fn();
    const service = makeService({
      findDetailWith: jest
        .fn()
        .mockResolvedValue({ ...existingProduct, drugId: 'drug-id', drug: { id: 'drug-id', isPrescription: false } }),
      findPacksByDrug,
    });

    await service.update('product-id', { name: 'Tên mới' }, ACTOR);

    expect(findPacksByDrug).not.toHaveBeenCalled();
  });
});

describe('ProductService — cập nhật', () => {
  it('body rỗng thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(service.update('product-id', {}, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND và không ghi gì', async () => {
    const updateProduct = jest.fn();
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(null), updateProduct });

    await expect(service.update('product-id', { name: 'X' }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it('đọc sản phẩm bằng chính client của transaction, không dùng snapshot đọc ngoài', async () => {
    const tx = { marker: 'tx' };
    const findDetailWith = jest.fn().mockResolvedValue(existingProduct);
    const service = makeService(
      { findDetailWith },
      {
        write: jest.fn().mockImplementation((_locks: string[], work: (client: unknown) => unknown) => work(tx)),
      },
    );

    await service.update('product-id', { name: 'Tên mới' }, ACTOR);

    expect(findDetailWith).toHaveBeenCalledWith(tx, 'product-id');
  });

  it('khoá hẹp: chỉ chính sản phẩm và các mã vạch định dùng, không khoá cả bảng', async () => {
    const write = jest.fn().mockImplementation((_locks: string[], work: (client: unknown) => unknown) => work({}));
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct) }, { write });

    await service.update('product-id', { barcode: '8930001' }, ACTOR);

    expect(write).toHaveBeenCalledWith(['product:product-id', 'barcode:8930001'], expect.any(Function));
  });

  it('sản phẩm vừa bị xoá mềm thì không ghi gì và báo RECORD_NOT_FOUND', async () => {
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      updateProduct: jest.fn().mockResolvedValue(0),
    });

    await expect(service.update('product-id', { name: 'X' }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
  });

  it('dòng đơn vị bán đang hoạt động mà payload không gửi status thì giữ nguyên status cũ', async () => {
    const updateUnit = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findUnitsForReconcile: jest.fn().mockResolvedValue([{ id: 'row-vien', unitId: 'unit-vien', isDeleted: false }]),
      updateUnit,
    });

    await service.update(
      'product-id',
      { units: [{ unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true }] },
      ACTOR,
    );

    const [, , data] = updateUnit.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(data).not.toHaveProperty('status');
  });

  it('chỉ ghi trường client thực sự gửi và gán updatedBy', async () => {
    const updateProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      updateProduct,
    });

    await service.update('product-id', { name: 'Tên mới' }, ACTOR);

    expect(updateProduct).toHaveBeenCalledWith(expect.anything(), 'product-id', {
      name: 'Tên mới',
      updatedBy: 'caller-id',
    });
  });

  it('không gửi units thì giữ nguyên cấu hình đơn vị bán', async () => {
    const createUnits = jest.fn();
    const updateUnit = jest.fn();
    const softDeleteUnits = jest.fn();
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      createUnits,
      updateUnit,
      softDeleteUnits,
    });

    await service.update('product-id', { name: 'Tên mới' }, ACTOR);

    expect(createUnits).not.toHaveBeenCalled();
    expect(updateUnit).not.toHaveBeenCalled();
    expect(softDeleteUnits).not.toHaveBeenCalled();
  });

  it('gửi units thì thay toàn bộ: cập nhật dòng cũ, tạo dòng mới, xoá mềm dòng bị loại', async () => {
    const createUnits = jest.fn().mockResolvedValue(undefined);
    const updateUnit = jest.fn().mockResolvedValue(undefined);
    const softDeleteUnits = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findUnitsForReconcile: jest.fn().mockResolvedValue([
        { id: 'row-vien', unitId: 'unit-vien', isDeleted: false },
        { id: 'row-vi', unitId: 'unit-vi', isDeleted: false },
      ]),
      createUnits,
      updateUnit,
      softDeleteUnits,
    });

    await service.update(
      'product-id',
      {
        units: [
          { unitId: 'unit-vien', conversionRate: 1, salePrice: 600, isBaseUnit: true },
          { unitId: 'unit-hop', conversionRate: 100, salePrice: 42000, isBaseUnit: false },
        ],
      },
      ACTOR,
    );

    expect(updateUnit).toHaveBeenCalledWith(
      expect.anything(),
      'row-vien',
      expect.objectContaining({ salePrice: 600, isDeleted: false, updatedBy: 'caller-id' }),
    );
    expect(createUnits).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ productId: 'product-id', unitId: 'unit-hop', createdBy: 'caller-id' }),
    ]);
    expect(softDeleteUnits).toHaveBeenCalledWith(expect.anything(), ['row-vi'], 'caller-id');
  });

  it('kích hoạt lại dòng đã xoá mềm với status mặc định ACTIVE', async () => {
    const updateUnit = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findUnitsForReconcile: jest.fn().mockResolvedValue([{ id: 'row-hop', unitId: 'unit-hop', isDeleted: true }]),
      updateUnit,
    });

    await service.update(
      'product-id',
      {
        units: [{ unitId: 'unit-hop', conversionRate: 1, salePrice: 42000, isBaseUnit: true }],
        baseUnitId: 'unit-hop',
      },
      ACTOR,
    );

    expect(updateUnit).toHaveBeenCalledWith(
      expect.anything(),
      'row-hop',
      expect.objectContaining({ isDeleted: false, status: RecordStatus.ACTIVE }),
    );
  });

  it('kích hoạt lại giữ status INACTIVE khi client gửi', async () => {
    const updateUnit = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findUnitsForReconcile: jest.fn().mockResolvedValue([{ id: 'row-hop', unitId: 'unit-hop', isDeleted: true }]),
      updateUnit,
    });

    await service.update(
      'product-id',
      {
        baseUnitId: 'unit-hop',
        units: [
          { unitId: 'unit-hop', conversionRate: 1, salePrice: 42000, isBaseUnit: true, status: RecordStatus.INACTIVE },
        ],
      },
      ACTOR,
    );

    expect(updateUnit).toHaveBeenCalledWith(
      expect.anything(),
      'row-hop',
      expect.objectContaining({ status: RecordStatus.INACTIVE }),
    );
  });

  it('gửi units rỗng thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct) });

    await expect(service.update('product-id', { units: [] }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('đổi baseUnit mà không gửi units thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct) });

    await expect(service.update('product-id', { baseUnitId: 'unit-hop' }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('đổi baseUnit kèm units hợp lệ thì ghi baseUnitId mới', async () => {
    const updateProduct = jest.fn().mockResolvedValue({ id: 'product-id' });
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      updateProduct,
    });

    await service.update(
      'product-id',
      {
        baseUnitId: 'unit-hop',
        units: [{ unitId: 'unit-hop', conversionRate: 1, salePrice: 42000, isBaseUnit: true }],
      },
      ACTOR,
    );

    expect(updateProduct).toHaveBeenCalledWith(
      expect.anything(),
      'product-id',
      expect.objectContaining({ baseUnitId: 'unit-hop' }),
    );
  });

  it('units thiếu dòng base mới thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct) });

    await expect(
      service.update(
        'product-id',
        {
          baseUnitId: 'unit-hop',
          units: [{ unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true }],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('bỏ qua barcode của chính sản phẩm và các dòng đơn vị của nó khi kiểm trùng', async () => {
    const findBarcodeConflict = jest.fn().mockResolvedValue(null);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findUnitsForReconcile: jest.fn().mockResolvedValue([{ id: 'row-vien', unitId: 'unit-vien', isDeleted: false }]),
      findBarcodeConflict,
    });

    await service.update(
      'product-id',
      {
        barcode: '8935000000',
        units: [{ unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true, barcode: '8935000001' }],
      },
      ACTOR,
    );

    expect(findBarcodeConflict).toHaveBeenCalledWith(expect.anything(), ['8935000000', '8935000001'], {
      productId: 'product-id',
      productUnitIds: ['row-vien'],
    });
  });

  it('barcode trùng với bản ghi khác thì báo DUPLICATE_CODE', async () => {
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findBarcodeConflict: jest.fn().mockResolvedValue({ barcode: '8935000009', source: 'product_units' }),
    });

    await expect(service.update('product-id', { barcode: '8935000009' }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });

  it('nhóm sản phẩm mới không hợp lệ thì báo INVALID_REFERENCE', async () => {
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findActiveCategory: jest.fn().mockResolvedValue(null),
    });

    await expect(service.update('product-id', { categoryId: 'category-khac' }, ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('không đổi tham chiếu thì không kiểm tra lại nhóm sản phẩm đang INACTIVE', async () => {
    const findActiveCategory = jest.fn();
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findActiveCategory,
    });

    await service.update('product-id', { name: 'Tên mới' }, ACTOR);

    expect(findActiveCategory).not.toHaveBeenCalled();
  });

  it('lỗi khi ghi ProductUnit thì ném ra ngoài, không trả chi tiết', async () => {
    const findDetailWith = jest.fn().mockResolvedValueOnce(existingProduct).mockResolvedValue(null);
    const service = makeService({
      findDetailWith,
      findUnitsForReconcile: jest.fn().mockResolvedValue([]),
      createUnits: jest.fn().mockRejectedValue(new Error('insert failed')),
    });

    await expect(
      service.update(
        'product-id',
        { units: [{ unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true }] },
        ACTOR,
      ),
    ).rejects.toThrow('insert failed');
    expect(findDetailWith).toHaveBeenCalledTimes(1);
  });

  it('barcode sản phẩm trùng barcode một dòng đơn vị bán trong payload thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct) });

    await expect(
      service.update(
        'product-id',
        {
          barcode: '8935000999',
          units: [{ unitId: 'unit-vien', conversionRate: 1, salePrice: 500, isBaseUnit: true, barcode: '8935000999' }],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });
});

describe('ProductService — rào kho', () => {
  it('đổi đơn vị cơ bản khi sản phẩm đã phát sinh kho → 1709, không ghi gì', async () => {
    const updateProduct = jest.fn();
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      hasInventoryHistory: jest.fn().mockResolvedValue(true),
      updateProduct,
    });

    await expect(
      service.update(
        'product-id',
        {
          baseUnitId: 'unit-vi',
          units: [{ unitId: 'unit-vi', conversionRate: 1, salePrice: 4500, isBaseUnit: true }],
        } as never,
        ACTOR,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.PRODUCT_HAS_STOCK });
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it('xoá sản phẩm còn tồn hoặc chứng từ kho đang mở → 1709, không xoá', async () => {
    const softDeleteProduct = jest.fn();
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      hasOpenInventory: jest.fn().mockResolvedValue(true),
      softDeleteProduct,
    });

    await expect(service.remove('product-id', ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.PRODUCT_HAS_STOCK,
    });
    expect(softDeleteProduct).not.toHaveBeenCalled();
  });
});

describe('ProductService — xoá', () => {
  it('không tồn tại hoặc đã xoá mềm thì báo RECORD_NOT_FOUND và không ghi gì', async () => {
    const softDeleteProduct = jest.fn();
    const softDeleteUnits = jest.fn();
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(null),
      softDeleteProduct,
      softDeleteUnits,
    });

    await expect(service.remove('product-id', ACTOR)).rejects.toMatchObject({
      errorCode: ErrorCode.RECORD_NOT_FOUND,
    });
    expect(softDeleteProduct).not.toHaveBeenCalled();
    expect(softDeleteUnits).not.toHaveBeenCalled();
  });

  it('xoá mềm Product và toàn bộ ProductUnit đang hoạt động kèm updatedBy', async () => {
    const softDeleteProduct = jest.fn().mockResolvedValue(undefined);
    const softDeleteUnits = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findUnitsForReconcile: jest.fn().mockResolvedValue([
        { id: 'row-vien', unitId: 'unit-vien', isDeleted: false },
        { id: 'row-vi', unitId: 'unit-vi', isDeleted: false },
        { id: 'row-hop', unitId: 'unit-hop', isDeleted: true },
      ]),
      softDeleteProduct,
      softDeleteUnits,
    });

    await expect(service.remove('product-id', ACTOR)).resolves.toEqual({ success: true });

    expect(softDeleteUnits).toHaveBeenCalledWith(expect.anything(), ['row-vien', 'row-vi'], 'caller-id');
    expect(softDeleteProduct).toHaveBeenCalledWith(expect.anything(), 'product-id', 'caller-id');
  });

  it('lỗi khi ghi thì ném ra ngoài, không trả success', async () => {
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      softDeleteProduct: jest.fn().mockRejectedValue(new Error('update failed')),
    });

    await expect(service.remove('product-id', ACTOR)).rejects.toThrow('update failed');
  });
});

describe('ProductService — nhật ký', () => {
  const detail = (overrides: Record<string, unknown> = {}) => ({
    ...existingProduct,
    name: 'Paracetamol 500mg',
    status: RecordStatus.ACTIVE,
    requiresPrescription: false,
    isControlled: false,
    units: [
      { id: 'row-vien', salePrice: 500, conversionRate: 1, unit: { id: 'unit-vien' } },
      { id: 'row-vi', salePrice: 4500, conversionRate: 10, unit: { id: 'unit-vi' } },
    ],
    ...overrides,
  });

  it('tạo ghi PRODUCT.CREATED, branchIds [], nhãn = mã, tìm theo mã + tên', async () => {
    const audit = makeAudit();
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(detail()) }, {}, audit);

    await service.create(validCreatePayload(), ACTOR);

    const [, actor] = audit.record.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(actor).toMatchObject({ userId: 'caller-id', type: 'USER', ip: '10.0.0.1', requestId: 'req-1' });
    expect(recordedEntries(audit)).toEqual([
      expect.objectContaining({
        event: 'PRODUCT.CREATED',
        entityType: 'products',
        entityId: 'product-id',
        entityLabel: 'SP0001',
        branchIds: [],
        searchTerms: ['SP0001', 'Paracetamol 500mg'],
      }),
    ]);
  });

  it('sửa tên ghi PRODUCT.UPDATED chỉ với trường đổi', async () => {
    const audit = makeAudit();
    const findDetailWith = jest
      .fn()
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ name: 'Paracetamol 650mg' }));
    const service = makeService({ findDetailWith }, {}, audit);

    await service.update('product-id', { name: 'Paracetamol 650mg' }, ACTOR);

    expect(recordedEntries(audit)).toEqual([
      {
        event: 'PRODUCT.UPDATED',
        entityType: 'products',
        entityId: 'product-id',
        entityLabel: 'SP0001',
        branchIds: [],
        before: { name: 'Paracetamol 500mg' },
        after: { name: 'Paracetamol 650mg' },
        searchTerms: ['SP0001', 'Paracetamol 650mg'],
      },
    ]);
  });

  it('chỉ đổi status ghi PRODUCT.STATUS_CHANGED', async () => {
    const audit = makeAudit();
    const findDetailWith = jest
      .fn()
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ status: RecordStatus.INACTIVE }));
    const service = makeService({ findDetailWith }, {}, audit);

    await service.update('product-id', { status: RecordStatus.INACTIVE }, ACTOR);

    expect(recordedEntries(audit)).toEqual([
      expect.objectContaining({
        event: 'PRODUCT.STATUS_CHANGED',
        before: { status: 'ACTIVE' },
        after: { status: 'INACTIVE' },
      }),
    ]);
  });

  it('đổi isControlled ghi PRODUCT.CONTROL_FLAGS_CHANGED', async () => {
    const audit = makeAudit();
    const findDetailWith = jest
      .fn()
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ isControlled: true, name: 'Tên mới' }));
    const service = makeService({ findDetailWith }, {}, audit);

    await service.update('product-id', { isControlled: true, name: 'Tên mới' } as never, ACTOR);

    const entries = recordedEntries(audit);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'PRODUCT.UPDATED',
          before: { name: 'Paracetamol 500mg' },
          after: { name: 'Tên mới' },
        }),
        expect.objectContaining({
          event: 'PRODUCT.CONTROL_FLAGS_CHANGED',
          entityId: 'product-id',
          entityLabel: 'SP0001',
          branchIds: [],
          before: { isControlled: false },
          after: { isControlled: true },
        }),
      ]),
    );
  });

  it('đổi salePrice của đơn vị ghi PRODUCT.PRICE_CHANGED', async () => {
    const audit = makeAudit();
    const findDetailWith = jest
      .fn()
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(
        detail({
          units: [
            { id: 'row-vien', salePrice: 600, conversionRate: 1, unit: { id: 'unit-vien' } },
            { id: 'row-vi', salePrice: 4500, conversionRate: 10, unit: { id: 'unit-vi' } },
          ],
        }),
      );
    const service = makeService(
      {
        findDetailWith,
        findUnitsForReconcile: jest.fn().mockResolvedValue([
          { id: 'row-vien', unitId: 'unit-vien', isDeleted: false },
          { id: 'row-vi', unitId: 'unit-vi', isDeleted: false },
        ]),
      },
      {},
      audit,
    );

    await service.update(
      'product-id',
      {
        units: [
          { unitId: 'unit-vien', conversionRate: 1, salePrice: 600, isBaseUnit: true },
          { unitId: 'unit-vi', conversionRate: 10, salePrice: 4500, isBaseUnit: false },
        ],
      },
      ACTOR,
    );

    expect(recordedEntries(audit)).toEqual([
      {
        event: 'PRODUCT.PRICE_CHANGED',
        entityType: 'products',
        entityId: 'product-id',
        entityLabel: 'SP0001',
        branchIds: [],
        before: { unitId: 'unit-vien', salePrice: 500 },
        after: { unitId: 'unit-vien', salePrice: 600 },
        amount: 600n,
        searchTerms: ['SP0001', 'Paracetamol 500mg'],
      },
    ]);
  });

  it('không trường theo dõi nào đổi thì không gọi record', async () => {
    const audit = makeAudit();
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(detail()) }, {}, audit);

    await service.update('product-id', { indications: 'mới' } as never, ACTOR);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('xoá ghi PRODUCT.DELETED với ảnh chụp trước', async () => {
    const audit = makeAudit();
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(detail()) }, {}, audit);

    await service.remove('product-id', ACTOR);

    expect(recordedEntries(audit)).toEqual([
      expect.objectContaining({
        event: 'PRODUCT.DELETED',
        entityId: 'product-id',
        entityLabel: 'SP0001',
        branchIds: [],
        before: expect.objectContaining({ code: 'SP0001', name: 'Paracetamol 500mg' }) as unknown,
        searchTerms: ['SP0001', 'Paracetamol 500mg'],
      }),
    ]);
  });
});
