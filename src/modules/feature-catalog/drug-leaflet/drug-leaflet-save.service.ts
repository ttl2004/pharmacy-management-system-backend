import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { CatalogTransactions, productWriteLocks } from '../catalog-transactions';
import { ProductService } from '../product/product.service';
import type { ProductDetail } from '../product/repositories/product.repository';
import { DrugLeafletFollowUpService } from './drug-leaflet-follow-up.service';
import { SaveDrugLeafletDraftRequest } from './dtos/save-drug-leaflet-draft.request';
import { ManualDrugWriter, toLeafletFields } from './manual-drug.writer';
import { toFinalFields } from './ocr-field-mapping';
import { RegistrationDuplicateChecker } from './registration-duplicate.checker';
import { DrugLeafletDraftRepository } from './repositories/drug-leaflet-draft.repository';

/** Lưu bản nháp thành Drug MANUAL (hoặc liên kết DQG) + Product trong một transaction (design §5.6). */
@Injectable()
export class DrugLeafletSaveService {
  private readonly logger = new Logger(DrugLeafletSaveService.name);

  constructor(
    private readonly transactions: CatalogTransactions,
    private readonly drafts: DrugLeafletDraftRepository,
    private readonly duplicates: RegistrationDuplicateChecker,
    private readonly drugWriter: ManualDrugWriter,
    private readonly productService: ProductService,
    private readonly followUp: DrugLeafletFollowUpService,
  ) {}

  async save(id: string, dto: SaveDrugLeafletDraftRequest, actor: RequestActor): Promise<ProductDetail> {
    const { drug: drugInput, rating, resolution, ...productDto } = dto;
    const callerId = actor.user.userId;

    let created: ProductDetail;
    try {
      const locks = productWriteLocks(null, [productDto.barcode, ...productDto.units.map((unit) => unit.barcode)]);
      created = await this.transactions.write(locks, async (tx) => {
        // Khoá dòng bản nháp trước mọi việc ghi: lần lưu thứ hai chờ ở đây rồi thấy SAVED.
        const draft = await this.drafts.lockForSave(tx, id);
        if (!draft) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Bản nháp không tồn tại' });
        if (draft.status === 'SAVED' || draft.status === 'DISCARDED') {
          throw new ErrorException({ code: ErrorCode.DRUG_LEAFLET_DRAFT_CLOSED, message: 'Bản nháp đã được lưu hoặc đã bỏ' });
        }
        if (draft.status !== 'READY') {
          throw new ErrorException({
            code: ErrorCode.DRUG_LEAFLET_DRAFT_NOT_READY,
            message: 'Bản nháp chưa đọc xong hoặc đọc lỗi, chưa lưu được',
          });
        }

        await this.duplicates.lock(tx, drugInput.registrationNumber);
        const found = await this.duplicates.find(tx, drugInput.registrationNumber);
        const decision = this.duplicates.decide(found, resolution);

        // LINK_DQG: không tạo/sửa Drug và không lưu ảnh HDSD (draft.drugId = null).
        let drugId: string;
        let manualDrugId: string | null = null;
        if (decision.type === 'LINK_DQG') {
          drugId = decision.drugId;
        } else if (decision.type === 'OVERWRITE_MANUAL') {
          drugId = manualDrugId = (await this.drugWriter.update(tx, decision.drugId, drugInput, actor)).id;
        } else {
          drugId = manualDrugId = (await this.drugWriter.create(tx, drugInput, actor)).id;
        }

        const product = await this.productService.createInTx(tx, { ...productDto, drugId }, actor);
        if (!product) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Sản phẩm không tồn tại' });

        const feedbackPayload = { rating, final_fields: toFinalFields(toLeafletFields(drugInput)) };
        await this.drafts.markSaved(tx, id, {
          productId: product.id,
          drugId: manualDrugId,
          savedAt: new Date(),
          savedBy: callerId,
          updatedBy: callerId,
          feedbackPayload: feedbackPayload as Prisma.InputJsonValue,
        });
        return product;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }

    // Sau commit, ngoài transaction: sao ảnh + gửi feedback chạy nền, không chờ (tải tới 20 ảnh có thể lâu khi OCR chậm).
    // Lỗi chỉ ghi log; cron 15 phút là lưới an toàn thử lại. Response lưu không phụ thuộc việc này.
    void this.followUp.run(id).catch((error: unknown) => {
      this.logger.warn(`Việc sau lưu bản nháp ${id} lỗi, cron sẽ thử lại: ${String(error)}`);
    });
    return created;
  }
}
