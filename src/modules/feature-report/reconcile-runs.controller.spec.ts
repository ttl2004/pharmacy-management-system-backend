import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AuthRole } from 'src/common/types/common.enum';
import { ErrorCode } from 'src/common/types/error-code';
import { REQUIRED_PERMISSIONS } from '../feature-auth/permission/decorators/require-permissions.decorator';
import { DEFAULT_ROLE_GRANTS } from '../feature-auth/permission/role.constant';
import { ReconcileRunsController } from './reconcile-runs.controller';
import { ReconcileRunsService } from './reconcile-runs.service';

const actor = { user: { userId: 'u1', role: AuthRole.ADMIN, branchId: null } } as never;

describe('ReconcileRunsController', () => {
  const reconcile = { run: jest.fn() };
  const runs = { list: jest.fn(), detail: jest.fn() };
  const controller = new ReconcileRunsController(reconcile as never, runs as unknown as ReconcileRunsService);
  // 2026-11-05 giờ VN
  const now = new Date('2026-11-05T03:00:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(now.getTime());
    reconcile.run.mockResolvedValue({ id: 'run-1' });
  });
  afterEach(() => jest.useRealTimers());

  it('POST khoảng hợp lệ → chạy đồng bộ với trigger MANUAL', async () => {
    await controller.trigger({ fromDate: '2026-11-01', toDate: '2026-11-05' }, actor);
    expect(reconcile.run).toHaveBeenCalledWith('MANUAL', actor, '2026-11-01', '2026-11-05');
  });

  it.each([
    ['khoảng 32 ngày', '2026-10-01', '2026-11-01'],
    ['toDate tương lai', '2026-11-05', '2026-11-06'],
    ['from sau to', '2026-11-04', '2026-11-03'],
  ])('POST %s → 1002', async (_name, fromDate, toDate) => {
    await expect(controller.trigger({ fromDate, toDate }, actor)).rejects.toMatchObject({
      errorCode: ErrorCode.HTTP_BAD_REQUEST,
    });
    expect(reconcile.run).not.toHaveBeenCalled();
  });

  it('đúng 31 ngày được chấp nhận', async () => {
    await controller.trigger({ fromDate: '2026-10-06', toDate: '2026-11-05' }, actor);
    expect(reconcile.run).toHaveBeenCalled();
  });

  it('3 route cần quyền report:reconcile; chỉ ADMIN được cấp, PM thì không (403)', () => {
    for (const method of ['list', 'detail', 'trigger'] as const) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, ReconcileRunsController.prototype[method])).toEqual([
        'report:reconcile',
      ]);
    }
    expect(DEFAULT_ROLE_GRANTS[AuthRole.ADMIN]).toContain('report:reconcile');
    expect(DEFAULT_ROLE_GRANTS[AuthRole.PHARMACY_MANAGER]).not.toContain('report:reconcile');
    expect(DEFAULT_ROLE_GRANTS[AuthRole.SALES_STAFF]).not.toContain('report:reconcile');
  });

  it('query hasBeenMismatch "true"/"false" được ép kiểu; status lạ bị từ chối', async () => {
    const { ReconcileRunsQuery } = await import('./dtos/reconcile.request');
    const ok = plainToInstance(ReconcileRunsQuery, { hasMismatch: 'true', status: 'SUCCESS' });
    expect(await validate(ok)).toHaveLength(0);
    expect(ok.hasMismatch).toBe(true);
    const bad = plainToInstance(ReconcileRunsQuery, { status: 'XYZ' });
    expect(await validate(bad)).not.toHaveLength(0);
  });
});
