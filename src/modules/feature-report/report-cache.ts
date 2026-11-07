/** Chỗ cắm cache báo cáo: hiện chạy trong RAM, đổi sang Redis chỉ cần một provider mới (xem plan A.4). */
export interface ReportCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
}

export const REPORT_CACHE = Symbol('REPORT_CACHE');

/** Cache trong RAM theo từng tiến trình: TTL theo khoá, tối đa `MAX_KEYS` khoá (đầy thì xoá khoá cũ nhất). */
export class InMemoryReportCache implements ReportCache {
  static readonly MAX_KEYS = 500;

  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  /** `now` cho phép test cố định thời gian. */
  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Xoá trước khi ghi: khoá ghi lại thành "mới nhất" theo thứ tự chèn của Map.
    this.entries.delete(key);
    while (this.entries.size >= InMemoryReportCache.MAX_KEYS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}
