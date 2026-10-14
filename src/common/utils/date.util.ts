/**
 * Chuẩn hoá thời gian ở tầng API.
 *
 * `createdAt` / `updatedAt` là `Date` (Prisma `DateTime`). Ra tới client thì chúng phải
 * là chuỗi ISO 8601 — việc chuyển đổi chỉ diễn ra một lần ở `TransformInterceptor`,
 * không rải rác trong từng service. Hàm vẫn nhận cả epoch milliseconds để tương thích
 * với dữ liệu cũ.
 */

/**
 * Tên các field chứa thời gian cần chuyển sang ISO 8601 khi trả về client.
 * Entity có thêm mốc thời gian mới thì bổ sung tên field vào đây.
 */
export const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set(['createdAt', 'updatedAt']);

/**
 * Cột `@db.Date` (ngày không giờ) trả về dạng `YYYY-MM-DD` thay vì ISO đầy đủ `…T00:00:00.000Z` — client không
 * phải tự cắt và không hiểu nhầm thành nửa đêm UTC. Cố ý KHÔNG có `dateOfBirth`: API người dùng đã phát hành
 * với định dạng ISO đầy đủ, đổi là phá hợp đồng.
 */
export const DATE_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'expiryDate',
  'manufacturingDate',
  'supplierInvoiceDate',
  'nearestExpiry',
]);

/**
 * `BigInt` (tổng tiền phiếu nhập) → `number`. `JSON.stringify` ném lỗi với `bigint`, nên phải đổi ở đây. Tiền VND
 * vượt `Number.MAX_SAFE_INTEGER` (~9 triệu tỷ) là dữ liệu hỏng — trả chuỗi để không âm thầm làm tròn sai.
 */
function bigintToJson(value: bigint): number | string {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
}

/** Chuyển epoch milliseconds (hoặc `Date`) sang chuỗi ISO 8601. */
export function toIsoString(value: number | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Giá trị đọc được thành thời điểm: epoch milliseconds hoặc `Date`. */
function isTimestamp(value: unknown): value is number | Date {
  return (typeof value === 'number' && Number.isFinite(value)) || value instanceof Date;
}

/**
 * Kiểu tự lo việc serialize của nó (`Date`, `Buffer`... đều có `toJSON`).
 * Đi sâu vào những giá trị này sẽ làm hỏng dữ liệu — ví dụ `Buffer` sẽ biến thành
 * object đánh số từng byte thay vì chuỗi base64.
 */
function hasOwnSerializer(value: object): boolean {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

/**
 * Trả về bản sao của `payload` với mọi field thời gian đã đổi sang ISO 8601.
 *
 * Duyệt theo đúng cách `JSON.stringify` đi qua dữ liệu: chỉ vào object/array, chỉ
 * lấy thuộc tính riêng và enumerable. Object không có `toJSON` (kể cả entity) được
 * trả về dạng plain object. `null` / `undefined` giữ nguyên, nên `updatedAt` chưa
 * từng được ghi vẫn là `null` chứ không thành chuỗi.
 */
export function serializeTimestamps<T>(payload: T): T {
  if (typeof payload === 'bigint') return bigintToJson(payload) as unknown as T;

  if (Array.isArray(payload)) {
    return (payload as unknown[]).map((item) => serializeTimestamps(item)) as unknown as T;
  }

  if (payload === null || typeof payload !== 'object' || hasOwnSerializer(payload)) {
    return payload;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (DATE_ONLY_FIELDS.has(key) && value instanceof Date) {
      result[key] = value.toISOString().slice(0, 10);
    } else {
      result[key] = TIMESTAMP_FIELDS.has(key) && isTimestamp(value) ? toIsoString(value) : serializeTimestamps(value);
    }
  }

  return result as unknown as T;
}
