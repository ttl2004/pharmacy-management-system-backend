import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

/** Thư mục gốc phục vụ tĩnh ở `/uploads/` (đăng ký trong main.ts). */
export const UPLOAD_ROOT = join(process.cwd(), 'uploads');
export const PRODUCT_IMAGE_PREFIX = '/uploads/products/';

const MAX_BYTES = 2 * 1024 * 1024;
const DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' };

/**
 * Lưu ảnh sản phẩm gửi lên dạng data URL base64 (FE đọc tệp bằng FileReader — không cần multipart) vào đĩa,
 * trả đường dẫn tương đối để ghi vào `products.imageUrls`. Tên tệp ngẫu nhiên, không lấy từ client.
 */
@Injectable()
export class ProductImageService {
  async save(dataUrl: string): Promise<{ url: string }> {
    const match = DATA_URL.exec(dataUrl);
    if (!match) throw this.badRequest('Ảnh phải là tệp PNG, JPEG, WEBP hoặc GIF');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0) throw this.badRequest('Ảnh rỗng');
    if (bytes.length > MAX_BYTES) throw this.badRequest('Ảnh vượt quá 2MB');

    const name = `${randomUUID()}.${EXT[match[1]]}`;
    const dir = join(UPLOAD_ROOT, 'products');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), bytes);
    return { url: `${PRODUCT_IMAGE_PREFIX}${name}` };
  }

  private badRequest(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.HTTP_BAD_REQUEST, message });
  }
}
