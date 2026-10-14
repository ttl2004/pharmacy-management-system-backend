/** Số dòng tối đa của một chứng từ kho — giữ transaction xác nhận dưới `INVENTORY_TX_TIMEOUT_MS`. */
export const MAX_DOCUMENT_LINES = 200;

/**
 * Hạn chót của một transaction kho. Prisma mặc định 5 s ≈ 45 câu lệnh qua pooler Tokyo (~100 ms/câu); các luồng kho
 * viết theo lô nên mỗi lần xác nhận chỉ tốn số câu lệnh cố định, 20 s là biên an toàn chứ không phải ngân sách.
 */
export const INVENTORY_TX_TIMEOUT_MS = 20_000;

/** Chờ lấy kết nối từ pool tối đa bao lâu trước khi báo lỗi. */
export const INVENTORY_TX_MAX_WAIT_MS = 5_000;

/** Lô còn hạn dưới số ngày này thì vẫn cho nhập nhưng trả cảnh báo (K7). */
export const NEAR_EXPIRY_WARNING_DAYS = 90;

/** Loại chứng từ kho → tiền tố mã và SEQUENCE sinh số (tạo trong migration kho). */
export const DOCUMENT_CODE_FORMATS = {
  GOODS_RECEIPT: { prefix: 'PN', sequence: 'goods_receipt_code_seq' },
  STOCK_TRANSFER: { prefix: 'DC', sequence: 'stock_transfer_code_seq' },
  STOCK_ADJUSTMENT: { prefix: 'DCK', sequence: 'stock_adjustment_code_seq' },
} as const;

export type DocumentKind = keyof typeof DOCUMENT_CODE_FORMATS;

/** Tên bảng ghi vào `audit_logs.entityType` — một chỗ khai, tránh gõ sai chuỗi rải rác. */
export const AUDIT_ENTITY = {
  SUPPLIER: 'suppliers',
  GOODS_RECEIPT: 'goods_receipts',
  STOCK_BATCH: 'stock_batches',
  STOCK_TRANSFER: 'stock_transfers',
  STOCK_ADJUSTMENT: 'stock_adjustments',
  BRANCH_PRODUCT: 'branch_products',
} as const;
