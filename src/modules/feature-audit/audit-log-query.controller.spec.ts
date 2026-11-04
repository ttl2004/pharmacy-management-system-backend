import { ArgumentMetadata, BadRequestException, ParseUUIDPipe, ValidationPipe } from '@nestjs/common';
import { AuditEntityParams } from './dtos/audit-entity.params';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta: ArgumentMetadata = { type: 'param', metatype: AuditEntityParams };
const ID = '11111111-1111-4111-8111-111111111111';

describe('GET /audit-log/entity/:type/:id — tham số', () => {
  it('entity/:type sai regex → 400', async () => {
    for (const type of ['Price-Books', 'a'.repeat(51), 'price books', '']) {
      await expect(pipe.transform({ type, id: ID }, meta)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('id không phải UUID → 400; hợp lệ thì qua', async () => {
    await expect(pipe.transform({ type: 'price_books', id: 'abc' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ type: 'price_books', id: ID }, meta)).resolves.toMatchObject({ type: 'price_books' });
  });

  it('GET /:id dùng ParseUUIDPipe', async () => {
    await expect(new ParseUUIDPipe().transform('xyz', { type: 'param' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
