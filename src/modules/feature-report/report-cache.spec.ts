import { InMemoryReportCache } from './report-cache';

describe('InMemoryReportCache', () => {
  let now = 1_000_000;
  const cache = () => new InMemoryReportCache(() => now);

  beforeEach(() => {
    now = 1_000_000;
  });

  it('trả giá trị đã lưu trong TTL, hết TTL thì undefined', () => {
    const c = cache();
    c.set('a', { n: 1 }, 60_000);
    expect(c.get('a')).toEqual({ n: 1 });
    now += 59_999;
    expect(c.get('a')).toEqual({ n: 1 });
    now += 1;
    expect(c.get('a')).toBeUndefined();
  });

  it('quá 500 khoá xoá khoá cũ nhất', () => {
    const c = cache();
    for (let i = 0; i < InMemoryReportCache.MAX_KEYS; i++) c.set(`k${i}`, i, 60_000);
    expect(c.get('k0')).toBe(0);
    c.set('moi', 'x', 60_000);
    expect(c.size).toBe(InMemoryReportCache.MAX_KEYS);
    expect(c.get('k0')).toBeUndefined();
    expect(c.get('k1')).toBe(1);
    expect(c.get('moi')).toBe('x');
  });

  it('ghi đè khoá có sẵn không đẩy khoá khác ra và làm khoá đó thành mới nhất', () => {
    const c = cache();
    for (let i = 0; i < InMemoryReportCache.MAX_KEYS; i++) c.set(`k${i}`, i, 60_000);
    c.set('k0', 'moi', 60_000);
    expect(c.size).toBe(InMemoryReportCache.MAX_KEYS);
    c.set('k-extra', 1, 60_000);
    expect(c.get('k0')).toBe('moi');
    expect(c.get('k1')).toBeUndefined();
  });
});
