import { RecordStatus } from '@prisma/client';
import { ErrorCode } from 'src/common/types/error-code';
import { buildOrderLines, orderTotals, SellableUnit } from './order-lines';

const unit = (overrides: Partial<SellableUnit> & { id: string }): SellableUnit => ({
  conversionRate: 1,
  salePrice: 1000,
  status: RecordStatus.ACTIVE,
  unit: { name: 'Viên' },
  product: { id: 'p1', name: 'Paracetamol', status: RecordStatus.ACTIVE, requiresPrescription: false },
  ...overrides,
});

const codeOf = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { errorCode?: number }).errorCode;
  }
  return undefined;
};

describe('buildOrderLines', () => {
  it('sao chép tên/đơn vị/hệ số, tính số lượng cơ bản và thành tiền theo giá bán hiện tại', () => {
    const lines = buildOrderLines(
      [{ productUnitId: 'hop', quantity: 3 }],
      [unit({ id: 'hop', conversionRate: 10, salePrice: 9000, unit: { name: 'Hộp' } })],
    );
    expect(lines).toEqual([
      {
        productId: 'p1',
        productUnitId: 'hop',
        productName: 'Paracetamol',
        unitName: 'Hộp',
        conversionRate: 10,
        quantity: 3,
        baseQuantity: 30,
        unitPrice: 9000,
        totalPrice: 27000n,
        requiresPrescription: false,
      },
    ]);
  });

  it('giữ đúng thứ tự dòng client gửi; cùng sản phẩm hai đơn vị khác nhau được', () => {
    const lines = buildOrderLines(
      [
        { productUnitId: 'vien', quantity: 2 },
        { productUnitId: 'hop', quantity: 1 },
      ],
      [unit({ id: 'hop', conversionRate: 10 }), unit({ id: 'vien' })],
    );
    expect(lines.map((line) => line.productUnitId)).toEqual(['vien', 'hop']);
  });

  it('trùng đơn vị bán → 1002', () => {
    expect(
      codeOf(() =>
        buildOrderLines(
          [
            { productUnitId: 'vien', quantity: 1 },
            { productUnitId: 'vien', quantity: 2 },
          ],
          [unit({ id: 'vien' })],
        ),
      ),
    ).toBe(ErrorCode.HTTP_BAD_REQUEST);
  });

  it.each([
    ['không tìm thấy đơn vị bán', [] as SellableUnit[]],
    ['đơn vị bán ngừng', [unit({ id: 'vien', status: RecordStatus.INACTIVE })]],
    [
      'sản phẩm ngừng',
      [
        unit({
          id: 'vien',
          product: { id: 'p1', name: 'X', status: RecordStatus.INACTIVE, requiresPrescription: false },
        }),
      ],
    ],
  ])('%s → 1801', (_name, units) => {
    expect(codeOf(() => buildOrderLines([{ productUnitId: 'vien', quantity: 1 }], units))).toBe(
      ErrorCode.PRODUCT_NOT_SELLABLE,
    );
  });

  it('số lượng cơ bản vượt trần → 1002', () => {
    expect(
      codeOf(() =>
        buildOrderLines([{ productUnitId: 'thung', quantity: 10_000 }], [unit({ id: 'thung', conversionRate: 2_000 })]),
      ),
    ).toBe(ErrorCode.HTTP_BAD_REQUEST);
  });
});

describe('orderTotals', () => {
  it('tổng = tạm tính + phí ship, tính bằng bigint', () => {
    const lines = buildOrderLines([{ productUnitId: 'a', quantity: 1_000 }], [unit({ id: 'a', salePrice: 5_000_000 })]);
    expect(orderTotals(lines, 30_000)).toEqual({ subtotalAmount: 5_000_000_000n, totalAmount: 5_000_030_000n });
  });
});
