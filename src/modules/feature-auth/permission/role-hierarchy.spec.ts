import { ForbiddenException } from '@nestjs/common';
import { ErrorCode } from 'src/common/types/error-code';
import { assertGrantable, assertOutranks } from './role-hierarchy';

/** Mã nghiệp vụ trong ForbiddenException do `permissionError` dựng; `undefined` nếu không ném. */
function codeOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ForbiddenException) return (error.getResponse() as { code: number }).code;
    throw error;
  }
  return undefined;
}

describe('Mã lỗi rào cấp bậc', () => {
  it('1508 và 1509 nằm trong nhóm phân quyền 15xx', () => {
    expect(ErrorCode.ROLE_LEVEL_FORBIDDEN).toBe(1508);
    expect(ErrorCode.PERMISSION_NOT_GRANTABLE).toBe(1509);
  });
});

describe('assertOutranks', () => {
  it('cho phép thao tác người cấp thấp hơn', () => {
    expect(() => assertOutranks(80, 60)).not.toThrow();
    expect(() => assertOutranks(100, 80)).not.toThrow();
  });

  it('chặn 1508 với người cùng cấp — kể cả SUPER_ADMIN với SUPER_ADMIN', () => {
    expect(codeOf(() => assertOutranks(80, 80))).toBe(ErrorCode.ROLE_LEVEL_FORBIDDEN);
    expect(codeOf(() => assertOutranks(100, 100))).toBe(ErrorCode.ROLE_LEVEL_FORBIDDEN);
  });

  it('chặn 1508 với người cấp cao hơn', () => {
    expect(codeOf(() => assertOutranks(60, 80))).toBe(ErrorCode.ROLE_LEVEL_FORBIDDEN);
  });

  it('cấp bậc thiếu (dữ liệu hỏng) thì chặn chứ không cho qua', () => {
    expect(codeOf(() => assertOutranks(80, undefined as unknown as number))).toBe(ErrorCode.ROLE_LEVEL_FORBIDDEN);
    expect(codeOf(() => assertOutranks(undefined as unknown as number, 40))).toBe(ErrorCode.ROLE_LEVEL_FORBIDDEN);
  });
});

describe('assertGrantable', () => {
  const current = new Set(['product:read', 'user:read']);

  it('SUPER_ADMIN (callerCodes = null) cấp được mọi quyền', () => {
    expect(() => assertGrantable(['branch:delete'], current, null)).not.toThrow();
  });

  it('cấp thêm quyền mình đang có thì được', () => {
    expect(() => assertGrantable(['product:read', 'branch:read'], current, new Set(['branch:read']))).not.toThrow();
  });

  it('cấp thêm quyền mình không có bị chặn 1509', () => {
    expect(codeOf(() => assertGrantable(['branch:delete'], current, new Set(['branch:read'])))).toBe(
      ErrorCode.PERMISSION_NOT_GRANTABLE,
    );
  });

  it('giữ nguyên hoặc thu hồi quyền mình không có vẫn được — thu hẹp không nguy hiểm', () => {
    expect(() => assertGrantable(['user:read'], current, new Set<string>())).not.toThrow();
    expect(() => assertGrantable([], current, new Set<string>())).not.toThrow();
  });
});
