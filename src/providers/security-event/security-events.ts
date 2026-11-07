/** Mức nghiêm trọng: 0 thường, 1 đáng chú ý, 2 nghi vấn tấn công. */
export type SecuritySeverity = 0 | 1 | 2;
export type SecurityOutcome = 'SUCCESS' | 'DENIED' | 'FAILED';

/**
 * Danh mục sự kiện bảo mật (v2.1 B.4). Chỉ ghi cho nhân viên (D2) — riêng `LOGIN_FAILED_BURST` không có người dùng.
 * `outcome` khớp CHECK của cột `security_events.outcome`.
 */
export const SECURITY_EVENTS = {
  'AUTH.LOGIN_OK': { severity: 0, outcome: 'SUCCESS' },
  'AUTH.LOGIN_FAILED': { severity: 1, outcome: 'FAILED' },
  'AUTH.LOGIN_FAILED_BURST': { severity: 2, outcome: 'DENIED' },
  'AUTH.BRUTE_FORCE_SUSPECTED': { severity: 2, outcome: 'DENIED' },
  'AUTH.REFRESH_DENIED_INACTIVE': { severity: 1, outcome: 'DENIED' },
  'AUTH.LOGOUT_ALL': { severity: 0, outcome: 'SUCCESS' },
  'AUTH.PASSWORD_CHANGED': { severity: 1, outcome: 'SUCCESS' },
  'AUTH.PASSWORD_CHANGE_FAILED': { severity: 1, outcome: 'FAILED' },
  'AUTH.SESSIONS_REVOKED_BY_ADMIN': { severity: 1, outcome: 'SUCCESS' },
} as const satisfies Record<string, { severity: SecuritySeverity; outcome: SecurityOutcome }>;

export type SecurityEventType = keyof typeof SECURITY_EVENTS;
