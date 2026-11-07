import { AUDIT_EVENTS, adjustmentEvent } from './audit-events';

describe('AUDIT_EVENTS', () => {
  it('mọi key khớp regex ^[A-Z_]+\\.[A-Z_]+$', () => {
    for (const key of Object.keys(AUDIT_EVENTS)) expect(key).toMatch(/^[A-Z_]+\.[A-Z_]+$/);
  });

  it('ReasonRequiredEvent đúng tập: các event Q5 plan v2 + USER.ROLE_CHANGED + ROLE.PERMISSIONS_CHANGED', () => {
    const required = Object.entries(AUDIT_EVENTS)
      .filter(([, def]) => def.reasonRequired)
      .map(([key]) => key)
      .sort();
    expect(required).toEqual(
      [
        'ORDER.VOID_PAID',
        'PAYMENT.REFUNDED',
        'BATCH.RECALLED',
        'TRANSFER.CREATED',
        'TRANSFER.SHIPPED',
        'TRANSFER.RECEIVED_SHORT',
        'DISPOSAL.CREATED',
        'DISPOSAL.UPDATED',
        'DISPOSAL.CONFIRMED',
        'DISPOSAL.CANCELLED',
        'PURCHASE_RETURN.CREATED',
        'PURCHASE_RETURN.UPDATED',
        'PURCHASE_RETURN.CONFIRMED',
        'PURCHASE_RETURN.CANCELLED',
        'USER.ROLE_CHANGED',
        'ROLE.PERMISSIONS_CHANGED',
      ].sort(),
    );
  });

  it('không có AUDIT.EXPORT, có DRUG.SYNCED', () => {
    expect(AUDIT_EVENTS).not.toHaveProperty(['AUDIT.EXPORT']);
    expect(AUDIT_EVENTS['DRUG.SYNCED']).toMatchObject({ action: 'UPDATE', severity: 1 });
  });

  it('adjustmentEvent ánh xạ loại phiếu sang nhóm event', () => {
    expect(adjustmentEvent('STOCK_TAKE', 'CREATED')).toBe('STOCK_ADJUSTMENT.CREATED');
    expect(adjustmentEvent('OTHER', 'CONFIRMED')).toBe('STOCK_ADJUSTMENT.CONFIRMED');
    expect(adjustmentEvent('DISPOSE', 'CANCELLED')).toBe('DISPOSAL.CANCELLED');
    expect(adjustmentEvent('RETURN_TO_SUPPLIER', 'UPDATED')).toBe('PURCHASE_RETURN.UPDATED');
  });
});
