import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTransferRequest, UpdateTransferRequest } from './transfer.request';

const B = '22222222-2222-4222-8222-222222222222';
const BATCH = '33333333-3333-4333-8333-333333333333';

/** Dùng đúng tuỳ chọn mà ValidationPipe toàn cục trong main.ts dùng. */
async function errorsFor(cls: typeof CreateTransferRequest | typeof UpdateTransferRequest, payload: object) {
  return validate(plainToInstance(cls, payload), { whitelist: true, forbidNonWhitelisted: true });
}

describe('CreateTransferRequest / UpdateTransferRequest — note là lý do chuyển (bắt buộc)', () => {
  const base = { toBranchId: B, items: [{ batchId: BATCH, quantity: 1 }] };

  it.each([CreateTransferRequest, UpdateTransferRequest])('%p: thiếu note → lỗi validate', async (cls) => {
    const errors = await errorsFor(cls, base);
    expect(errors.map((e) => e.property)).toContain('note');
  });

  it.each([CreateTransferRequest, UpdateTransferRequest])('%p: note rỗng → lỗi validate', async (cls) => {
    const errors = await errorsFor(cls, { ...base, note: '' });
    expect(errors.map((e) => e.property)).toContain('note');
  });

  it('note quá 1000 ký tự → lỗi validate', async () => {
    const errors = await errorsFor(CreateTransferRequest, { ...base, note: 'x'.repeat(1001) });
    expect(errors.map((e) => e.property)).toContain('note');
  });

  it('có note → hợp lệ', async () => {
    expect(await errorsFor(CreateTransferRequest, { ...base, note: 'Bổ sung hàng' })).toHaveLength(0);
  });
});
