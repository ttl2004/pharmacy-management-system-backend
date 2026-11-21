import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';

const REQUEST_TIMEOUT_MS = 5_000;
/** Thông báo duy nhất ra ngoài: không lộ URL nội bộ; chi tiết chỉ nằm trong log. */
const UNAVAILABLE_MESSAGE = 'Không kiểm tra được tương tác thuốc lúc này, vui lòng thử lại sau';

const severitySchema = z.enum(['major', 'moderate', 'minor', 'unknown']);
const drugRefSchema = z.object({ registrationNumber: z.string(), name: z.string() });

const interactionCheckSchema = z.object({
  interactions: z.array(
    z.object({
      id: z.string(),
      severity: severitySchema,
      drug1: drugRefSchema,
      drug2: drugRefSchema,
      ingredient1: z.string(),
      ingredient2: z.string(),
      description: z.string(),
      management: z.string(),
    }),
  ),
  duplicates: z.array(z.object({ id: z.string(), ingredient: z.string(), drugs: z.array(drugRefSchema) })),
  hasMajor: z.boolean(),
  notFound: z.array(z.string()),
  incomplete: z.array(z.string()),
});

const drugWarningsSchema = z.object({
  drugs: z.array(
    z.object({
      registrationNumber: z.string(),
      isFullyMapped: z.boolean(),
      diseases: z.array(
        z.object({
          ingredient: z.string(),
          severity: severitySchema,
          diseaseName: z.string(),
          description: z.string(),
        }),
      ),
      foods: z.array(
        z.object({
          ingredient: z.string(),
          severity: severitySchema,
          foodName: z.string(),
          description: z.string(),
          management: z.string(),
        }),
      ),
    }),
  ),
  notFound: z.array(z.string()),
});

export type InteractionSeverity = z.infer<typeof severitySchema>;
export type InteractionCheckResult = z.infer<typeof interactionCheckSchema>;
export type DrugWarningsResult = z.infer<typeof drugWarningsSchema>;

/**
 * Gọi service kiểm tra tương tác thuốc (TTT-BE, FastAPI). Thuốc được tra theo **số đăng ký lưu hành**.
 * Mọi lỗi (tắt, quá hạn, lệch khoá, sai định dạng) đều ném `INTERACTION_SERVICE_UNAVAILABLE` (1611).
 */
@Injectable()
export class InteractionServiceClient {
  private readonly logger = new Logger(InteractionServiceClient.name);
  private readonly baseUrl: string;
  private readonly internalKey?: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('INTERACTION_SERVICE_URL').replace(/\/+$/, '');
    this.internalKey = config.get<string>('INTERACTION_INTERNAL_KEY') || undefined;
  }

  async checkInteractions(registrationNumbers: string[]): Promise<InteractionCheckResult> {
    const body = await this.post('/interactions/check', { registrationNumbers });
    return this.parse(interactionCheckSchema, body, '/interactions/check');
  }

  async getDrugWarnings(registrationNumbers: string[]): Promise<DrugWarningsResult> {
    const body = await this.post('/drug-warnings', { registrationNumbers });
    return this.parse(drugWarningsSchema, body, '/drug-warnings');
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.internalKey) headers['X-Internal-Key'] = this.internalKey;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(`Không kết nối được service tương tác ${this.baseUrl}${path}: ${String(error)}`);
      throw this.unavailable();
    }
    if (!response.ok) {
      this.logger.error(
        response.status === 401
          ? `Service tương tác từ chối khoá nội bộ (401): BE và TTT-BE lệch INTERACTION_INTERNAL_KEY`
          : `Service tương tác ${this.baseUrl}${path} trả HTTP ${response.status}`,
      );
      throw this.unavailable();
    }
    return response.json();
  }

  private parse<T>(schema: z.ZodType<T>, body: unknown, path: string): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      this.logger.error(`Service tương tác ${path} trả sai định dạng: ${parsed.error.issues[0]?.message}`);
      throw this.unavailable();
    }
    return parsed.data;
  }

  private unavailable(): ErrorException {
    return new ErrorException({ code: ErrorCode.INTERACTION_SERVICE_UNAVAILABLE, message: UNAVAILABLE_MESSAGE });
  }
}
