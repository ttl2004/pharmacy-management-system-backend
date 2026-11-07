import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';

/** Người thực hiện dùng chung cho spec ghi nhật ký (ADMIN toàn chuỗi). */
export const ADMIN_ACTOR: RequestActor = {
  user: { userId: 'admin-1', sid: 's', email: null, role: AuthRole.ADMIN, branchId: null, roleLevel: 80 },
  ip: '10.0.0.1',
  userAgent: null,
  requestId: 'req-1',
};

/** `PrismaService` giả: `$transaction` chạy callback ngay với `tx` truyền vào. */
export function fakePrisma(tx: object = {}) {
  return { $transaction: jest.fn((work: (tx: object) => unknown) => work(tx)), tx };
}

export type AuditMock = { record: jest.Mock };

/** Các entry của lần `record` duy nhất (kiểm luôn "một lần gọi mỗi transaction"). */
export function entriesOf(audit: AuditMock): Record<string, unknown>[] {
  expect(audit.record).toHaveBeenCalledTimes(1);
  return (audit.record.mock.calls[0] as [unknown, unknown, Record<string, unknown>[]])[2];
}

/** Bọc một `JwtUser` thành `RequestActor` (không có IP/mã request). */
export function actorOf(user: RequestActor['user']): RequestActor {
  return { user, ip: null, userAgent: null, requestId: null };
}
