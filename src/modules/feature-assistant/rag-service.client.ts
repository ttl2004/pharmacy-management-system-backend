import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import type { JwtUser } from '../feature-auth/authz/types/authz.types';
import type { AssistantChatRequest, AssistantFeedbackRequest } from './dtos/assistant.request';

const SHORT_TIMEOUT_MS = 10_000;

/**
 * Gọi RAG service (hợp đồng v1: plans/261105-0118-pos-rag-assistant/design.md). BE không đọc nội dung câu trả lời,
 * chỉ chuyển tiếp — đổi baseline sang bản RAG hoàn chỉnh chỉ cần đổi `RAG_SERVICE_URL`.
 */
@Injectable()
export class RagServiceClient {
  private readonly baseUrl: string;
  private readonly internalKey?: string;

  constructor(config: ConfigService) {
    // Bỏ `/` cuối để nối path giữ được tiền tố (vd. http://host/rag).
    this.baseUrl = config.getOrThrow<string>('RAG_SERVICE_URL').replace(/\/+$/, '');
    this.internalKey = config.get<string>('RAG_INTERNAL_KEY') || undefined;
  }

  async getInfo(): Promise<unknown> {
    const response = await this.request('/info', { method: 'GET', signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
    return response.json();
  }

  /** Mở stream SSE. Lỗi kết nối/HTTP ném trước khi trả, để controller còn trả JSON lỗi bình thường. */
  async openChat(body: AssistantChatRequest, user: JwtUser, signal: AbortSignal): Promise<Readable> {
    const response = await this.request('/chat', { method: 'POST', body: JSON.stringify(body), signal }, user);
    if (!response.body) throw this.unavailable('Trợ lý RAG không trả nội dung');
    // body của fetch là ReadableStream (web) — đổi sang Readable của Node để `for await` ghi thẳng vào reply.raw.
    return Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
  }

  async sendFeedback(body: AssistantFeedbackRequest, user: JwtUser): Promise<void> {
    await this.request(
      '/feedback',
      { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) },
      user,
    );
  }

  private async request(path: string, init: RequestInit, user?: JwtUser): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.internalKey) headers['X-Internal-Key'] = this.internalKey;
    // Bản RAG hoàn chỉnh gắn vào trace (Langfuse); baseline bỏ qua.
    if (user) {
      headers['X-User-Id'] = user.userId;
      headers['X-Branch-Id'] = user.branchId ?? '';
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      // Người dùng bấm Dừng / đóng kết nối: để controller tự xử lý, không phải lỗi dịch vụ.
      if (init.signal?.aborted && !(init.signal.reason instanceof DOMException && init.signal.reason.name === 'TimeoutError')) {
        throw error;
      }
      throw this.unavailable(`Không kết nối được trợ lý RAG (${this.baseUrl})`);
    }
    if (!response.ok) {
      throw this.unavailable(
        response.status === 401 ? 'BE và trợ lý RAG lệch RAG_INTERNAL_KEY' : `Trợ lý RAG trả lỗi HTTP ${response.status}`,
      );
    }
    return response;
  }

  private unavailable(message: string): ErrorException {
    return new ErrorException({ code: ErrorCode.ASSISTANT_UNAVAILABLE, message });
  }
}
