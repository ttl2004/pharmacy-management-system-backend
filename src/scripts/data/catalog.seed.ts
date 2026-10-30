import type { DosageForm } from '@prisma/client';

/**
 * Dữ liệu nền của nhà thuốc. Tách khỏi script để test đọc được mà không chạy bootstrap().
 * `code` là khoá upsert — đổi code là tạo bản ghi mới chứ không cập nhật bản ghi cũ.
 */
export const SEED_BRANCHES = [
  {
    code: 'CN001',
    name: 'Nhà thuốc Trung tâm',
    phone: '0243123456',
    address: '123 Phố Huế, Hai Bà Trưng, Hà Nội',
    openingHours: '07:00 - 22:00',
  },
  {
    code: 'CN002',
    name: 'Nhà thuốc Cầu Giấy',
    phone: '0243234567',
    address: '45 Xuân Thuỷ, Cầu Giấy, Hà Nội',
    openingHours: '07:00 - 22:00',
  },
  {
    code: 'CN003',
    name: 'Nhà thuốc Hà Đông',
    phone: '0243345678',
    address: '78 Quang Trung, Hà Đông, Hà Nội',
    openingHours: '07:30 - 21:30',
  },
] as const;

export const SEED_CATEGORIES = [
  { code: 'THUOC_KE_DON', name: 'Thuốc kê đơn', sortOrder: 1 },
  { code: 'THUOC_KHONG_KE_DON', name: 'Thuốc không kê đơn', sortOrder: 2 },
  { code: 'THUC_PHAM_CHUC_NANG', name: 'Thực phẩm chức năng', sortOrder: 3 },
  { code: 'THIET_BI_Y_TE', name: 'Thiết bị y tế', sortOrder: 4 },
  { code: 'MY_PHAM', name: 'Mỹ phẩm', sortOrder: 5 },
] as const;

export const SEED_MANUFACTURERS = [
  { code: 'DHG', name: 'Công ty Cổ phần Dược Hậu Giang', country: 'Việt Nam' },
  { code: 'TAPHARM', name: 'Công ty Cổ phần Dược phẩm Trung ương I', country: 'Việt Nam' },
  { code: 'SANOFI', name: 'Sanofi', country: 'Pháp' },
  { code: 'GSK', name: 'GlaxoSmithKline', country: 'Anh' },
] as const;

export const SEED_UNITS = [
  { code: 'VIEN', name: 'Viên' },
  { code: 'VI', name: 'Vỉ' },
  { code: 'HOP', name: 'Hộp' },
  { code: 'CHAI', name: 'Chai' },
  { code: 'TUYP', name: 'Tuýp' },
  { code: 'GOI', name: 'Gói' },
] as const;

export interface SeedProductUnit {
  unitCode: string;
  conversionRate: number;
  salePrice: number;
  isBaseUnit: boolean;
  barcode: string | null;
}

export interface SeedProduct {
  code: string;
  barcode?: string;
  name: string;
  categoryCode: string;
  manufacturerCode?: string | null;
  baseUnitCode: string;
  /** Mã thuốc trong API mô phỏng CSDL Dược (`CSDL-Drug/Data/tap-mau-thuoc.csv`). Bắt buộc với hàng thuốc. */
  drugCode?: string;
  dosageForm?: DosageForm | null;
  packagingSpec?: string;
  /** Cờ kê đơn mong đợi — script đối chiếu với thuốc trong danh mục, lệch thì dừng (ghép nhầm thuốc). */
  requiresPrescription: boolean;
  minStockLevel?: number;
  units: SeedProductUnit[];
}

/**
 * Sản phẩm mẫu. Khoá ngoại ghi bằng **code** để script tự tra id — không hard-code UUID môi trường.
 * `units` là trạng thái đầy đủ của cấu hình đơn vị bán, đúng ngữ nghĩa replace-all của API.
 * Hàng thuốc ghép với thuốc có sẵn trong API mô phỏng CSDL Dược; giữ mã SP và đơn vị vì seed kho tham chiếu theo đó.
 */
export const SEED_PRODUCTS: readonly SeedProduct[] = [
  {
    code: 'SP0001',
    barcode: '8935000000015',
    name: 'Acetaminophen 500mg',
    categoryCode: 'THUOC_KHONG_KE_DON',
    manufacturerCode: 'DHG',
    baseUnitCode: 'VIEN',
    drugCode: '0536-1292',
    dosageForm: 'TABLET',
    packagingSpec: 'Hộp 10 vỉ x 10 viên',
    requiresPrescription: false,
    minStockLevel: 100,
    units: [
      { unitCode: 'VIEN', conversionRate: 1, salePrice: 500, isBaseUnit: true, barcode: null },
      { unitCode: 'VI', conversionRate: 10, salePrice: 4500, isBaseUnit: false, barcode: '8935000000022' },
      { unitCode: 'HOP', conversionRate: 100, salePrice: 42000, isBaseUnit: false, barcode: '8935000000039' },
    ],
  },
  {
    code: 'SP0002',
    name: 'Amoxicillin 500mg',
    categoryCode: 'THUOC_KE_DON',
    manufacturerCode: 'TAPHARM',
    baseUnitCode: 'VIEN',
    drugCode: '62135-083',
    dosageForm: 'CAPSULE',
    packagingSpec: 'Hộp 10 vỉ x 10 viên',
    requiresPrescription: true,
    minStockLevel: 80,
    units: [
      { unitCode: 'VIEN', conversionRate: 1, salePrice: 1200, isBaseUnit: true, barcode: null },
      { unitCode: 'VI', conversionRate: 10, salePrice: 11000, isBaseUnit: false, barcode: null },
      { unitCode: 'HOP', conversionRate: 100, salePrice: 105000, isBaseUnit: false, barcode: null },
    ],
  },
  {
    code: 'SP0003',
    name: 'Siro ho Delsym 30mg/5mL',
    categoryCode: 'THUOC_KHONG_KE_DON',
    manufacturerCode: 'SANOFI',
    baseUnitCode: 'CHAI',
    drugCode: '63824-175',
    dosageForm: 'SYRUP',
    packagingSpec: 'Hộp 1 chai x 89 mL',
    requiresPrescription: false,
    minStockLevel: 30,
    units: [{ unitCode: 'CHAI', conversionRate: 1, salePrice: 78000, isBaseUnit: true, barcode: '8935000000046' }],
  },
  {
    code: 'SP0004',
    name: 'Kem trị nấm Terbinafine 1%',
    categoryCode: 'THUOC_KHONG_KE_DON',
    manufacturerCode: 'GSK',
    baseUnitCode: 'TUYP',
    drugCode: '50090-5810',
    dosageForm: 'CREAM',
    packagingSpec: 'Hộp 1 tuýp x 30 g',
    requiresPrescription: false,
    minStockLevel: 20,
    units: [{ unitCode: 'TUYP', conversionRate: 1, salePrice: 145000, isBaseUnit: true, barcode: null }],
  },
  {
    code: 'SP0005',
    name: 'Kem Ketoconazole 2%',
    categoryCode: 'THUOC_KE_DON',
    manufacturerCode: 'GSK',
    baseUnitCode: 'TUYP',
    drugCode: '70518-4236',
    dosageForm: 'CREAM',
    packagingSpec: 'Hộp 1 tuýp x 30 g',
    requiresPrescription: true,
    minStockLevel: 20,
    units: [{ unitCode: 'TUYP', conversionRate: 1, salePrice: 25000, isBaseUnit: true, barcode: null }],
  },
  {
    code: 'SP0006',
    name: 'Xịt mũi Nasal 0,05%',
    categoryCode: 'THUOC_KHONG_KE_DON',
    manufacturerCode: 'TAPHARM',
    baseUnitCode: 'CHAI',
    drugCode: '11822-6378',
    dosageForm: 'SPRAY',
    packagingSpec: 'Hộp 1 chai x 30 mL',
    requiresPrescription: false,
    minStockLevel: 50,
    units: [
      { unitCode: 'CHAI', conversionRate: 1, salePrice: 12000, isBaseUnit: true, barcode: null },
      { unitCode: 'HOP', conversionRate: 24, salePrice: 270000, isBaseUnit: false, barcode: null },
    ],
  },
  {
    code: 'SP0007',
    name: 'Bột nhuận tràng Purelax 17g',
    categoryCode: 'THUOC_KHONG_KE_DON',
    manufacturerCode: 'TAPHARM',
    baseUnitCode: 'GOI',
    drugCode: '59779-306',
    dosageForm: 'POWDER',
    packagingSpec: 'Hộp 20 gói x 17 g',
    requiresPrescription: false,
    minStockLevel: 60,
    units: [
      { unitCode: 'GOI', conversionRate: 1, salePrice: 3500, isBaseUnit: true, barcode: null },
      { unitCode: 'HOP', conversionRate: 20, salePrice: 65000, isBaseUnit: false, barcode: null },
    ],
  },
  {
    code: 'SP0008',
    name: 'Fluconazole 100mg',
    categoryCode: 'THUOC_KE_DON',
    manufacturerCode: 'SANOFI',
    baseUnitCode: 'VIEN',
    drugCode: '70518-2415',
    dosageForm: 'TABLET',
    packagingSpec: 'Hộp 12 viên',
    requiresPrescription: true,
    minStockLevel: 15,
    units: [
      { unitCode: 'VIEN', conversionRate: 1, salePrice: 15000, isBaseUnit: true, barcode: null },
      { unitCode: 'HOP', conversionRate: 12, salePrice: 175000, isBaseUnit: false, barcode: null },
    ],
  },
  {
    code: 'SP0009',
    name: 'Hỗn dịch Cefdinir 125mg/5mL',
    categoryCode: 'THUOC_KE_DON',
    manufacturerCode: 'DHG',
    baseUnitCode: 'CHAI',
    drugCode: '68071-5318',
    dosageForm: 'OTHER',
    packagingSpec: 'Hộp 1 chai x 100 mL',
    requiresPrescription: true,
    minStockLevel: 40,
    units: [{ unitCode: 'CHAI', conversionRate: 1, salePrice: 18000, isBaseUnit: true, barcode: null }],
  },
  {
    code: 'SP0010',
    name: 'Khẩu trang y tế 4 lớp',
    categoryCode: 'THIET_BI_Y_TE',
    manufacturerCode: null,
    baseUnitCode: 'HOP',
    dosageForm: null,
    packagingSpec: 'Hộp 50 chiếc',
    requiresPrescription: false,
    minStockLevel: 200,
    units: [
      { unitCode: 'HOP', conversionRate: 1, salePrice: 45000, isBaseUnit: true, barcode: null },
      { unitCode: 'GOI', conversionRate: 10, salePrice: 420000, isBaseUnit: false, barcode: null },
    ],
  },
];
