import { PaymentStatus } from '@prisma/client';
import { computeLine, computeTotals, paymentStatusOf, unitCostPerBase } from './goods-receipt.calculator';

describe('computeLine', () => {
  it('quy đổi về đơn vị cơ bản và tính tiền dòng', () => {
    expect(computeLine({ quantity: 10, conversionRate: 100, importPrice: 42_000 })).toEqual({
      baseQuantity: 1000,
      totalPrice: 420_000n,
      unitCost: 420,
    });
  });

  it('tiền dòng vượt trần int vẫn đúng nhờ bigint (500 hộp × 5 triệu)', () => {
    expect(computeLine({ quantity: 500, conversionRate: 1, importPrice: 5_000_000 })?.totalPrice).toBe(2_500_000_000n);
  });

  it('số lượng quy đổi vượt trần cột int thì trả null', () => {
    expect(computeLine({ quantity: 1_000_000, conversionRate: 10_000, importPrice: 1 })).toBeNull();
  });
});

describe('unitCostPerBase (K1 — làm tròn về đồng)', () => {
  it('hộp 30 viên 35.000đ → 1.167đ/viên', () => {
    expect(unitCostPerBase(35_000, 30)).toBe(1167);
  });
});

describe('computeTotals', () => {
  it('tổng = Σ dòng − chiết khấu + VAT, suy trạng thái thanh toán', () => {
    expect(
      computeTotals([100_000n, 50_000n], { discountAmount: 10_000, vatAmount: 7_000, paidAmount: 20_000 }),
    ).toEqual({
      subtotalAmount: 150_000n,
      discountAmount: 10_000n,
      vatAmount: 7_000n,
      totalAmount: 147_000n,
      paidAmount: 20_000n,
      paymentStatus: PaymentStatus.PARTIAL,
    });
  });

  it('chiết khấu lớn hơn tiền hàng là lỗi', () => {
    expect(computeTotals([1_000n], { discountAmount: 2_000 })).toBe('DISCOUNT_EXCEEDS_SUBTOTAL');
  });

  it('trả nhiều hơn tổng phiếu là lỗi', () => {
    expect(computeTotals([1_000n], { paidAmount: 1_001 })).toBe('PAID_EXCEEDS_TOTAL');
  });
});

describe('paymentStatusOf', () => {
  it.each([
    [0n, 100n, PaymentStatus.UNPAID],
    [40n, 100n, PaymentStatus.PARTIAL],
    [100n, 100n, PaymentStatus.PAID],
    [0n, 0n, PaymentStatus.PAID],
  ])('đã trả %p / tổng %p → %p', (paid, total, expected) => {
    expect(paymentStatusOf(paid, total)).toBe(expected);
  });
});
