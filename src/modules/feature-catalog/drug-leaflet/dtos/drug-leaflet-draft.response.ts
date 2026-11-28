import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DosageForm, DrugLeafletDraft, DrugLeafletDraftStatus } from '@prisma/client';
import type { LeafletDrugFields, OcrFieldKey } from '../ocr-field-mapping';

export class DrugLeafletDraftCreatorResponse {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'Rỗng nếu không tìm thấy người dùng' }) name: string;
}

export class DrugLeafletDraftSummary {
  @ApiProperty() id: string;
  @ApiProperty({ enum: DrugLeafletDraftStatus }) status: DrugLeafletDraftStatus;
  @ApiProperty({ type: String, nullable: true }) error: string | null;
  @ApiProperty() imageCount: number;
  @ApiProperty({ description: 'ISO 8601' }) createdAt: string;
  @ApiProperty({ type: DrugLeafletDraftCreatorResponse }) createdBy: DrugLeafletDraftCreatorResponse;
}

/** Bản nháp đã ánh xạ sang form (design §5.5) kèm 16 giá trị gốc của OCR. */
export class DrugLeafletDraftForm {
  @ApiProperty({ type: 'object', additionalProperties: true }) drug: LeafletDrugFields;
  @ApiProperty({ enum: DosageForm, nullable: true }) dosageForm: DosageForm | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) raw: Record<OcrFieldKey, string>;
}

export class DrugLeafletDraftDetail extends DrugLeafletDraftSummary {
  @ApiPropertyOptional({ type: DrugLeafletDraftForm, nullable: true, description: 'Chỉ có khi status = READY' })
  form: DrugLeafletDraftForm | null;
}

/** `createdAt` giữ `Date` (ép kiểu): `TransformInterceptor` đổi sang ISO 8601 khi trả ra. */
export function toDraftSummary(draft: DrugLeafletDraft, names: Map<string, string>): DrugLeafletDraftSummary {
  const creatorId = draft.createdBy ?? '';
  return {
    id: draft.id,
    status: draft.status,
    error: draft.error,
    imageCount: draft.imageCount,
    createdAt: draft.createdAt as unknown as string,
    createdBy: { id: creatorId, name: names.get(creatorId) ?? '' },
  };
}
