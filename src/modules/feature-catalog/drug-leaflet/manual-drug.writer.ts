import { Injectable } from '@nestjs/common';
import { Drug, DrugSource, Prisma, RecordStatus } from '@prisma/client';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { diffFields, pickAuditFields } from 'src/providers/audit-log/audit-diff';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';
import type { AuditEntry } from 'src/providers/audit-log/audit-log.types';
import type { ManualDrugInput } from './dtos/manual-drug.request';
import type { LeafletDrugFields } from './ocr-field-mapping';

/** Cột của `Drug` mà khối `drug` ghi được; cũng là bộ trường ghi nhật ký. */
const WRITABLE_FIELDS = [
  'registrationNumber', 'name', 'ingredients', 'strength', 'dosageFormText', 'packagingSpec', 'indications',
  'contraindications', 'dosage', 'sideEffects', 'warnings', 'storage', 'manufacturerName', 'interactions',
  'pregnancyLactation', 'overdose', 'shelfLife', 'isPrescription', 'controlType', 'drugGroup', 'countryOfOrigin',
  'route',
] as const satisfies readonly (keyof ManualDrugInput & keyof Drug)[];

const CREATED_AUDIT_FIELDS = ['code', ...WRITABLE_FIELDS] as const;

type WritableData =Partial<Pick<Drug, (typeof WRITABLE_FIELDS)[number]>>;
type FlagRow = { id: string; code: string; requiresPrescription: boolean; isControlled: boolean };

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Khối `drug` -> dữ liệu ghi: chuỗi rỗng thành null; trường không gửi (`undefined`) thì bỏ qua (giữ giá trị cũ khi sửa). */
function toDrugData(input: ManualDrugInput): WritableData {
  const data: Record<string, unknown> = {};
  for (const field of WRITABLE_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    data[field] = typeof value === 'string' || value === null ? blankToNull(value) : value;
  }
  return data as WritableData;
}

/** 17 trường tờ HDSD đã chuẩn hoá, dùng dựng `final_fields` gửi feedback OCR. */
export function toLeafletFields(input: ManualDrugInput): LeafletDrugFields {
  const pick = (value: string | null | undefined) => blankToNull(value);
  return {
    registrationNumber: pick(input.registrationNumber),
    name: pick(input.name),
    ingredients: pick(input.ingredients),
    strength: pick(input.strength),
    dosageFormText: pick(input.dosageFormText),
    packagingSpec: pick(input.packagingSpec),
    indications: pick(input.indications),
    contraindications: pick(input.contraindications),
    dosage: pick(input.dosage),
    sideEffects: pick(input.sideEffects),
    warnings: pick(input.warnings),
    storage: pick(input.storage),
    manufacturerName: pick(input.manufacturerName),
    interactions: pick(input.interactions),
    pregnancyLactation: pick(input.pregnancyLactation),
    overdose: pick(input.overdose),
    shelfLife: pick(input.shelfLife),
  };
}

/**
 * Ghi thuốc MANUAL trong transaction của nơi gọi. Thuốc DQG không bao giờ đi qua đây (chỉ đồng bộ được ghi).
 * Cờ kê đơn/kiểm soát của thuốc MANUAL quyết định cờ của mọi sản phẩm gắn với nó (design §5.2b).
 */
@Injectable()
export class ManualDrugWriter {
  constructor(private readonly audit: AuditLogService) {}

  /** Tạo thuốc MANUAL mới, mã `MANUAL-000001` từ sequence `drug_manual_code_seq`, ACTIVE, `syncedAt` null. */
  async create(tx: Prisma.TransactionClient, input: ManualDrugInput, actor: RequestActor): Promise<Drug> {
    const [{ code }] = await tx.$queryRaw<{ code: string }[]>`
      SELECT 'MANUAL-' || lpad(nextval('drug_manual_code_seq')::text, 6, '0') AS "code"`;
    const drug = await tx.drug.create({
      data: {
        ...toDrugData(input),
        name: input.name.trim(),
        code,
        source: DrugSource.MANUAL,
        status: RecordStatus.ACTIVE,
        syncedAt: null,
        createdBy: actor.user.userId,
      },
    });
    await this.audit.record(tx, auditActorOf(actor), [
      {
        event: 'DRUG.CREATED',
        entityType: 'drugs',
        entityId: drug.id,
        entityLabel: drug.code,
        branchIds: [],
        after: pickAuditFields(drug, CREATED_AUDIT_FIELDS),
      },
    ]);
    return drug;
  }

  /**
   * Ghi khối `drug` vào thuốc MANUAL có sẵn (ghi đè khi lưu bản nháp, hoặc sửa qua sửa sản phẩm), rồi đồng bộ
   * `requiresPrescription`/`isControlled` của mọi sản phẩm chưa xoá gắn thuốc này theo luật `prescriptionOf`/`controlledOf`:
   * kê đơn theo đúng `isPrescription`; có `controlType` thì bật kiểm soát (không bao giờ tự tắt).
   */
  async update(tx: Prisma.TransactionClient, drugId: string, input: ManualDrugInput, actor: RequestActor): Promise<Drug> {
    const callerId = actor.user.userId;
    // Giữ khoá `drug:<id>` TRƯỚC mọi lần ghi (kể cả khoá dòng các sản phẩm gắn thuốc khi đồng bộ cờ): cùng thứ tự với
    // `assertNoDuplicatePack` của sửa/tạo sản phẩm, nên không tạo vòng chờ. Lấy lại sau đó trong cùng transaction vẫn được.
    await lockAdvisoryKeys(tx, [`drug:${drugId}`]);
    const existing = await tx.drug.findFirst({ where: { id: drugId, isDeleted: false } });
    if (!existing) throw new ErrorException({ code: ErrorCode.RECORD_NOT_FOUND, message: 'Thuốc không tồn tại' });
    if (existing.source !== DrugSource.MANUAL) {
      throw new ErrorException({
        code: ErrorCode.DRUG_NOT_MANUAL,
        message: 'Thuốc thuộc danh mục CSDL Dược, chỉ cập nhật bằng đồng bộ',
      });
    }

    const data = toDrugData(input);
    const drug = await tx.drug.update({
      where: { id: drugId },
      data: { ...data, updatedAt: new Date(), updatedBy: callerId },
    });

    const controlled = (drug.controlType ?? '').trim() !== '';
    const stale = await tx.product.findMany({
      where: {
        drugId,
        isDeleted: false,
        OR: [
          { requiresPrescription: { not: drug.isPrescription } },
          ...(controlled ? [{ isControlled: false }] : []),
        ],
      },
      select: { id: true, code: true, requiresPrescription: true, isControlled: true },
    });
    if (stale.length) {
      await tx.product.updateMany({
        where: { id: { in: stale.map((row) => row.id) } },
        data: {
          requiresPrescription: drug.isPrescription,
          ...(controlled && { isControlled: true }),
          updatedAt: new Date(),
          updatedBy: callerId,
        },
      });
    }

    const entries: AuditEntry[] = stale.map((row) => this.flagEntry(row, drug.isPrescription, controlled, drug.code));
    const diff = diffFields(existing, data, WRITABLE_FIELDS);
    if (diff) {
      entries.unshift({
        event: 'DRUG.UPDATED',
        entityType: 'drugs',
        entityId: drug.id,
        entityLabel: drug.code,
        branchIds: [],
        ...diff,
      });
    }
    await this.audit.record(tx, auditActorOf(actor), entries);
    return drug;
  }

  /** Cùng dạng nhật ký đổi cờ của đồng bộ DQG (`drug.service.ts`). */
  private flagEntry(row: FlagRow, isPrescription: boolean, controlled: boolean, drugCode: string): AuditEntry {
    const before: Record<string, boolean> = {};
    const after: Record<string, boolean> = {};
    if (row.requiresPrescription !== isPrescription) {
      before.requiresPrescription = row.requiresPrescription;
      after.requiresPrescription = isPrescription;
    }
    if (controlled && !row.isControlled) {
      before.isControlled = false;
      after.isControlled = true;
    }
    return {
      event: 'PRODUCT.CONTROL_FLAGS_CHANGED',
      entityType: 'products',
      entityId: row.id,
      entityLabel: row.code,
      branchIds: [],
      before,
      after,
      metadata: { drugCode },
    };
  }
}
