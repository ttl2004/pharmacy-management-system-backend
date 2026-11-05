import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreatePosOrderRequest, ReplaceOrderItemsRequest } from './order.request';

// Cùng cấu hình với `main.ts`.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype });
const items = [{ productUnitId: '8b2a4c55-1d1c-4b7a-9d3e-0f1f5a6b7c8d', quantity: 1 }];

describe('DTO đơn POS không nhận giảm giá tự do', () => {
  it('createPos gửi discountAmount → 400 (trường không được phép)', async () => {
    await expect(pipe.transform({ items, discountAmount: 1000 }, meta(CreatePosOrderRequest))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('replacePosItems gửi discountAmount → 400', async () => {
    await expect(pipe.transform({ items, discountAmount: 0 }, meta(ReplaceOrderItemsRequest))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('không gửi discountAmount → hợp lệ', async () => {
    await expect(pipe.transform({ items }, meta(CreatePosOrderRequest))).resolves.toBeDefined();
  });
});
