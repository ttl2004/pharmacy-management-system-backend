import { ErrorCode } from 'src/common/types/error-code';
import { PurchaseReturnMoneyService, returnPriceCap } from './purchase-return-money.service';

const TX = { marker: 'tx' } as never;
const SUPPLIER = 's1';
const BRANCH = 'b1';

const batch = (over: Record<string, unknown> = {}) => ({
  id: 'batch1',
  productId: 'p1',
  quantityOnHand: 500,
  batchNumber: 'L1',
  importPrice: 700,
  supplierId: SUPPLIER,
  ...over,
});

/** Phiếu nhập gốc: 1 dòng nhập theo Hộp 120.000, chiết khấu dòng 20.000, hệ số 100 → trần 1.000/viên. */
const receipt = () => ({
  id: 'r1',
  code: 'PN1',
  branchId: BRANCH,
  supplierId: SUPPLIER,
  status: 'CONFIRMED',
  expenses: null,
  items: [
    {
      id: 'ri1',
      productId: 'p1',
      batchNumber: 'L1',
      baseQuantity: 1000,
      importPrice: 120000,
      unitDiscount: 20000,
      conversionRate: 100,
      product: { name: 'Thuốc A' },
    },
  ],
});

function make(debt = { scoped: 100_000n, chain: 100_000n }) {
  const returns = {
    findReceipt: jest.fn().mockResolvedValue(receipt()),
    returnedByReceiptItem: jest.fn().mockResolvedValue(new Map()),
    refundedByCode: jest.fn().mockResolvedValue(new Map()),
  };
  const debts = { debtOf: jest.fn().mockResolvedValue(debt) };
  const service = new PurchaseReturnMoneyService(returns as never, debts as never);
  return { service, returns, debts };
}

const build = (
  service: PurchaseReturnMoneyService,
  line: { item?: Record<string, unknown>; batch?: Record<string, unknown> },
  dto: Record<string, unknown> = {},
) =>
  service.build(TX, {
    dto: { items: [], ...dto } as never,
    branchId: BRANCH,
    supplierId: SUPPLIER,
    lines: [{ batch: batch(line.batch) as never, quantity: 10, item: { batchId: 'batch1', ...line.item } as never }],
  });

describe('returnPriceCap', () => {
  it('có dòng nhập: ceil((giá − chiết khấu dòng) / hệ số); không có: giá vốn lô', () => {
    expect(returnPriceCap({ importPrice: 120000, unitDiscount: 20000, conversionRate: 100 }, 700)).toBe(1000);
    expect(returnPriceCap({ importPrice: 100001, unitDiscount: 0, conversionRate: 100 }, 700)).toBe(1001);
    expect(returnPriceCap(null, 700)).toBe(700);
  });
});

describe('PurchaseReturnMoneyService.build — trần giá trả', () => {
  it('returnPrice vượt giá vốn lô (không kèm phiếu nhập) → 1002', async () => {
    const { service } = make();
    await expect(build(service, { item: { returnPrice: 701 } })).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    await expect(build(service, { item: { returnPrice: 700 } })).resolves.toBeDefined();
  });

  it('kèm phiếu nhập Hộp 120000, CK dòng 20000, hệ số 100 → trần 1000/viên; 1000 OK, 1001 → 1002', async () => {
    const { service } = make();
    const dto = { goodsReceiptId: 'r1' };
    const item = (returnPrice: number) => ({ goodsReceiptItemId: 'ri1', returnPrice });
    await expect(build(service, { item: item(1000) }, dto)).resolves.toBeDefined();
    await expect(build(service, { item: item(1001) }, dto)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
  });

  it('không gửi returnPrice → dùng giá vốn lô như cũ', async () => {
    const { service } = make();
    const { lineMoney, header } = await build(service, {});
    expect(lineMoney.get('batch1')?.returnPrice).toBe(700);
    expect(header.goodsAmount).toBe(7000n);
  });
});

describe('PurchaseReturnMoneyService.build — đúng NCC của lô', () => {
  it('trả không kèm phiếu nhập, lô thuộc NCC khác → 1602', async () => {
    const { service } = make();
    await expect(build(service, { batch: { supplierId: 'other' } })).rejects.toMatchObject({
      errorCode: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('lô không có NCC (dữ liệu cũ) vẫn trả được', async () => {
    const { service } = make();
    await expect(build(service, { batch: { supplierId: null } })).resolves.toBeDefined();
  });
});

describe('PurchaseReturnMoneyService.assertDebtStaysNonNegative', () => {
  const head = { supplierId: SUPPLIER, branchId: BRANCH, totalAmount: 60_000n, supplierPaid: 10_000n };

  it('nợ tại chi nhánh sau khi trừ phiếu này (đã tính trong tx) âm → 1002', async () => {
    const { service, debts } = make({ scoped: -1n, chain: 5n });
    await expect(service.assertDebtStaysNonNegative(TX, head)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    expect(debts.debtOf).toHaveBeenCalledWith(SUPPLIER, BRANCH, TX);
  });

  it('nợ về đúng 0 hoặc dương → qua', async () => {
    await expect(make({ scoped: 0n, chain: 0n }).service.assertDebtStaysNonNegative(TX, head)).resolves.toBeUndefined();
  });

  it('phiếu không làm giảm nợ (NCC hoàn đủ tiền) → không kiểm, không đọc nợ', async () => {
    const { service, debts } = make({ scoped: -5n, chain: -5n });
    await service.assertDebtStaysNonNegative(TX, { ...head, supplierPaid: 60_000n });
    expect(debts.debtOf).not.toHaveBeenCalled();
  });
});
