import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import type { OcrFieldKey, OcrResult } from './ocr-field-mapping';

const CREATE_TIMEOUT_MS = 60_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const IMAGE_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 10_000;
/** Thông báo duy nhất ra ngoài khi OCR lỗi: không lộ URL nội bộ; chi tiết chỉ nằm trong log. */
const UNAVAILABLE_MESSAGE = 'Dịch vụ đọc ảnh đang bận, vui lòng thử lại sau';
/** Mã lỗi ảnh của OCR (api/errors.py) chuyển thành DRUG_LEAFLET_IMAGE_REJECTED kèm thông điệp gốc. */
const IMAGE_REJECTED_CODES = new Set(['too_many_images', 'image_too_large', 'unsupported_format', 'invalid_request']);

export type OcrExtraction = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  superseded_by: string | null;
  images: { index: number }[];
  result: OcrResult | null;
};

/**
 * OCR trả 409 `invalid_state` (extraction đã bị chạy lại thay thế hoặc chưa succeeded).
 * Không phải lỗi dịch vụ: nơi gọi bắt `instanceof OcrInvalidStateError` để biết bản này không gửi feedback được nữa.
 */
export class OcrInvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrInvalidStateError';
  }
}

type RequestOptions = { method?: string; body?: BodyInit; headers?: Record<string, string>; timeoutMs: number };

/** Gọi OCR service (pharmacy-ocr, /api/v1, header X-API-Key). Hợp đồng: design.md §4. */
@Injectable()
export class OcrServiceClient {
  private readonly logger = new Logger(OcrServiceClient.name);
  private readonly baseUrl?: string;
  private readonly apiKey?: string;

  constructor(config: ConfigService) {
    const url = config.get<string>('OCR_SERVICE_URL')?.replace(/\/+$/, '');
    this.baseUrl = url || undefined;
    this.apiKey = config.get<string>('OCR_SERVICE_API_KEY') || undefined;
  }

  async createExtraction(files: { buffer: Buffer; filename: string; mimetype: string }[]): Promise<{ id: string }> {
    const form = new FormData();
    for (const file of files) {
      form.append('images[]', new Blob([file.buffer as unknown as BlobPart], { type: file.mimetype }), file.filename);
    }
    const response = await this.request('/extractions', { method: 'POST', body: form, timeoutMs: CREATE_TIMEOUT_MS });
    return this.readJson<{ id: string }>(response);
  }

  async getExtraction(id: string, timeoutMs = DEFAULT_READ_TIMEOUT_MS): Promise<OcrExtraction> {
    const response = await this.request(`/extractions/${encodeURIComponent(id)}`, { timeoutMs });
    return this.readJson<OcrExtraction>(response);
  }

  async getImage(id: string, index: number): Promise<{ buffer: Buffer; contentType: string }> {
    const response = await this.request(`/extractions/${encodeURIComponent(id)}/images/${index}`, {
      timeoutMs: IMAGE_TIMEOUT_MS,
    });
    try {
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'image/webp',
      };
    } catch (error) {
      this.logger.error(`Đọc ảnh OCR ${id}/${index} lỗi: ${String(error)}`);
      throw this.unavailable();
    }
  }

  /** Chạy lại toàn bộ (mode full); trả id extraction mới, bản cũ bị OCR đánh dấu superseded. */
  async rerun(id: string): Promise<{ id: string }> {
    const response = await this.request(`/extractions/${encodeURIComponent(id)}/rerun`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'full' }),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    return this.readJson<{ id: string }>(response);
  }

  /** Ném `OcrInvalidStateError` khi OCR trả 409 (bản đã bị thay thế hoặc chưa succeeded). */
  async sendFeedback(id: string, payload: { rating: number; final_fields: Record<OcrFieldKey, string> }): Promise<void> {
    await this.request(`/extractions/${encodeURIComponent(id)}/feedback`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: WRITE_TIMEOUT_MS,
    });
  }

  private async request(path: string, options: RequestOptions): Promise<Response> {
    if (!this.baseUrl || !this.apiKey) {
      this.logger.error('Chưa cấu hình OCR_SERVICE_URL / OCR_SERVICE_API_KEY');
      throw this.unavailable();
    }
    const url = `${this.baseUrl}/api/v1${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        body: options.body,
        // Không tự đặt Content-Type cho FormData: fetch tự gắn boundary.
        headers: { 'X-API-Key': this.apiKey, ...options.headers },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      this.logger.error(`Không kết nối được OCR ${url}: ${String(error)}`);
      throw this.unavailable();
    }
    if (response.ok) return response;

    const { code, message } = await this.readError(response);
    if (response.status === 409 || code === 'invalid_state') throw new OcrInvalidStateError(message);
    if (code && IMAGE_REJECTED_CODES.has(code)) {
      throw new ErrorException({ code: ErrorCode.DRUG_LEAFLET_IMAGE_REJECTED, message });
    }
    this.logger.error(
      response.status === 401
        ? `OCR ${url} từ chối khoá (401): BE và OCR lệch OCR_SERVICE_API_KEY`
        : `OCR ${url} trả HTTP ${response.status} (${code ?? 'không rõ mã'}): ${message}`,
    );
    throw this.unavailable();
  }

  /** Lỗi OCR có dạng {"error": {"code", "message"}}; body không đúng dạng thì code = null. */
  private async readError(response: Response): Promise<{ code: string | null; message: string }> {
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      return { code: body.error?.code ?? null, message: body.error?.message ?? `HTTP ${response.status}` };
    } catch {
      return { code: null, message: `HTTP ${response.status}` };
    }
  }

  private async readJson<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      this.logger.error(`OCR trả nội dung không phải JSON: ${String(error)}`);
      throw this.unavailable();
    }
  }

  private unavailable(): ErrorException {
    return new ErrorException({ code: ErrorCode.OCR_SERVICE_UNAVAILABLE, message: UNAVAILABLE_MESSAGE });
  }
}
