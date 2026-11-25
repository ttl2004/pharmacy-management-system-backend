import { ProductType } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import type {
  CartProductRow,
  CheckRows,
  InteractionRow,
  MappingRow,
  WarningRows,
} from './interaction-knowledge.repository';
import { SafetyCheckService } from './safety-check.service';

const product = (
  id: string,
  name: string,
  registrationNumber: string | null,
  type: ProductType = ProductType.DRUG,
): CartProductRow => ({ id, name, type, registrationNumber });

const map = (registrationNumber: string, ddinterId: string | null, ddinterDrug: string | null = null): MappingRow => ({
  registrationNumber,
  drugName: registrationNumber,
  ingredientOrder: 1,
  ddinterId,
  ddinterDrug,
});

const pair = (a: string, b: string, level: string, interaction = '', management = ''): InteractionRow => ({
  ddinterIdA: a,
  ddinterIdB: b,
  level,
  interaction,
  management,
});

const checkRows = (rows: Partial<CheckRows>): CheckRows => ({
  products: [],
  mapping: [],
  interactions: [],
  dataLoaded: true,
  ...rows,
});

describe('SafetyCheckService', () => {
  const repository = { loadForCheck: jest.fn(), loadForWarnings: jest.fn() };
  const service = new SafetyCheckService(repository as never);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  it('một câu truy vấn cho cả giỏ; đổi cặp tương tác theo số đăng ký thành cảnh báo theo hàng hoá, nặng trước', async () => {
    repository.loadForCheck.mockResolvedValue(
      checkRows({
        products: [
          product('p1', 'Verzenio', 'REG1'),
          product('p2', 'Humira', ' REG2 '),
          product('p3', 'Panadol', 'REG3'),
        ],
        mapping: [map('REG1', 'A', 'Abemaciclib'), map('REG2', 'B', 'Adalimumab'), map('REG3', 'C', 'Acetaminophen')],
        interactions: [pair('C', 'A', 'Moderate'), pair('A', 'B', 'Major', 'mechanism', 'avoid')],
      }),
    );

    const result = await service.check(['p1', 'p2', 'p3', 'p1']);

    expect(repository.loadForCheck).toHaveBeenCalledTimes(1);
    expect(repository.loadForCheck).toHaveBeenCalledWith(['p1', 'p2', 'p3']);
    expect(result.hasMajor).toBe(true);
    expect(result.majorWarningIds).toEqual(['ddi:A:B']);
    expect(result.warnings.map((w) => w.severity)).toEqual(['major', 'moderate']);
    expect(result.warnings[0]).toMatchObject({
      kind: 'DRUG_DRUG',
      products: [
        { productId: 'p1', name: 'Verzenio' },
        { productId: 'p2', name: 'Humira' },
      ],
      description: 'mechanism',
      management: 'avoid',
      summary: 'Nghiêm trọng: Verzenio + Humira (Abemaciclib – Adalimumab)',
    });
    expect(result.warnings[1]).toMatchObject({
      id: 'ddi:A:C',
      summary: 'Trung bình: Verzenio + Panadol (Abemaciclib – Acetaminophen)',
    });
  });

  it('hàng thường (GOODS) bỏ qua; dưới 2 thuốc thì không tra — kể cả khi bảng dữ liệu tương tác rỗng', async () => {
    repository.loadForCheck.mockResolvedValue(
      checkRows({
        products: [product('p1', 'Panadol', 'REG3'), product('g1', 'Khẩu trang', null, ProductType.GOODS)],
        mapping: [map('REG3', 'C', 'Acetaminophen')],
        dataLoaded: false,
      }),
    );

    const result = await service.check(['p1', 'g1']);

    expect(result).toMatchObject({ warnings: [], hasMajor: false, unchecked: [] });
  });

  it('báo hàng chưa kiểm tra được: không có số đăng ký, không có trong dữ liệu, dữ liệu thiếu', async () => {
    repository.loadForCheck.mockResolvedValue(
      checkRows({
        products: [product('p1', 'A', null), product('p2', 'B', 'REG2'), product('p3', 'C', 'REG3')],
        mapping: [map('REG3', null)],
      }),
    );

    const result = await service.check(['p1', 'p2', 'p3']);

    expect(result.unchecked).toEqual([
      { productId: 'p1', name: 'A', reason: 'NO_REGISTRATION_NUMBER' },
      { productId: 'p2', name: 'B', reason: 'NOT_IN_INTERACTION_DATA' },
      { productId: 'p3', name: 'C', reason: 'INCOMPLETE_DATA' },
    ]);
  });

  it('hai hàng hoá cùng một thuốc → cảnh báo trùng thuốc, không chặn', async () => {
    repository.loadForCheck.mockResolvedValue(
      checkRows({ products: [product('p1', 'Panadol hộp', 'REG3'), product('p2', 'Panadol vỉ', 'REG3')] }),
    );

    const result = await service.check(['p1', 'p2']);

    expect(result.hasMajor).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({ id: 'same-drug:REG3', kind: 'DUPLICATE_INGREDIENT', severity: 'moderate' }),
    ]);
  });

  it('có hàng hoá không tồn tại → 1602', async () => {
    repository.loadForCheck.mockResolvedValue(checkRows({ products: [product('p1', 'A', 'REG1')] }));

    await expect(service.check(['p1', 'missing'])).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
  });

  it('từ 2 thuốc mà bảng dữ liệu tương tác rỗng → 1611, KHÔNG coi là "không có cảnh báo"', async () => {
    repository.loadForCheck.mockResolvedValue(
      checkRows({ products: [product('p1', 'A', 'REG1'), product('p2', 'B', 'REG2')], dataLoaded: false }),
    );

    await expect(service.check(['p1', 'p2'])).rejects.toMatchObject({
      errorCode: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE,
    });
  });

  describe('drugWarnings', () => {
    const warningRows = (rows: Partial<WarningRows>): WarningRows => ({
      products: [],
      mapping: [],
      diseases: [],
      foods: [],
      dataLoaded: true,
      ...rows,
    });

    it('lưu ý theo từng hàng thuốc, theo thứ tự giỏ; hàng thường bỏ qua', async () => {
      repository.loadForWarnings.mockResolvedValue(
        warningRows({
          products: [
            product('p1', 'Aspirin', 'REG2'),
            product('g1', 'Khẩu trang', null, ProductType.GOODS),
            product('p2', 'Lạ', 'NOPE'),
          ],
          mapping: [map('REG2', 'B', 'Aspirin')],
          diseases: [{ drugId: 'B', severity: 'Major', diseaseName: 'Peptic Ulcer', description: 'GI' }],
        }),
      );

      await expect(service.drugWarnings(['p1', 'g1', 'p2'])).resolves.toEqual([
        {
          productId: 'p1',
          name: 'Aspirin',
          hasData: true,
          diseases: [{ ingredient: 'Aspirin', severity: 'major', diseaseName: 'Peptic Ulcer', description: 'GI' }],
          foods: [],
        },
        { productId: 'p2', name: 'Lạ', hasData: false, diseases: [], foods: [] },
      ]);
    });

    it('bảng dữ liệu rỗng → 1611; giỏ không có thuốc nào có số đăng ký thì không cần dữ liệu', async () => {
      repository.loadForWarnings.mockResolvedValueOnce(
        warningRows({ products: [product('p1', 'A', 'REG1')], dataLoaded: false }),
      );
      await expect(service.drugWarnings(['p1'])).rejects.toMatchObject({
        errorCode: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE,
      });

      repository.loadForWarnings.mockResolvedValueOnce(
        warningRows({ products: [product('p1', 'A', null)], dataLoaded: false }),
      );
      await expect(service.drugWarnings(['p1'])).resolves.toEqual([
        { productId: 'p1', name: 'A', hasData: false, diseases: [], foods: [] },
      ]);
    });
  });
});
