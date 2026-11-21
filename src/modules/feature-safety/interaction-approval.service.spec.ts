import { UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { ApprovalContext, InteractionApprovalService } from './interaction-approval.service';

const seller = {
  user: { userId: 'seller1', role: AuthRole.SALES_STAFF, branchId: 'b1', roleLevel: 40 },
} as unknown as RequestActor;

const PASSWORD = 'DuocSi@123';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

describe('InteractionApprovalService', () => {
  const config = { getOrThrow: () => 'x'.repeat(48) };
  const prisma = { auth: { findFirst: jest.fn() } };
  const permissions = { getGrantedCodes: jest.fn() };
  const safety = { check: jest.fn() };
  const service = new InteractionApprovalService(
    config as never,
    prisma as never,
    permissions as never,
    safety as never,
  );
  let hash: string;

  const pharmacist = (overrides: Record<string, unknown> = {}) => ({
    password: hash,
    user: {
      id: 'ph1',
      fullName: 'Dược sĩ B',
      isDeleted: false,
      status: UserStatus.ACTIVE,
      branchId: 'b1',
      role: { code: AuthRole.PHARMACY_MANAGER },
      ...overrides,
    },
  });
  const request = (password = PASSWORD) => ({
    productIds: [P2, P1],
    username: 'duocsi',
    password,
    reason: 'Bác sĩ đã chỉ định phối hợp, đã dặn theo dõi',
  });

  beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.auth.findFirst.mockResolvedValue(pharmacist());
    permissions.getGrantedCodes.mockResolvedValue(new Set(['order:approve-interaction']));
    safety.check.mockResolvedValue({
      hasMajor: true,
      warnings: [
        { id: 'ddi:A:B', severity: 'major', summary: 'Nghiêm trọng: X + Y' },
        { id: 'ddi:A:C', severity: 'moderate', summary: 'Trung bình: X + Z' },
      ],
    });
  });

  it('cấp phiếu chỉ gồm cảnh báo nghiêm trọng; đọc lại được với đúng người bán, chi nhánh, giỏ hàng', async () => {
    const result = await service.approve(request(), seller);

    expect(result).toMatchObject({ warningIds: ['ddi:A:B'], manual: false, approver: { userId: 'ph1' } });
    const stored = service.readToken(result.approvalToken, {
      actorId: 'seller1',
      branchId: 'b1',
      productIds: [P1, P2],
    });
    expect(stored).toMatchObject({
      reason: request().reason,
      warningIds: ['ddi:A:B'],
      warningSummaries: ['Nghiêm trọng: X + Y'],
      byUserId: 'ph1',
      requestedBy: 'seller1',
    });
  });

  it.each([
    ['sai mật khẩu', () => request('sai-mat-khau')],
    ['không có tài khoản', () => (prisma.auth.findFirst.mockResolvedValue(null), request())],
    [
      'tài khoản bị khoá',
      () => (prisma.auth.findFirst.mockResolvedValue(pharmacist({ status: UserStatus.INACTIVE })), request()),
    ],
    ['khác chi nhánh', () => (prisma.auth.findFirst.mockResolvedValue(pharmacist({ branchId: 'b2' })), request())],
    ['không có quyền duyệt', () => (permissions.getGrantedCodes.mockResolvedValue(new Set()), request())],
  ])('%s → 1806', async (_case, makeRequest) => {
    await expect(service.approve(makeRequest(), seller)).rejects.toMatchObject({
      errorCode: ErrorCode.INTERACTION_APPROVER_INVALID,
    });
  });

  it('giỏ không có cảnh báo nghiêm trọng → không cấp phiếu', async () => {
    safety.check.mockResolvedValue({ hasMajor: false, warnings: [] });

    await expect(service.approve(request(), seller)).rejects.toThrow('không cần duyệt');
  });

  it('service tương tác tắt → phiếu "kiểm tra thủ công"', async () => {
    safety.check.mockRejectedValue(
      new ErrorException({ code: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE, message: 'down' }),
    );

    const result = await service.approve(request(), seller);

    expect(result).toMatchObject({ manual: true, warningIds: [] });
  });

  it('phiếu bị sửa, cấp cho người khác hoặc giỏ đã đổi → 1805', async () => {
    const { approvalToken } = await service.approve(request(), seller);
    const context = { actorId: 'seller1', branchId: 'b1', productIds: [P1, P2] };
    const [body, signature] = approvalToken.split('.');
    const tampered = `${Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), warningIds: ['x'] }),
    ).toString('base64url')}.${signature}`;

    const cases: [string, ApprovalContext][] = [
      [tampered, context],
      [approvalToken, { ...context, actorId: 'other' }],
      [approvalToken, { ...context, branchId: 'b2' }],
      [approvalToken, { ...context, productIds: [P1] }],
    ];
    for (const [token, ctx] of cases) {
      expect(() => service.readToken(token, ctx)).toThrow(
        expect.objectContaining({ errorCode: ErrorCode.INTERACTION_APPROVAL_INVALID }) as Error,
      );
    }
  });

  it('phiếu hết hạn → 1805', async () => {
    const { approvalToken } = await service.approve(request(), seller);
    jest.useFakeTimers({ now: Date.now() + 11 * 60 * 1000 });
    try {
      expect(() =>
        service.readToken(approvalToken, { actorId: 'seller1', branchId: 'b1', productIds: [P1, P2] }),
      ).toThrow('hết hạn');
    } finally {
      jest.useRealTimers();
    }
  });
});
