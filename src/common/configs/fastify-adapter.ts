import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';

/**
 * Dựng adapter Fastify. `trustProxy` quyết định `request.ip` lấy từ X-Forwarded-For hay từ socket: đặt sai thì IP
 * trong nhật ký sai hoặc giả mạo được. `genReqId` cấp UUID cho mỗi request (không tin header client gửi lên).
 */
export function createFastifyAdapter(env: { TRUST_PROXY: number }): FastifyAdapter {
  return new FastifyAdapter({
    // fastify ≥ 5.12 bỏ hẳn nghĩa "tin N proxy" của trustProxy dạng số (số = không tin ai). Dựng lại bằng hàm: địa chỉ
    // thứ `hop` (0 = máy nối thẳng vào app) được tin khi nằm trong N proxy gần nhất — đúng như hành vi trước khi nâng.
    trustProxy: env.TRUST_PROXY > 0 ? (_address: string, hop: number) => hop < env.TRUST_PROXY : false,
    logger: false,
    // Không tin header `request-id` (mặc định Fastify) do client gửi: id luôn do `genReqId` cấp.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Mặc định 1MB; ảnh sản phẩm gửi base64 (≤2MB nhị phân ≈ 2.8MB) qua POST /product-image.
    bodyLimit: 4 * 1024 * 1024,
  });
}
