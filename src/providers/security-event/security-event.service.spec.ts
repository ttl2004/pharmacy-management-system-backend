import { SecurityEventService } from './security-event.service';
import { SECURITY_EVENTS } from './security-events';

const CTX = { ip: '1.2.3.4', userAgent: 'UA', requestId: '0190f3a2-1b2c-7d3e-8f40-123456789abc' };

function make() {
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const txCreateMany = jest.fn().mockResolvedValue({ count: 1 });
  const service = new SecurityEventService({ securityEvent: { createMany } } as never);
  return { service, createMany, tx: { securityEvent: { createMany: txCreateMany } }, txCreateMany };
}

describe('SecurityEventService.record', () => {
  it('một createMany; severity/outcome suy từ danh mục', async () => {
    const { service, createMany } = make();
    await service.record([
      { type: 'AUTH.LOGIN_FAILED', actorId: 'u1', actorRoleCode: 'SALES_STAFF', context: CTX },
      { type: 'AUTH.LOGOUT_ALL', actorId: 'u1', context: CTX },
    ]);
    expect(createMany).toHaveBeenCalledTimes(1);
    const [{ data }] = createMany.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(data[0]).toMatchObject({ outcome: 'FAILED', severity: 1, ipAddress: '1.2.3.4', requestId: CTX.requestId });
    expect(data[1]).toMatchObject({ outcome: 'SUCCESS', severity: 0 });
  });

  it('có client thì ghi bằng client, không đụng prisma', async () => {
    const { service, createMany, tx, txCreateMany } = make();
    await service.record([{ type: 'AUTH.LOGIN_OK', actorId: 'u1', context: CTX }], tx as never);
    expect(txCreateMany).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('requestId không phải UUID → null; userAgent cắt 255', async () => {
    const { service, createMany } = make();
    await service.record([
      { type: 'AUTH.LOGIN_OK', context: { ip: null, userAgent: 'x'.repeat(400), requestId: 'abc' } },
    ]);
    const [{ data }] = createMany.mock.calls[0] as [{ data: { requestId: unknown; userAgent: string }[] }];
    expect(data[0].requestId).toBeNull();
    expect(data[0].userAgent).toHaveLength(255);
  });

  it('danh mục khớp bảng B.4', () => {
    expect(Object.keys(SECURITY_EVENTS)).toHaveLength(9);
    expect(SECURITY_EVENTS['AUTH.BRUTE_FORCE_SUSPECTED']).toEqual({ severity: 2, outcome: 'DENIED' });
    expect(SECURITY_EVENTS['AUTH.LOGIN_FAILED_BURST']).toEqual({ severity: 2, outcome: 'DENIED' });
  });
});
