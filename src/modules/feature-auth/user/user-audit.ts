import type { Prisma, User } from '@prisma/client';
import { maskEmail, maskPhone } from 'src/common/utils/mask.util';
import type { AuditJson } from 'src/providers/audit-log/audit-log.types';

/**
 * Danh sách trắng trường của người dùng được ghi vào nhật ký (D16). Không bao giờ có password/hash; `username` chỉ làm
 * `entityLabel`; địa chỉ, ngày sinh, giới tính không ghi.
 */
export const USER_AUDIT_FIELDS = ['fullName', 'status', 'branchId', 'roleCode', 'email', 'phoneNumber'] as const;

export type UserAuditSnapshot = Record<(typeof USER_AUDIT_FIELDS)[number], unknown>;

type UserLike = Pick<User, 'fullName' | 'status' | 'branchId' | 'email' | 'phoneNumber'> & { role: { code: string } };

/** Dạng phẳng, theo danh sách trắng, của một người dùng (chưa che PII — dùng để so sánh, rồi che bằng `maskUserSnapshot`). */
export function userSnapshot(user: UserLike): UserAuditSnapshot {
  return {
    fullName: user.fullName,
    status: user.status,
    branchId: user.branchId,
    roleCode: user.role.code,
    email: user.email,
    phoneNumber: user.phoneNumber,
  };
}

/** Che email (giữ ký tự đầu + tên miền) và SĐT (4 số cuối) trong một snapshot/diff đã chuẩn hoá JSON. */
export function maskUserSnapshot(snapshot: Record<string, AuditJson>): Record<string, AuditJson> {
  const masked = { ...snapshot };
  if ('email' in masked) masked.email = maskEmail(masked.email as string | null);
  if ('phoneNumber' in masked) masked.phoneNumber = maskPhone(masked.phoneNumber as string | null);
  return masked;
}

/**
 * Phần chung của entry `USER.*`: phạm vi là chi nhánh của người đó (ADMIN/khách không có chi nhánh → `[]`, chỉ ADMIN
 * thấy), nhãn là username (không có tài khoản thì họ tên). Từ khoá tìm kiếm: họ tên và username (D8).
 */
export function userAuditBase(
  user: { id: string; fullName: string },
  username: string | null,
  branchIds: readonly (string | null)[],
) {
  return {
    entityType: 'users',
    entityId: user.id,
    entityLabel: username ?? user.fullName,
    branchIds: [...new Set(branchIds.filter((id): id is string => !!id))],
    searchTerms: [user.fullName, ...(username ? [username] : [])],
  };
}

/** Username của người dùng, đọc trong transaction đang chạy; không có tài khoản đăng nhập thì `null`. */
export async function usernameOf(tx: Prisma.TransactionClient, userId: string): Promise<string | null> {
  const auth = await tx.auth.findFirst({ where: { userId }, select: { username: true } });
  return auth?.username ?? null;
}
