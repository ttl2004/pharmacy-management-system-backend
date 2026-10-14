import { ReceiptStatus } from '@prisma/client';

/**
 * Dữ liệu kho mẫu. Tách khỏi script để test kiểm được tham chiếu mà không chạy bootstrap().
 * Khoá ngoại ghi bằng **code** (chi nhánh, sản phẩm, đơn vị) — script tự tra id.
 */
export const SEED_SUPPLIERS = [
  {
    code: 'NCC001',
    name: 'Công ty Cổ phần Dược phẩm Trung ương 1',
    phone: '02438251234',
    taxCode: '0100109106',
    contactName: 'Phòng kinh doanh',
    address: '160 Tôn Đức Thắng, Đống Đa, Hà Nội',
  },
  {
    code: 'NCC002',
    name: 'Công ty TNHH Phân phối Dược Hậu Giang',
    phone: '02923891433',
    taxCode: '1800156801',
    contactName: 'Bộ phận đơn hàng',
    address: '288 Bis Nguyễn Văn Cừ, Ninh Kiều, Cần Thơ',
  },
  {
    code: 'NCC003',
    name: 'Công ty Cổ phần Thiết bị Y tế Hà Nội',
    phone: '02437831111',
    taxCode: '0101234567',
    contactName: 'Kho tổng',
    address: '12 Láng Hạ, Ba Đình, Hà Nội',
  },
] as const;

export interface SeedStockLine {
  productCode: string;
  /** Đơn vị nhập — phải là một đơn vị bán của sản phẩm. */
  unitCode: string;
  quantity: number;
  importPrice: number;
  batchNumber: string;
  /** Hạn dùng = hôm nay (giờ VN) + số ngày — tính lúc chạy để dữ liệu không tự "già" đi. */
  expiresInDays: number;
}

export interface SeedOpeningStock {
  branchCode: string;
  supplierCode: string;
  lines: SeedStockLine[];
}

/** Ghi chú đánh dấu phiếu nhập do seed tạo — chạy lại script thì bỏ qua chi nhánh đã có phiếu này. */
export const SEED_RECEIPT_NOTE = 'SEED_OPENING_STOCK';

/**
 * Việc cần làm với tồn đầu kỳ của một chi nhánh, theo phiếu seed đã có (nếu có). Lập và xác nhận là hai transaction:
 * lần chạy trước có thể dừng giữa chừng để lại phiếu NHÁP — chạy lại phải xác nhận nốt chứ không bỏ qua.
 */
export function openingStockAction(existing: { status: ReceiptStatus } | null): 'create' | 'confirm' | 'skip' {
  if (!existing || existing.status === ReceiptStatus.CANCELLED) return 'create';
  if (existing.status === ReceiptStatus.DRAFT) return 'confirm';
  return 'skip';
}

/**
 * Tồn đầu kỳ: đủ để demo FEFO (hai lô cùng sản phẩm, một lô cận date), cảnh báo cận date, sắp hết hàng
 * (CN003 ít hàng), và điều chuyển giữa các chi nhánh.
 */
export const SEED_OPENING_STOCK: readonly SeedOpeningStock[] = [
  {
    branchCode: 'CN001',
    supplierCode: 'NCC001',
    lines: [
      {
        productCode: 'SP0001',
        unitCode: 'HOP',
        quantity: 20,
        importPrice: 38000,
        batchNumber: 'PARA-2601',
        expiresInDays: 540,
      },
      {
        productCode: 'SP0001',
        unitCode: 'HOP',
        quantity: 2,
        importPrice: 36000,
        batchNumber: 'PARA-2509',
        expiresInDays: 45,
      },
      {
        productCode: 'SP0002',
        unitCode: 'HOP',
        quantity: 5,
        importPrice: 95000,
        batchNumber: 'AMOX-2602',
        expiresInDays: 400,
      },
      {
        productCode: 'SP0008',
        unitCode: 'HOP',
        quantity: 4,
        importPrice: 160000,
        batchNumber: 'POLY-2603',
        expiresInDays: 300,
      },
      {
        productCode: 'SP0009',
        unitCode: 'CHAI',
        quantity: 60,
        importPrice: 15000,
        batchNumber: 'NACL-2604',
        expiresInDays: 700,
      },
    ],
  },
  {
    branchCode: 'CN002',
    supplierCode: 'NCC002',
    lines: [
      {
        productCode: 'SP0001',
        unitCode: 'HOP',
        quantity: 10,
        importPrice: 38500,
        batchNumber: 'PARA-2601',
        expiresInDays: 540,
      },
      {
        productCode: 'SP0010',
        unitCode: 'HOP',
        quantity: 300,
        importPrice: 38000,
        batchNumber: 'KT-2605',
        expiresInDays: 1000,
      },
      {
        productCode: 'SP0009',
        unitCode: 'CHAI',
        quantity: 20,
        importPrice: 15500,
        batchNumber: 'NACL-2604',
        expiresInDays: 700,
      },
    ],
  },
  {
    branchCode: 'CN003',
    supplierCode: 'NCC003',
    lines: [
      {
        productCode: 'SP0001',
        unitCode: 'VI',
        quantity: 5,
        importPrice: 3900,
        batchNumber: 'PARA-2601',
        expiresInDays: 540,
      },
      {
        productCode: 'SP0010',
        unitCode: 'HOP',
        quantity: 50,
        importPrice: 39000,
        batchNumber: 'KT-2605',
        expiresInDays: 1000,
      },
    ],
  },
];
