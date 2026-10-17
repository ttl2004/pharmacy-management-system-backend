/** Số dòng tối đa của một đơn — giữ transaction dưới hạn của `InventoryTransactions`. */
export const MAX_ORDER_LINES = 100;

/** Số lượng tối đa của một dòng theo đơn vị bán. Trần thật theo đơn vị cơ bản vẫn là `MAX_BASE_QUANTITY` của kho. */
export const MAX_LINE_QUANTITY = 10_000;

/** Đơn tại quầy PENDING không ai thao tác quá chừng này phút thì tự huỷ để nhả hàng đang giữ (luật S8). */
export const POS_ABANDON_MINUTES = 30;

/** Số đơn tối đa job tự huỷ xử lý mỗi lượt — lượt sau làm tiếp, không giữ kết nối quá lâu. */
export const EXPIRY_BATCH_SIZE = 50;

/** Tên bảng ghi vào `audit_logs.entityType`. */
export const SALES_AUDIT_ENTITY = {
  ORDER: 'orders',
  /** Hồ sơ khách do hệ thống tạo khi bán tại quầy. */
  USER: 'users',
} as const;
