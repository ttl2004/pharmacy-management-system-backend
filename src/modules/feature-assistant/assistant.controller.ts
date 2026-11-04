import { Body, Controller, Get, HttpCode, Logger, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { AUTH_JWT } from 'src/common/constants/app.constant';
import { CurrentActor, type RequestActor } from 'src/common/decorators/current-actor.decorator';
import { AuthzGuard } from '../feature-auth/authz/guards/auth.guard';
import { AssistantChatRequest, AssistantFeedbackRequest } from './dtos/assistant.request';
import { RagServiceClient } from './rag-service.client';
import { UserThrottlerGuard } from './user-throttler.guard';

const sseEvent = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Trợ lý hỏi đáp thuốc: mọi tài khoản đã đăng nhập đều dùng được (chưa có quyền riêng). */
@Controller('assistant')
@ApiTags('Assistant')
@ApiBearerAuth(AUTH_JWT)
@ApiResponse({ status: 400, description: 'Mã lỗi: ASSISTANT_UNAVAILABLE (1610) — RAG service tắt / lỗi / lệch khoá' })
@UseGuards(AuthzGuard)
export class AssistantController {
  private readonly logger = new Logger(AssistantController.name);

  constructor(private readonly rag: RagServiceClient) {}

  @Get('info')
  @ApiOperation({ description: 'Thông tin pipeline đang chạy: tên, tính năng (history, feedback), thống kê, câu gợi ý.' })
  info() {
    return this.rag.getInfo();
  }

  @Post('chat')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiProduces('text/event-stream')
  @ApiOperation({
    description:
      'Hỏi đáp dạng SSE, chuyển tiếp nguyên luồng từ RAG service. Sự kiện: status, sources, delta, done, error.',
  })
  async chat(
    @Body() dto: AssistantChatRequest,
    @CurrentActor() actor: RequestActor,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const abort = new AbortController();
    // `close` bắn cả khi xong bình thường lẫn khi FE ngắt (bấm Dừng) — abort sau khi xong là vô hại,
    // còn ngắt giữa chừng thì RAG service dừng gọi LLM, không tốn token.
    reply.raw.on('close', () => abort.abort());

    let upstream: Awaited<ReturnType<RagServiceClient['openChat']>>;
    try {
      // Ném ở đây (RAG tắt, lệch khoá) thì filter lỗi chung vẫn trả JSON như mọi route.
      upstream = await this.rag.openChat(dto, actor.user, abort.signal);
    } catch (error) {
      // FE đã ngắt trước khi RAG kịp trả lời: không còn ai nhận, khỏi ghi lỗi lên kết nối đã đóng.
      if (abort.signal.aborted) return;
      throw error;
    }

    // Tự ghi response thô: bỏ qua nén gzip toàn cục và TransformInterceptor, cả hai sẽ giữ stream tới cuối.
    reply.hijack();
    reply.raw.writeHead(200, {
      // Giữ header các hook đã đặt (CORS, helmet, X-RateLimit-*) — hijack không tự gửi chúng.
      ...reply.getHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try {
      for await (const chunk of upstream) reply.raw.write(chunk);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.logger.warn(`Stream trợ lý RAG bị ngắt: ${String(error)}`);
        reply.raw.write(sseEvent('error', { message: 'Mất kết nối tới trợ lý RAG giữa chừng' }));
      }
    } finally {
      reply.raw.end();
    }
  }

  @Post('feedback')
  @HttpCode(204)
  @ApiOperation({ description: 'Đánh giá câu trả lời. Chỉ dùng khi /assistant/info báo features.feedback = true.' })
  async feedback(@Body() dto: AssistantFeedbackRequest, @CurrentActor() actor: RequestActor): Promise<void> {
    await this.rag.sendFeedback(dto, actor.user);
  }
}
