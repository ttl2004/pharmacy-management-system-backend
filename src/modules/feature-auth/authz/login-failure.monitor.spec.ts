import { LoginFailureMonitor } from './login-failure.monitor';

const T0 = Date.UTC(2026, 10, 4, 8, 0, 0);

describe('LoginFailureMonitor', () => {
  it('19 lần không burst, lần 20 burst, lần 21 không burst lại', () => {
    const monitor = new LoginFailureMonitor();
    for (let i = 1; i <= 19; i++) expect(monitor.recordUnknownUsername('1.1.1.1', T0 + i)).toEqual({ burst: false });
    expect(monitor.recordUnknownUsername('1.1.1.1', T0 + 20)).toEqual({
      burst: true,
      count: 20,
      windowStart: new Date(T0 + 1),
    });
    expect(monitor.recordUnknownUsername('1.1.1.1', T0 + 21)).toEqual({ burst: false });
  });

  it('qua cửa sổ mới đếm lại', () => {
    const monitor = new LoginFailureMonitor();
    for (let i = 0; i < 19; i++) monitor.recordUnknownUsername('1.1.1.1', T0);
    const later = T0 + LoginFailureMonitor.WINDOW_MS;
    for (let i = 0; i < 19; i++) expect(monitor.recordUnknownUsername('1.1.1.1', later)).toEqual({ burst: false });
    expect(monitor.recordUnknownUsername('1.1.1.1', later)).toMatchObject({ burst: true, count: 20 });
  });

  it('khác IP khác key; ip null gộp thành "-"', () => {
    const monitor = new LoginFailureMonitor();
    for (let i = 0; i < 19; i++) monitor.recordUnknownUsername('1.1.1.1', T0);
    expect(monitor.recordUnknownUsername('2.2.2.2', T0)).toEqual({ burst: false });
    for (let i = 0; i < 19; i++) monitor.recordUnknownUsername(null, T0);
    expect(monitor.recordUnknownUsername(null, T0)).toMatchObject({ burst: true });
  });

  it('vượt MAX_KEYS xoá key cũ nhất, không clear toàn bộ', () => {
    const monitor = new LoginFailureMonitor();
    // Key "first" đã đếm 19 lần; các key mới chèn sau nó.
    for (let i = 0; i < 19; i++) monitor.recordUnknownUsername('first', T0);
    for (let i = 0; i < LoginFailureMonitor.MAX_KEYS - 1; i++) monitor.recordUnknownUsername(`ip-${i}`, T0);
    // Còn đủ chỗ: 'first' vẫn nhớ 19 lần → lần 20 burst.
    expect(monitor.size).toBe(LoginFailureMonitor.MAX_KEYS);
    monitor.recordUnknownUsername('ip-new', T0); // vượt → xoá 'first' (cũ nhất)
    expect(monitor.size).toBe(LoginFailureMonitor.MAX_KEYS);
    expect(monitor.recordUnknownUsername('first', T0)).toEqual({ burst: false }); // đếm lại từ 1 (key cũ nhất đã bị xoá)
    // Key khác không bị xoá: ip-5 còn nhớ 1 lần, không bị clear.
    expect(monitor.has('ip-5')).toBe(true);
  });
});
