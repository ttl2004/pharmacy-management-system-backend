import { ForbiddenException } from '@nestjs/common';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import {
  assertBranchInScope,
  branchScopeKindOf,
  type BranchScope,
  isInBranchScope,
  resolveBranchScope,
  scopedBranchFilter,
} from './branch-scope';

const CN1 = '11111111-1111-4111-8111-111111111111';
const CN2 = '22222222-2222-4222-8222-222222222222';
const ALL: BranchScope = { kind: 'ALL' };
const OWN: BranchScope = { kind: 'BRANCH', branchId: CN1 };

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

describe('Mã lỗi phạm vi chi nhánh', () => {
  it('1506 và 1507 nằm trong nhóm phân quyền 15xx', () => {
    expect(ErrorCode.BRANCH_ACCESS_DENIED).toBe(1506);
    expect(ErrorCode.BRANCH_NOT_ASSIGNED).toBe(1507);
  });
});

describe('branchScopeKindOf', () => {
  it('ánh xạ đủ năm vai trò, vai trò lạ là NONE', () => {
    expect(branchScopeKindOf(AuthRole.SUPER_ADMIN)).toBe('ALL');
    expect(branchScopeKindOf(AuthRole.ADMIN)).toBe('ALL');
    expect(branchScopeKindOf(AuthRole.PHARMACY_MANAGER)).toBe('BRANCH');
    expect(branchScopeKindOf(AuthRole.SALES_STAFF)).toBe('BRANCH');
    expect(branchScopeKindOf(AuthRole.CUSTOMER)).toBe('NONE');
    expect(branchScopeKindOf('VAI_TRO_LA')).toBe('NONE');
  });
});

describe('resolveBranchScope', () => {
  it('SUPER_ADMIN và ADMIN có phạm vi ALL, bỏ qua branchId', () => {
    expect(resolveBranchScope({ role: AuthRole.ADMIN, branchId: null })).toEqual({ kind: 'ALL' });
    expect(resolveBranchScope({ role: AuthRole.SUPER_ADMIN, branchId: CN1 })).toEqual({ kind: 'ALL' });
  });

  it('nhân viên bị giới hạn trong chi nhánh của mình', () => {
    expect(resolveBranchScope({ role: AuthRole.PHARMACY_MANAGER, branchId: CN1 })).toEqual({
      kind: 'BRANCH',
      branchId: CN1,
    });
    expect(resolveBranchScope({ role: AuthRole.SALES_STAFF, branchId: CN2 })).toEqual({
      kind: 'BRANCH',
      branchId: CN2,
    });
  });

  it('nhân viên thiếu chi nhánh bị chặn 1507, không được coi là mọi chi nhánh', () => {
    expect(codeOf(() => resolveBranchScope({ role: AuthRole.SALES_STAFF, branchId: null }))).toBe(
      ErrorCode.BRANCH_NOT_ASSIGNED,
    );
    expect(codeOf(() => resolveBranchScope({ role: AuthRole.PHARMACY_MANAGER, branchId: null }))).toBe(
      ErrorCode.BRANCH_NOT_ASSIGNED,
    );
  });

  it('CUSTOMER và vai trò lạ bị chặn 1500', () => {
    expect(codeOf(() => resolveBranchScope({ role: AuthRole.CUSTOMER, branchId: null }))).toBe(
      ErrorCode.PERMISSION_DENIED,
    );
    expect(codeOf(() => resolveBranchScope({ role: 'VAI_TRO_LA', branchId: CN1 }))).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

describe('scopedBranchFilter', () => {
  it('ALL: giữ nguyên lựa chọn của client, không gửi thì không lọc', () => {
    expect(scopedBranchFilter(ALL, CN2)).toBe(CN2);
    expect(scopedBranchFilter(ALL)).toBeUndefined();
  });

  it('BRANCH: không gửi thì tự điền chi nhánh của mình', () => {
    expect(scopedBranchFilter(OWN)).toBe(CN1);
  });

  it('BRANCH: gửi đúng chi nhánh mình vẫn hợp lệ', () => {
    expect(scopedBranchFilter(OWN, CN1)).toBe(CN1);
  });

  it('BRANCH: gửi chi nhánh khác bị chặn 1506', () => {
    expect(codeOf(() => scopedBranchFilter(OWN, CN2))).toBe(ErrorCode.BRANCH_ACCESS_DENIED);
  });
});

describe('isInBranchScope và assertBranchInScope', () => {
  it('ALL chứa mọi bản ghi, kể cả bản ghi không thuộc chi nhánh nào', () => {
    expect(isInBranchScope(ALL, CN2)).toBe(true);
    expect(isInBranchScope(ALL, null)).toBe(true);
  });

  it('BRANCH chỉ chứa đúng chi nhánh mình — null (admin, khách hàng) nằm ngoài', () => {
    expect(isInBranchScope(OWN, CN1)).toBe(true);
    expect(isInBranchScope(OWN, CN2)).toBe(false);
    expect(isInBranchScope(OWN, null)).toBe(false);
  });

  it('assertBranchInScope chặn 1506 khi ghi ra ngoài phạm vi, kể cả gỡ về null', () => {
    expect(() => assertBranchInScope(OWN, CN1)).not.toThrow();
    expect(() => assertBranchInScope(ALL, null)).not.toThrow();
    expect(codeOf(() => assertBranchInScope(OWN, CN2))).toBe(ErrorCode.BRANCH_ACCESS_DENIED);
    expect(codeOf(() => assertBranchInScope(OWN, null))).toBe(ErrorCode.BRANCH_ACCESS_DENIED);
  });
});
