import { ProductType, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { InteractionApprovalService } from './interaction-approval.service';
import type { CheckRows } from './interaction-knowledge.repository';
import { SafetyCheckService } from './safety-check.service';
import { SaleSafetyGate } from './sale-safety.gate';

/*
 * Ghép thật SafetyCheckService (+ logic tra tương tác) → InteractionApprovalService → SaleSafetyGate, chỉ giả
 * repository và tầng tài khoản. Kiểm hai lối: dữ liệu bình thường (phải duyệt cảnh báo nghiêm trọng) và bảng dữ liệu
 * rỗng (→ 1611 → dược sĩ xác nhận kiểm tra thủ công), không bao giờ "rỗng = an toàn".
 */

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'DuocSi@123';
const seller = {
  user: { userId: 'seller1', role: AuthRole.SALES_STAFF, branchId: 'b1', roleLevel: 40 },
} as unknown as RequestActor;
const context = { actorId: 'seller1', branchId: 'b1', productIds: [P1, P2] };
const approvalRequest = {
  productIds: [P1, P2],
  username: 'duocsi',
  password: PASSWORD,
  reason: 'Bác sĩ đã chỉ định phối hợp, đã dặn theo dõi',
};

const rows = (dataLoaded: boolean): CheckRows => ({
  products: [
    { id: P1, name: 'Warfarin', type: ProductType.DRUG, registrationNumber: 'REG-W' },
    { id: P2, name: 'Aspirin', type: ProductType.DRUG, registrationNumber: 'REG-A' },
  ],
  mapping: dataLoaded
    ? [
        { registrationNumber: 'REG-W', drugName: 'W', ingredientOrder: 1, ddinterId: 'DD1', ddinterDrug: 'Warfarin' },
        { registrationNumber: 'REG-A', drugName: 'A', ingredientOrder: 1, ddinterId: 'DD2', ddinterDrug: 'Aspirin' },
      ]
    : [],
  interactions: dataLoaded
    ? [{ ddinterIdA: 'DD1', ddinterIdB: 'DD2', level: 'Major', interaction: 'Bleeding', management: 'Avoid' }]
    : [],
  dataLoaded,
});

describe('Luồng an toàn khi bán (ghép thật)', () => {
  const repository = { loadForCheck: jest.fn(), loadForWarnings: jest.fn() };
  const safety = new SafetyCheckService(repository as never);
  const prisma = { auth: { findFirst: jest.fn() } };
  const permissions = { getGrantedCodes: jest.fn() };
  const approvals = new InteractionApprovalService(
    { getOrThrow: () => 'x'.repeat(48) } as never,
    prisma as never,
    permissions as never,
    safety,
  );
  const gate = new SaleSafetyGate(safety, approvals);

  beforeAll(async () => {
    const hash = await bcrypt.hash(PASSWORD, 4);
    prisma.auth.findFirst.mockResolvedValue({
      password: hash,
      user: {
        id: 'ph1',
        fullName: 'Dược sĩ B',
        isDeleted: false,
        status: UserStatus.ACTIVE,
        branchId: 'b1',
        role: { code: AuthRole.PHARMACY_MANAGER },
      },
    });
    permissions.getGrantedCodes.mockResolvedValue(new Set(['order:approve-interaction']));
    jest.spyOn(safety['logger'], 'error').mockImplementation(() => undefined);
  });

  it('dữ liệu bình thường: cảnh báo nghiêm trọng chặn thu tiền cho tới khi dược sĩ duyệt đúng cảnh báo đó', async () => {
    repository.loadForCheck.mockResolvedValue(rows(true));

    const precheck = await gate.precheck([P1, P2]);
    expect(precheck).toMatchObject({ available: true, majorWarningIds: ['ddi:DD1:DD2'] });
    expect(() => gate.assertPayAllowed(precheck, null)).toThrow(
      expect.objectContaining({ errorCode: ErrorCode.INTERACTION_APPROVAL_REQUIRED }) as Error,
    );

    const { approvalToken, manual } = await approvals.approve(approvalRequest, seller);
    expect(manual).toBe(false);
    const stored = gate.approvalForOrder(approvalToken, context);
    expect(() => gate.assertPayAllowed(precheck, stored)).not.toThrow();
  });

  it('bảng dữ liệu rỗng: 1611 → precheck available=false → cần xác nhận thủ công mới thu được tiền', async () => {
    repository.loadForCheck.mockResolvedValue(rows(false));

    await expect(safety.check([P1, P2])).rejects.toMatchObject({
      errorCode: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE,
    });
    const precheck = await gate.precheck([P1, P2]);
    expect(precheck).toEqual({ available: false, productIds: [P1, P2] });
    expect(() => gate.assertPayAllowed(precheck, null)).toThrow(
      expect.objectContaining({ errorCode: ErrorCode.INTERACTION_APPROVAL_REQUIRED }) as Error,
    );

    const { approvalToken, manual, warningIds } = await approvals.approve(approvalRequest, seller);
    expect({ manual, warningIds }).toEqual({ manual: true, warningIds: [] });
    const stored = gate.approvalForOrder(approvalToken, context);
    expect(() => gate.assertPayAllowed(precheck, stored)).not.toThrow();
  });
});
