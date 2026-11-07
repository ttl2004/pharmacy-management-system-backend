import { Injectable } from '@nestjs/common';

interface Window {
  start: number;
  count: number;
}

/**
 * Đếm lần đăng nhập sai bằng username KHÔNG tồn tại theo IP (D3). Không ghi từng lần — kẻ dò username sẽ làm đầy
 * bảng — mà chỉ báo đúng một lần khi một IP chạm ngưỡng trong cửa sổ cố định.
 *
 * Nằm trong RAM của từng instance: chạy nhiều instance thì mỗi instance đếm riêng (ngưỡng thực tế cao hơn tối đa
 * N lần). Chấp nhận được vì đây chỉ là tín hiệu cảnh báo, không chặn ai; `ThrottlerGuard` vẫn là lớp chặn.
 */
@Injectable()
export class LoginFailureMonitor {
  static readonly BURST_THRESHOLD = 20;
  static readonly WINDOW_MS = 10 * 60_000;
  static readonly MAX_KEYS = 10_000;

  // Map giữ thứ tự chèn; key bị xoá rồi chèn lại thì thành key mới nhất.
  private readonly windows = new Map<string, Window>();

  get size(): number {
    return this.windows.size;
  }
  has(ip: string | null): boolean {
    return this.windows.has(ip ?? '-');
  }

  /** Trả `burst` đúng MỘT lần khi `count` chạm `BURST_THRESHOLD` trong cửa sổ; các lần sau trong cửa sổ không báo lại. */
  recordUnknownUsername(
    ip: string | null,
    now: number = Date.now(),
  ): { burst: false } | { burst: true; count: number; windowStart: Date } {
    const key = ip ?? '-';
    let window = this.windows.get(key);
    if (!window || now - window.start >= LoginFailureMonitor.WINDOW_MS) {
      this.windows.delete(key);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
      this.evictOldest();
    }
    window.count++;
    if (window.count === LoginFailureMonitor.BURST_THRESHOLD) {
      return { burst: true, count: window.count, windowStart: new Date(window.start) };
    }
    return { burst: false };
  }

  /** Quá `MAX_KEYS` thì bỏ key cũ nhất theo thứ tự chèn — không `clear()` để không quên các IP đang dò dở. */
  private evictOldest(): void {
    while (this.windows.size > LoginFailureMonitor.MAX_KEYS) {
      const oldest = this.windows.keys().next().value as string;
      this.windows.delete(oldest);
    }
  }
}
