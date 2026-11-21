import { ProductType } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import type { InteractionCheckResult } from './interaction-service.client';
import { SafetyCheckService } from './safety-check.service';

const product = (
  id: string,
  name: string,
  registrationNumber: string | null,
  type: ProductType = ProductType.DRUG,
) => ({
  id,
  name,
  type,
  drug: type === ProductType.DRUG ? { registrationNumber } : null,
});

const emptyResult = (): InteractionCheckResult => ({
  interactions: [],
  duplicates: [],
  hasMajor: false,
  notFound: [],
  incomplete: [],
});

describe('SafetyCheckService', () => {
  const prisma = { product: { findMany: jest.fn() } };
  const client = { checkInteractions: jest.fn(), getDrugWarnings: jest.fn() };
  const service = new SafetyCheckService(prisma as never, client as never);

  beforeEach(() => jest.clearAllMocks());

  it('đổi cặp tương tác theo số đăng ký thành cảnh báo theo hàng hoá, nặng trước', async () => {
    prisma.product.findMany.mockResolvedValue([
      product('p1', 'Verzenio', 'REG1'),
      product('p2', 'Humira', 'REG2'),
      product('p3', 'Panadol', 'REG3'),
    ]);
    client.checkInteractions.mockResolvedValue({
      ...emptyResult(),
      interactions: [
        {
          id: 'ddi:A:C',
          severity: 'moderate',
          drug1: { registrationNumber: 'REG1', name: '' },
          drug2: { registrationNumber: 'REG3', name: '' },
          ingredient1: 'Abemaciclib',
          ingredient2: 'Acetaminophen',
          description: '',
          management: '',
        },
        {
          id: 'ddi:A:B',
          severity: 'major',
          drug1: { registrationNumber: 'REG1', name: '' },
          drug2: { registrationNumber: 'REG2', name: '' },
          ingredient1: 'Abemaciclib',
          ingredient2: 'Adalimumab',
          description: 'mechanism',
          management: 'avoid',
        },
      ],
      hasMajor: true,
    });

    const result = await service.check(['p1', 'p2', 'p3']);

    expect(client.checkInteractions).toHaveBeenCalledWith(['REG1', 'REG2', 'REG3']);
    expect(result.hasMajor).toBe(true);
    expect(result.majorWarningIds).toEqual(['ddi:A:B']);
    expect(result.warnings.map((w) => w.severity)).toEqual(['major', 'moderate']);
    expect(result.warnings[0]).toMatchObject({
      kind: 'DRUG_DRUG',
      products: [
        { productId: 'p1', name: 'Verzenio' },
        { productId: 'p2', name: 'Humira' },
      ],
      summary: 'Nghiêm trọng: Verzenio + Humira (Abemaciclib – Adalimumab)',
    });
  });

  it('hàng thường (GOODS) bỏ qua; dưới 2 thuốc thì không gọi service', async () => {
    prisma.product.findMany.mockResolvedValue([
      product('p1', 'Panadol', 'REG3'),
      product('g1', 'Khẩu trang', null, ProductType.GOODS),
    ]);

    const result = await service.check(['p1', 'g1']);

    expect(client.checkInteractions).not.toHaveBeenCalled();
    expect(result).toMatchObject({ warnings: [], hasMajor: false, unchecked: [] });
  });

  it('báo hàng chưa kiểm tra được: không có số đăng ký, không có trong dữ liệu, dữ liệu thiếu', async () => {
    prisma.product.findMany.mockResolvedValue([
      product('p1', 'A', null),
      product('p2', 'B', 'REG2'),
      product('p3', 'C', 'REG3'),
    ]);
    client.checkInteractions.mockResolvedValue({ ...emptyResult(), notFound: ['REG2'], incomplete: ['REG3'] });

    const result = await service.check(['p1', 'p2', 'p3']);

    expect(result.unchecked).toEqual([
      { productId: 'p1', name: 'A', reason: 'NO_REGISTRATION_NUMBER' },
      { productId: 'p2', name: 'B', reason: 'NOT_IN_INTERACTION_DATA' },
      { productId: 'p3', name: 'C', reason: 'INCOMPLETE_DATA' },
    ]);
  });

  it('hai hàng hoá cùng một thuốc → cảnh báo trùng thuốc, không chặn', async () => {
    prisma.product.findMany.mockResolvedValue([
      product('p1', 'Panadol hộp', 'REG3'),
      product('p2', 'Panadol vỉ', 'REG3'),
    ]);

    const result = await service.check(['p1', 'p2']);

    expect(result.hasMajor).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({ id: 'same-drug:REG3', kind: 'DUPLICATE_INGREDIENT', severity: 'moderate' }),
    ]);
  });

  it('có hàng hoá không tồn tại → 1602', async () => {
    prisma.product.findMany.mockResolvedValue([product('p1', 'A', 'REG1')]);

    await expect(service.check(['p1', 'missing'])).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_REFERENCE });
  });
});
