import { DosageForm, Prisma, RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { ProductService } from './product.service';

function makeService(
  repositoryOverrides: Record<string, jest.Mock> = {},
  transactionOverrides: Record<string, jest.Mock> = {},
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
    ...repositoryOverrides,
  } as never;
  const transactions = {
    write: jest.fn().mockImplementation((work: (tx: unknown) => unknown) => work({})),
    ...transactionOverrides,
  } as never;
  return new ProductService(repository, transactions);
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
        searchFields: ['code', 'barcode', 'name', 'activeIngredient'],
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

    await expect(service.create(validCreatePayload(), 'caller-id')).resolves.toEqual(detail);

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

    await service.create(validCreatePayload(), 'caller-id');

    expect(createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ manufacturerId: null }));
  });

  it('nhóm sản phẩm không tồn tại hoặc đã ngừng hoạt động thì báo INVALID_REFERENCE', async () => {
    const service = makeService({ findActiveCategory: jest.fn().mockResolvedValue(null) });

    await expect(service.create(validCreatePayload(), 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('hãng sản xuất không hợp lệ thì báo INVALID_REFERENCE', async () => {
    const service = makeService({ findActiveManufacturer: jest.fn().mockResolvedValue(null) });

    await expect(
      service.create(validCreatePayload({ manufacturerId: 'manufacturer-id' }), 'caller-id'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
  });

  it('đơn vị không tồn tại hoặc đã xoá mềm thì báo INVALID_REFERENCE', async () => {
    const service = makeService({ findUnits: jest.fn().mockResolvedValue([{ id: 'unit-vien' }]) });

    await expect(service.create(validCreatePayload(), 'caller-id')).rejects.toMatchObject({
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
        'caller-id',
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
        'caller-id',
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
        'caller-id',
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
        'caller-id',
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
        'caller-id',
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
        'caller-id',
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
        'caller-id',
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
  });

  it('barcode đã dùng ở bảng khác thì báo DUPLICATE_CODE', async () => {
    const service = makeService({
      findBarcodeConflict: jest.fn().mockResolvedValue({ barcode: '8935000001', source: 'product_units' }),
    });

    await expect(service.create(validCreatePayload({ barcode: '8935000001' }), 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });

  it('trùng code sản phẩm thì báo DUPLICATE_CODE', async () => {
    const service = makeService({ createProduct: jest.fn().mockRejectedValue(duplicateError()) });

    await expect(service.create(validCreatePayload(), 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });

  it('ghi ProductUnit lỗi thì lỗi ném ra ngoài, không trả chi tiết', async () => {
    const findDetailWith = jest.fn();
    const service = makeService({
      createUnits: jest.fn().mockRejectedValue(new Error('insert failed')),
      findDetailWith,
    });

    await expect(service.create(validCreatePayload(), 'caller-id')).rejects.toThrow('insert failed');
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
};

describe('ProductService — cập nhật', () => {
  it('body rỗng thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({});

    await expect(service.update('product-id', {}, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('không tồn tại thì báo RECORD_NOT_FOUND và không ghi gì', async () => {
    const updateProduct = jest.fn();
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(null), updateProduct });

    await expect(service.update('product-id', { name: 'X' }, 'caller-id')).rejects.toMatchObject({
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
        write: jest.fn().mockImplementation((work: (client: unknown) => unknown) => work(tx)),
      },
    );

    await service.update('product-id', { name: 'Tên mới' }, 'caller-id');

    expect(findDetailWith).toHaveBeenCalledWith(tx, 'product-id');
  });

  it('sản phẩm vừa bị xoá mềm thì không ghi gì và báo RECORD_NOT_FOUND', async () => {
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      updateProduct: jest.fn().mockResolvedValue(0),
    });

    await expect(service.update('product-id', { name: 'X' }, 'caller-id')).rejects.toMatchObject({
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
      'caller-id',
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

    await service.update('product-id', { name: 'Tên mới' }, 'caller-id');

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

    await service.update('product-id', { name: 'Tên mới' }, 'caller-id');

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
      'caller-id',
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
      'caller-id',
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
      'caller-id',
    );

    expect(updateUnit).toHaveBeenCalledWith(
      expect.anything(),
      'row-hop',
      expect.objectContaining({ status: RecordStatus.INACTIVE }),
    );
  });

  it('gửi units rỗng thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct) });

    await expect(service.update('product-id', { units: [] }, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('đổi baseUnit mà không gửi units thì báo HTTP_BAD_REQUEST', async () => {
    const service = makeService({ findDetailWith: jest.fn().mockResolvedValue(existingProduct) });

    await expect(service.update('product-id', { baseUnitId: 'unit-hop' }, 'caller-id')).rejects.toMatchObject({
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
      'caller-id',
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
        'caller-id',
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
      'caller-id',
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

    await expect(service.update('product-id', { barcode: '8935000009' }, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.DUPLICATE_CODE,
    });
  });

  it('nhóm sản phẩm mới không hợp lệ thì báo INVALID_REFERENCE', async () => {
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findActiveCategory: jest.fn().mockResolvedValue(null),
    });

    await expect(service.update('product-id', { categoryId: 'category-khac' }, 'caller-id')).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('không đổi tham chiếu thì không kiểm tra lại nhóm sản phẩm đang INACTIVE', async () => {
    const findActiveCategory = jest.fn();
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      findActiveCategory,
    });

    await service.update('product-id', { name: 'Tên mới' }, 'caller-id');

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
        'caller-id',
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
        'caller-id',
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.HTTP_BAD_REQUEST });
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

    await expect(service.remove('product-id', 'caller-id')).rejects.toMatchObject({
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

    await expect(service.remove('product-id', 'caller-id')).resolves.toEqual({ success: true });

    expect(softDeleteUnits).toHaveBeenCalledWith(expect.anything(), ['row-vien', 'row-vi'], 'caller-id');
    expect(softDeleteProduct).toHaveBeenCalledWith(expect.anything(), 'product-id', 'caller-id');
  });

  it('lỗi khi ghi thì ném ra ngoài, không trả success', async () => {
    const service = makeService({
      findDetailWith: jest.fn().mockResolvedValue(existingProduct),
      softDeleteProduct: jest.fn().mockRejectedValue(new Error('update failed')),
    });

    await expect(service.remove('product-id', 'caller-id')).rejects.toThrow('update failed');
  });
});
