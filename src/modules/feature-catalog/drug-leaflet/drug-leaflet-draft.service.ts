import { Injectable, Logger } from '@nestjs/common';
import { DrugLeafletDraft, DrugLeafletDraftStatus } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import {
  DrugLeafletDraftDetail,
  DrugLeafletDraftSummary,
  toDraftSummary,
} from './dtos/drug-leaflet-draft.response';
import { OcrExtraction, OcrInvalidStateError, OcrServiceClient } from './ocr-service.client';
import { toLeafletDraftForm } from './ocr-field-mapping';
import { DrugLeafletDraftRepository, OPEN_DRAFT_STATUSES } from './repositories/drug-leaflet-draft.repository';

export const MAX_LEAFLET_IMAGES = 20;
/** Timeout hỏi OCR khi làm mới trạng thái ở danh sách: ngắn để OCR chậm/tắt không treo request. */
const LIST_REFRESH_TIMEOUT_MS = 3_000;
const DETAIL_REFRESH_TIMEOUT_MS = 5_000;
/** Số lần tối đa theo chuỗi `superseded_by` (OCR chạy lại nhiều lần). */
const MAX_SUPERSEDED_HOPS = 3;

export type LeafletImageFile = { buffer: Buffer; filename: string; mimetype: string };

@Injectable()
export class DrugLeafletDraftService {
  private readonly logger = new Logger(DrugLeafletDraftService.name);

  constructor(
    private readonly repository: DrugLeafletDraftRepository,
    private readonly ocr: OcrServiceClient,
  ) {}

  /** Gửi ảnh sang OCR rồi tạo bản nháp PROCESSING. Số ảnh được kiểm trước khi gọi OCR. */
  async create(files: LeafletImageFile[], actor: RequestActor): Promise<DrugLeafletDraftSummary> {
    if (files.length < 1 || files.length > MAX_LEAFLET_IMAGES) {
      throw new ErrorException({
        code: ErrorCode.DRUG_LEAFLET_IMAGE_REJECTED,
        message: `Cần tải từ 1 đến ${MAX_LEAFLET_IMAGES} ảnh`,
      });
    }
    const { id: extractionId } = await this.ocr.createExtraction(files);
    const draft = await this.repository.create({
      extractionId,
      status: 'PROCESSING',
      imageCount: files.length,
      createdBy: actor.user.userId,
    });
    return toDraftSummary(draft, await this.repository.userNames([actor.user.userId]));
  }

  /** Danh sách bản nháp còn mở; bản PROCESSING được hỏi lại OCR song song, lỗi OCR giữ trạng thái cũ. */
  async list(): Promise<DrugLeafletDraftSummary[]> {
    const drafts = await this.repository.listOpen();
    const refreshed = await Promise.all(
      drafts.map((draft) =>
        draft.status === 'PROCESSING' ? this.refreshQuietly(draft, LIST_REFRESH_TIMEOUT_MS) : draft,
      ),
    );
    // Sau làm mới có thể đã sang SAVED/DISCARDED (race hiếm): chỉ trả bản còn mở.
    const open = refreshed.filter((draft) => OPEN_DRAFT_STATUSES.includes(draft.status));
    const ids = [...new Set(open.map((draft) => draft.createdBy).filter((id): id is string => !!id))];
    const names = await this.repository.userNames(ids);
    return open.map((draft) => toDraftSummary(draft, names));
  }

  async detail(id: string): Promise<DrugLeafletDraftDetail> {
    let draft = this.assertOpen(await this.findOrThrow(id));
    let extraction: OcrExtraction | null = null;
    if (draft.status === 'PROCESSING') {
      ({ draft, extraction } = await this.syncWithOcr(draft, DETAIL_REFRESH_TIMEOUT_MS, false));
    } else if (draft.status === 'READY') {
      extraction = await this.ocr.getExtraction(draft.extractionId, DETAIL_REFRESH_TIMEOUT_MS);
    }
    const names = await this.repository.userNames(draft.createdBy ? [draft.createdBy] : []);
    const form =
      draft.status === 'READY' && extraction?.result ? toLeafletDraftForm(extraction.result) : null;
    return { ...toDraftSummary(draft, names), form };
  }

  /** Ảnh WebP của bản nháp (qua OCR). Chỉ bản nháp còn mở. */
  async image(id: string, index: number) {
    const draft = this.assertOpen(await this.findOrThrow(id));
    return this.ocr.getImage(draft.extractionId, index);
  }

  /** Chạy lại toàn bộ OCR cho bản nháp FAILED. */
  async retry(id: string, actor: RequestActor): Promise<DrugLeafletDraftSummary> {
    const draft = this.assertOpen(await this.findOrThrow(id));
    if (draft.status !== 'FAILED') {
      throw new ErrorException({
        code: ErrorCode.DRUG_LEAFLET_DRAFT_NOT_READY,
        message: 'Chỉ thử lại được bản nháp bị lỗi',
      });
    }
    let extractionId: string;
    try {
      ({ id: extractionId } = await this.ocr.rerun(draft.extractionId));
    } catch (error) {
      if (error instanceof OcrInvalidStateError) {
        throw new ErrorException({
          code: ErrorCode.DRUG_LEAFLET_DRAFT_NOT_READY,
          message: 'Bản nháp đã được chạy lại hoặc chưa thể chạy lại, hãy tải lại danh sách',
        });
      }
      throw error;
    }
    const updated = await this.repository.updateIfStatus(id, ['FAILED'], {
      extractionId,
      status: 'PROCESSING',
      error: null,
      updatedBy: actor.user.userId,
    });
    return this.summaryOf(this.assertOpen(updated ?? (await this.findOrThrow(id))));
  }

  /** Bỏ bản nháp (không xoá bên OCR). */
  async discard(id: string, actor: RequestActor): Promise<DrugLeafletDraftSummary> {
    this.assertOpen(await this.findOrThrow(id));
    const updated = await this.repository.updateIfStatus(id, OPEN_DRAFT_STATUSES, {
      status: 'DISCARDED',
      discardedAt: new Date(),
      discardedBy: actor.user.userId,
      updatedBy: actor.user.userId,
    });
    // Không khớp điều kiện = request khác vừa lưu/bỏ trước.
    if (!updated) throw this.closedError();
    return this.summaryOf(updated);
  }

  /**
   * Đồng bộ trạng thái bản nháp với OCR: queued|running -> PROCESSING, succeeded -> READY, failed -> FAILED + error.
   * Theo `superseded_by` nếu OCR đã chạy lại. Lỗi OCR được ném ra (nơi gọi quyết định nuốt hay không).
   */
  async refreshStatus(draft: DrugLeafletDraft, timeoutMs: number): Promise<DrugLeafletDraft> {
    return (await this.syncWithOcr(draft, timeoutMs, true)).draft;
  }

  private async refreshQuietly(draft: DrugLeafletDraft, timeoutMs: number): Promise<DrugLeafletDraft> {
    try {
      return await this.refreshStatus(draft, timeoutMs);
    } catch (error) {
      this.logger.warn(`Không làm mới được bản nháp ${draft.id}, giữ trạng thái cũ: ${String(error)}`);
      return draft;
    }
  }

  /**
   * `strict = false` thì lỗi OCR được nuốt (trả bản nháp cũ, extraction null); mặc định ném lỗi.
   */
  private async syncWithOcr(
    draft: DrugLeafletDraft,
    timeoutMs: number,
    strict: boolean,
  ): Promise<{ draft: DrugLeafletDraft; extraction: OcrExtraction | null }> {
    let extractionId = draft.extractionId;
    let extraction: OcrExtraction;
    try {
      extraction = await this.ocr.getExtraction(extractionId, timeoutMs);
      for (let hop = 0; extraction.superseded_by && hop < MAX_SUPERSEDED_HOPS; hop++) {
        extractionId = extraction.superseded_by;
        extraction = await this.ocr.getExtraction(extractionId, timeoutMs);
      }
    } catch (error) {
      if (strict) throw error;
      return { draft, extraction: null };
    }

    const status = this.statusOf(extraction);
    const error = status === 'FAILED' ? (extraction.error ?? 'Đọc ảnh thất bại') : null;
    if (status === draft.status && extractionId === draft.extractionId && error === draft.error) {
      return { draft, extraction };
    }
    // Chỉ ghi khi bản nháp vẫn PROCESSING: không ghi đè bản vừa được lưu/bỏ ở request khác.
    const updated = await this.repository.updateIfStatus(draft.id, ['PROCESSING'], { extractionId, status, error });
    return { draft: updated ?? (await this.findOrThrow(draft.id)), extraction };
  }

  private statusOf(extraction: OcrExtraction): DrugLeafletDraftStatus {
    if (extraction.status === 'succeeded') return 'READY';
    if (extraction.status === 'failed') return 'FAILED';
    return 'PROCESSING';
  }

  private async summaryOf(draft: DrugLeafletDraft): Promise<DrugLeafletDraftSummary> {
    return toDraftSummary(draft, await this.repository.userNames(draft.createdBy ? [draft.createdBy] : []));
  }

  private async findOrThrow(id: string): Promise<DrugLeafletDraft> {
    const draft = await this.repository.findById(id);
    if (!draft) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Bản nháp không tồn tại' });
    return draft;
  }

  private assertOpen(draft: DrugLeafletDraft): DrugLeafletDraft {
    if (draft.status === 'SAVED' || draft.status === 'DISCARDED') throw this.closedError();
    return draft;
  }

  private closedError(): ErrorException {
    return new ErrorException({
      code: ErrorCode.DRUG_LEAFLET_DRAFT_CLOSED,
      message: 'Bản nháp đã được lưu hoặc đã bỏ',
    });
  }
}
