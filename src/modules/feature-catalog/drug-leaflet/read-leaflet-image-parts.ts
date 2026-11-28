import type { FastifyRequest } from 'fastify';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { MAX_LEAFLET_IMAGES, type LeafletImageFile } from './drug-leaflet-draft.service';

const FILE_FIELD_NAMES = new Set(['images', 'images[]']);

function rejected(message: string): ErrorException {
  return new ErrorException({ code: ErrorCode.DRUG_LEAFLET_IMAGE_REJECTED, message });
}

/**
 * Đọc các file ảnh `images` từ request multipart vào bộ nhớ (tối đa 20 file x 5 MB theo `limits` đã đăng ký ở main.ts).
 * Mọi lỗi multipart (quá lớn, quá số file, body hỏng) đổi thành DRUG_LEAFLET_IMAGE_REJECTED thay vì 500.
 * Kiểm định dạng ảnh để OCR làm (nó trả lỗi `unsupported_format` -> cùng mã lỗi).
 */
export async function readLeafletImageParts(request: FastifyRequest): Promise<LeafletImageFile[]> {
  if (!request.isMultipart()) throw rejected('Cần gửi ảnh dạng multipart/form-data, trường `images`');

  const files: LeafletImageFile[] = [];
  try {
    for await (const part of request.files()) {
      if (!FILE_FIELD_NAMES.has(part.fieldname)) throw rejected('Chỉ nhận file ở trường `images`');
      if (files.length >= MAX_LEAFLET_IMAGES) throw rejected(`Tối đa ${MAX_LEAFLET_IMAGES} ảnh`);
      // toBuffer ném lỗi khi file vượt `limits.fileSize`; kiểm `truncated` phòng bản không ném.
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw rejected('Mỗi ảnh tối đa 5 MB');
      files.push({ buffer, filename: part.filename || `image-${files.length}`, mimetype: part.mimetype });
    }
  } catch (error) {
    if (error instanceof ErrorException) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw rejected('Mỗi ảnh tối đa 5 MB');
    if (code === 'FST_FILES_LIMIT') throw rejected(`Tối đa ${MAX_LEAFLET_IMAGES} ảnh`);
    throw rejected('Không đọc được dữ liệu ảnh tải lên');
  }
  return files;
}
