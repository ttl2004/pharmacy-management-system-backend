import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DrugLeafletDraft } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOAD_ROOT } from '../product/product-image.service';
import { OcrInvalidStateError, OcrServiceClient } from './ocr-service.client';
import type { OcrFieldKey } from './ocr-field-mapping';
import { DrugLeafletDraftRepository } from './repositories/drug-leaflet-draft.repository';

/** Tối đa 10 lượt thử cho việc sau lưu (design §8). */
const MAX_FOLLOW_UP_ATTEMPTS = 10;
const CRON_BATCH_SIZE = 50;
/** Số lần tối đa theo chuỗi `superseded_by` khi gửi feedback. */
const MAX_SUPERSEDED_HOPS = 3;
/** `extractionId` đi vào tên tệp: chỉ nhận ký tự an toàn cho đường dẫn. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

type FeedbackPayload = { rating: number; final_fields: Record<OcrFieldKey, string> };

/**
 * Việc sau khi lưu bản nháp (design §5.6), chạy ngoài transaction lưu: sao ảnh HDSD về `uploads/leaflets/<drugId>/`
 * (chỉ khi có thuốc MANUAL) và gửi feedback sang OCR. Lỗi tăng `followUpAttempts`, ghi `followUpError`; cron thử lại.
 */
@Injectable()
export class DrugLeafletFollowUpService {
  private readonly logger = new Logger(DrugLeafletFollowUpService.name);
  /** Cờ trong process: lượt cron đang chạy. */
  private running = false;

  constructor(
    private readonly drafts: DrugLeafletDraftRepository,
    private readonly ocr: OcrServiceClient,
  ) {}

  /** Mỗi 15 phút làm lại việc còn thiếu cho bản nháp SAVED, tối đa 10 lượt mỗi bản. */
  @Cron('0 */15 * * * *')
  async retryPending(): Promise<void> {
    // Lượt trước chưa xong (OCR chậm) thì bỏ lượt này, tránh hai lượt cùng xử lý một bản nháp trong một process.
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.drafts.findFollowUpPending(MAX_FOLLOW_UP_ATTEMPTS, CRON_BATCH_SIZE);
      for (const draft of pending) {
        // Lỗi một bản nháp (vd. ghi DB) không dừng cả lô.
        try {
          await this.processDraft(draft);
        } catch (error) {
          this.logger.error(`Việc sau lưu bản nháp ${draft.id} lỗi`, error as Error);
        }
      }
      if (pending.length) this.logger.log(`Đã chạy lại việc sau lưu cho ${pending.length} bản nháp`);
    } catch (error) {
      this.logger.error('Job việc sau lưu bản nháp lỗi', error as Error);
    } finally {
      this.running = false;
    }
  }

  async run(draftId: string): Promise<void> {
    const draft = await this.drafts.findById(draftId);
    if (draft) await this.processDraft(draft);
  }

  private async processDraft(draft: DrugLeafletDraft): Promise<void> {
    if (draft.status !== 'SAVED') return;
    const errors: string[] = [];
    const done: { imagesCopiedAt?: Date; feedbackSentAt?: Date } = {};

    if (draft.drugId && !draft.imagesCopiedAt) {
      try {
        await this.copyImages(draft, draft.drugId);
        done.imagesCopiedAt = new Date();
      } catch (error) {
        errors.push(`Sao ảnh: ${this.describe(error)}`);
      }
    }
    if (!draft.feedbackSentAt) {
      try {
        await this.sendFeedback(draft);
        done.feedbackSentAt = new Date();
      } catch (error) {
        errors.push(`Feedback: ${this.describe(error)}`);
      }
    }
    if (!errors.length && !done.imagesCopiedAt && !done.feedbackSentAt) return;

    const followUpError = errors.length ? errors.join('; ') : null;
    if (followUpError) this.logger.warn(`Việc sau lưu bản nháp ${draft.id} lỗi: ${followUpError}`);
    await this.drafts.recordFollowUp(draft.id, { ...done, followUpError }, errors.length > 0);
  }

  /**
   * Tải toàn bộ ảnh WebP về đĩa rồi thay `leafletImageUrls` của thuốc. Thuốc đã có bản nháp SAVED mới hơn (ghi đè lần
   * sau) thì bỏ qua để ảnh cũ không đè ảnh mới, vẫn tính là xong.
   */
  private async copyImages(draft: DrugLeafletDraft, drugId: string): Promise<void> {
    if ((await this.drafts.latestSavedIdForDrug(drugId)) !== draft.id) return;
    if (!SAFE_ID.test(draft.extractionId)) throw new Error(`extractionId không hợp lệ: ${draft.extractionId}`);

    const images = await Promise.all(
      Array.from({ length: draft.imageCount }, (_, index) => this.ocr.getImage(draft.extractionId, index)),
    );
    const dir = join(UPLOAD_ROOT, 'leaflets', drugId);
    await mkdir(dir, { recursive: true });
    const urls: string[] = [];
    for (const [index, image] of images.entries()) {
      const name = `${draft.extractionId}-${index}.webp`;
      await writeFile(join(dir, name), image.buffer);
      urls.push(`/uploads/leaflets/${drugId}/${name}`);
    }
    await this.drafts.setDrugLeafletImages(drugId, urls);
  }

  /**
   * Gửi feedback cho extraction hiện hành. OCR trả 409: nếu bản đã bị chạy lại thay thế (`superseded_by`) thì gửi cho
   * bản mới nhất; nếu bản chưa succeeded thì báo lỗi (tính một lượt thử).
   */
  private async sendFeedback(draft: DrugLeafletDraft): Promise<void> {
    const payload = draft.feedbackPayload as unknown as FeedbackPayload | null;
    if (!payload) throw new Error('Bản nháp thiếu feedbackPayload');
    try {
      await this.ocr.sendFeedback(draft.extractionId, payload);
      return;
    } catch (error) {
      if (!(error instanceof OcrInvalidStateError)) throw error;
    }

    let extraction = await this.ocr.getExtraction(draft.extractionId);
    for (let hop = 0; extraction.superseded_by && hop < MAX_SUPERSEDED_HOPS; hop++) {
      extraction = await this.ocr.getExtraction(extraction.superseded_by);
    }
    if (extraction.id === draft.extractionId || extraction.status !== 'succeeded') {
      throw new Error(`Extraction ${extraction.id} chưa thể nhận feedback (trạng thái ${extraction.status})`);
    }
    await this.ocr.sendFeedback(extraction.id, payload);
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
