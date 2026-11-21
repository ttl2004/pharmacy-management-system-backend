import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { PayPrecheck, SaleSafetyGate } from './sale-safety.gate';

const available = (majorWarningIds: string[] = []): PayPrecheck => ({
  available: true,
  productIds: ['p1', 'p2'],
  majorWarningIds,
  majorSummaries: majorWarningIds.map((id) => `Nghiêm trọng ${id}`),
});
const unavailable: PayPrecheck = { available: false, productIds: ['p1', 'p2'] };
const approval = (warningIds: string[], manual = false) => ({ reason: 'r', warningIds, warningSummaries: [], manual });

describe('SaleSafetyGate', () => {
  const safety = { check: jest.fn() };
  const gate = new SaleSafetyGate(safety as never, {} as never);
  const approvalRequired = expect.objectContaining({ errorCode: ErrorCode.INTERACTION_APPROVAL_REQUIRED }) as Error;

  it('không có cảnh báo nghiêm trọng → cho thu, không cần duyệt', () => {
    expect(() => gate.assertPayAllowed(available(), null)).not.toThrow();
  });

  it('có cảnh báo nghiêm trọng chưa duyệt → 1804, thông báo nêu cảnh báo còn thiếu', () => {
    expect(() => gate.assertPayAllowed(available(['w1', 'w2']), approval(['w1']))).toThrow(approvalRequired);
    expect(() => gate.assertPayAllowed(available(['w1', 'w2']), approval(['w1']))).toThrow('Nghiêm trọng w2');
  });

  it('mọi cảnh báo nghiêm trọng đã duyệt → cho thu', () => {
    expect(() => gate.assertPayAllowed(available(['w1']), approval(['w1']))).not.toThrow();
  });

  it('service tắt: chỉ cho thu khi đơn đã có dược sĩ duyệt (thủ công hoặc trước đó)', () => {
    expect(() => gate.assertPayAllowed(unavailable, null)).toThrow(approvalRequired);
    expect(() => gate.assertPayAllowed(unavailable, approval([], true))).not.toThrow();
    expect(() => gate.assertPayAllowed(unavailable, approval(['w1']))).not.toThrow();
  });

  it('precheck: service tắt → available=false thay vì ném lỗi', async () => {
    safety.check.mockRejectedValue(
      new ErrorException({ code: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE, message: 'down' }),
    );
    await expect(gate.precheck(['p1', 'p2'])).resolves.toEqual(unavailable);
  });
});
