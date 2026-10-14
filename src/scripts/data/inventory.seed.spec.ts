import { SEED_BRANCHES, SEED_PRODUCTS } from './catalog.seed';
import { ReceiptStatus } from '@prisma/client';
import { openingStockAction, SEED_OPENING_STOCK, SEED_SUPPLIERS } from './inventory.seed';

describe('Dữ liệu kho mẫu', () => {
  it('mã nhà cung cấp không trùng, đúng định dạng, vừa độ dài cột', () => {
    const codes = SEED_SUPPLIERS.map((supplier) => supplier.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const supplier of SEED_SUPPLIERS) {
      expect(supplier.code).toMatch(/^[A-Z0-9_-]+$/);
      expect(supplier.code.length).toBeLessThanOrEqual(30);
      expect(supplier.name.length).toBeLessThanOrEqual(200);
      expect(supplier.taxCode.length).toBeLessThanOrEqual(20);
    }
  });

  it('mọi tham chiếu theo code đều tồn tại và đơn vị nhập là đơn vị bán của sản phẩm', () => {
    const branches = new Set<string>(SEED_BRANCHES.map((branch) => branch.code));
    const suppliers = new Set<string>(SEED_SUPPLIERS.map((supplier) => supplier.code));
    const products = new Map(SEED_PRODUCTS.map((product) => [product.code, product]));

    for (const stock of SEED_OPENING_STOCK) {
      expect(branches.has(stock.branchCode)).toBe(true);
      expect(suppliers.has(stock.supplierCode)).toBe(true);
      for (const line of stock.lines) {
        const product = products.get(line.productCode);
        expect(product).toBeDefined();
        expect(product?.units.map((unit) => unit.unitCode)).toContain(line.unitCode);
      }
    }
  });

  it('mỗi chi nhánh không có hai dòng cùng sản phẩm + số lô (phiếu nhập sẽ từ chối)', () => {
    for (const stock of SEED_OPENING_STOCK) {
      const keys = stock.lines.map((line) => `${line.productCode}|${line.batchNumber}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('cùng số lô ở nhiều chi nhánh phải cùng hạn dùng — để điều chuyển gộp lô được', () => {
    const expiry = new Map<string, number>();
    for (const line of SEED_OPENING_STOCK.flatMap((stock) => stock.lines)) {
      const key = `${line.productCode}|${line.batchNumber}`;
      if (expiry.has(key)) expect(expiry.get(key)).toBe(line.expiresInDays);
      expiry.set(key, line.expiresInDays);
    }
  });

  it('mọi lô đều còn hạn khi nhập (K7 cấm nhập lô hết hạn)', () => {
    for (const line of SEED_OPENING_STOCK.flatMap((stock) => stock.lines)) {
      expect(line.expiresInDays).toBeGreaterThan(0);
    }
  });
});

describe('seed:inventory chạy lại', () => {
  it('chưa có phiếu seed (hoặc phiếu seed đã huỷ) → tạo mới', () => {
    expect(openingStockAction(null)).toBe('create');
    expect(openingStockAction({ status: ReceiptStatus.CANCELLED })).toBe('create');
  });

  it('lần trước dừng giữa chừng để lại phiếu NHÁP → xác nhận nốt, không bỏ qua', () => {
    expect(openingStockAction({ status: ReceiptStatus.DRAFT })).toBe('confirm');
  });

  it('đã xác nhận → bỏ qua (không nhân đôi tồn)', () => {
    expect(openingStockAction({ status: ReceiptStatus.CONFIRMED })).toBe('skip');
  });
});
