import { SEED_BRANCHES, SEED_CATEGORIES, SEED_MANUFACTURERS, SEED_PRODUCTS, SEED_UNITS } from './catalog.seed';

describe('Dữ liệu mẫu chi nhánh', () => {
  it('có đúng 3 chi nhánh', () => {
    expect(SEED_BRANCHES).toHaveLength(3);
  });

  it('mã chi nhánh không trùng nhau', () => {
    const codes = SEED_BRANCHES.map((branch) => branch.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('mọi trường bắt buộc đều có giá trị, không vượt độ dài cột', () => {
    for (const branch of SEED_BRANCHES) {
      expect(branch.code).toMatch(/^CN\d{3}$/);
      expect(branch.name.length).toBeGreaterThan(0);
      expect(branch.name.length).toBeLessThanOrEqual(200);
      expect(branch.phone.length).toBeLessThanOrEqual(20);
      expect(branch.address.length).toBeGreaterThan(0);
      expect(branch.openingHours.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('Dữ liệu mẫu nhóm sản phẩm, hãng sản xuất và đơn vị tính', () => {
  it('có đủ số lượng bản ghi theo kế hoạch', () => {
    expect(SEED_CATEGORIES).toHaveLength(5);
    expect(SEED_MANUFACTURERS).toHaveLength(4);
    expect(SEED_UNITS).toHaveLength(6);
    expect(SEED_PRODUCTS).toHaveLength(10);
  });

  it('mã không trùng trong từng nhóm', () => {
    for (const codes of [
      SEED_CATEGORIES.map((item) => item.code),
      SEED_MANUFACTURERS.map((item) => item.code),
      SEED_UNITS.map((item) => item.code),
      SEED_PRODUCTS.map((item) => item.code),
    ]) {
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('nhóm sản phẩm và đơn vị tính không vượt độ dài cột', () => {
    for (const category of SEED_CATEGORIES) {
      expect(category.code.length).toBeLessThanOrEqual(30);
      expect(category.name.length).toBeLessThanOrEqual(200);
    }
    for (const unit of SEED_UNITS) {
      expect(unit.code.length).toBeLessThanOrEqual(20);
      expect(unit.name.length).toBeLessThanOrEqual(50);
    }
    for (const manufacturer of SEED_MANUFACTURERS) {
      expect(manufacturer.code.length).toBeLessThanOrEqual(30);
      expect(manufacturer.name.length).toBeLessThanOrEqual(200);
      expect(manufacturer.country.length).toBeLessThanOrEqual(100);
    }
  });

  it('mọi tham chiếu theo code của sản phẩm đều tồn tại', () => {
    const categoryCodes = new Set(SEED_CATEGORIES.map((item) => item.code));
    const manufacturerCodes = new Set(SEED_MANUFACTURERS.map((item) => item.code));
    const unitCodes = new Set(SEED_UNITS.map((item) => item.code));

    for (const product of SEED_PRODUCTS) {
      expect(categoryCodes.has(product.categoryCode)).toBe(true);
      if (product.manufacturerCode) expect(manufacturerCodes.has(product.manufacturerCode)).toBe(true);
      expect(unitCodes.has(product.baseUnitCode)).toBe(true);
      for (const unit of product.units) expect(unitCodes.has(unit.unitCode)).toBe(true);
    }
  });

  it('mỗi sản phẩm có đúng một đơn vị cơ bản khớp baseUnitCode và hệ số quy đổi bằng 1', () => {
    for (const product of SEED_PRODUCTS) {
      const baseRows = product.units.filter((unit) => unit.isBaseUnit);
      expect(baseRows).toHaveLength(1);
      expect(baseRows[0].unitCode).toBe(product.baseUnitCode);
      expect(baseRows[0].conversionRate).toBe(1);

      const unitCodes = product.units.map((unit) => unit.unitCode);
      expect(new Set(unitCodes).size).toBe(unitCodes.length);
    }
  });

  it('hệ số quy đổi và giá bán hợp lệ', () => {
    for (const product of SEED_PRODUCTS) {
      expect(product.units.length).toBeGreaterThan(0);
      for (const unit of product.units) {
        expect(unit.conversionRate).toBeGreaterThanOrEqual(1);
        expect(unit.salePrice).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('mã vạch không trùng trên toàn bộ dữ liệu seed', () => {
    const barcodes = [
      ...SEED_PRODUCTS.map((product) => product.barcode),
      ...SEED_PRODUCTS.flatMap((product) => product.units.map((unit) => unit.barcode)),
    ].filter((barcode): barcode is string => Boolean(barcode));

    expect(new Set(barcodes).size).toBe(barcodes.length);
  });

  it('có sản phẩm không có hãng sản xuất và có cả thuốc kê đơn lẫn không kê đơn', () => {
    expect(SEED_PRODUCTS.some((product) => !product.manufacturerCode)).toBe(true);
    expect(SEED_PRODUCTS.some((product) => product.requiresPrescription)).toBe(true);
    expect(SEED_PRODUCTS.some((product) => !product.requiresPrescription)).toBe(true);
  });
});
