import { createHmac, timingSafeEqual } from 'node:crypto';

/** Nội dung phiếu duyệt dược sĩ cấp cho một giỏ hàng cụ thể. */
export interface ApprovalTokenPayload {
  sellerId: string;
  branchId: string;
  /** Hàng hoá của giỏ lúc duyệt, đã sắp xếp — giỏ đổi thì phiếu không còn dùng được. */
  productIds: string[];
  warningIds: string[];
  warningSummaries: string[];
  reason: string;
  manual: boolean;
  approverId: string;
  approverName: string;
  /** Hết hạn (epoch ms). */
  expiresAt: number;
}

/**
 * Phiếu duyệt dạng `<payload base64url>.<chữ ký HMAC-SHA256>`. Không lưu DB: chữ ký bảo đảm client không sửa được
 * nội dung, hạn ngắn hạn chế dùng lại. Khoá ký tách khỏi khoá JWT đăng nhập (dẫn xuất riêng) để hai loại không lẫn nhau.
 */
export class ApprovalTokenSigner {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHmac('sha256', secret).update('interaction-approval-token').digest();
  }

  sign(payload: ApprovalTokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.signature(body)}`;
  }

  /** Trả nội dung nếu chữ ký đúng, ngược lại null. Hạn dùng do bên gọi kiểm. */
  verify(token: string): ApprovalTokenPayload | null {
    const [body, signature, ...rest] = token.split('.');
    if (!body || !signature || rest.length) return null;

    const expected = Buffer.from(this.signature(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ApprovalTokenPayload;
    } catch {
      return null;
    }
  }

  private signature(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
