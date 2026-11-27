import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import type { DuplicateResolutionRequest } from './dtos/manual-drug.request';

/** Thông tin ngắn của thuốc trùng số đăng ký, trả kèm lỗi để FE cho chọn. */
export type DrugBrief = {
  id: string;
  code: string;
  name: string;
  strength: string | null;
  manufacturerName: string | null;
};
export type ManualDrugBrief = DrugBrief & { productCount: number };
export type RegistrationDuplicates = { dqg: DrugBrief[]; manual: ManualDrugBrief[] };

/** Kết quả đối chiếu trùng với `resolution`: thuốc gắn vào sản phẩm lấy từ đâu. */
export type DuplicateDecision =
  | { type: 'LINK_DQG'; drugId: string }
  | { type: 'OVERWRITE_MANUAL'; drugId: string }
  | { type: 'NEW' };

type Row = DrugBrief & { source: 'DQG' | 'MANUAL'; productCount: number };

/** Số đăng ký so sánh sau khi bỏ mọi khoảng trắng và viết hoa (design §8). */
export function normalizeRegistration(value: string): string {
  return value.replace(/\s/g, '').toUpperCase();
}

/**
 * Tìm thuốc chưa xoá cùng số đăng ký. Thuốc DQG chỉ tính khi ACTIVE (INACTIVE không liên kết được nên không chặn lưu);
 * thuốc MANUAL kèm số sản phẩm chưa xoá đang gắn.
 */
@Injectable()
export class RegistrationDuplicateChecker {
  /**
   * Khoá theo số đăng ký đã chuẩn hoá: hai lần lưu cùng số chạy nối tiếp, lần sau thấy thuốc lần trước vừa tạo.
   * Gọi sau khoá sản phẩm/mã vạch đầu transaction và trước khoá `drug:<id>` của `assertNoDuplicatePack`.
   */
  lock(tx: Prisma.TransactionClient, registrationNumber: string): Promise<void> {
    return lockAdvisoryKeys(tx, [`drug-registration:${normalizeRegistration(registrationNumber)}`]);
  }

  async find(
    tx: Prisma.TransactionClient,
    registrationNumber: string,
    excludeDrugId?: string,
  ): Promise<RegistrationDuplicates> {
    // `\\s` trong template JS thành `\s` trong SQL (regex khoảng trắng của Postgres).
    const rows = await tx.$queryRaw<Row[]>`
      SELECT d."id", d."code", d."name", d."strength", d."manufacturerName", d."source"::text AS "source",
        (SELECT COUNT(*)::int FROM "products" p WHERE p."drugId" = d."id" AND p."isDeleted" = false) AS "productCount"
      FROM "drugs" d
      WHERE d."isDeleted" = false
        AND (d."source" = 'MANUAL' OR d."status" = 'ACTIVE')
        AND upper(regexp_replace(d."registrationNumber", '\\s', '', 'g'))
          = upper(regexp_replace(${registrationNumber}::text, '\\s', '', 'g'))
        AND (${excludeDrugId ?? null}::uuid IS NULL OR d."id" <> ${excludeDrugId ?? null}::uuid)
      ORDER BY d."code"`;
    const brief = ({ id, code, name, strength, manufacturerName }: Row): DrugBrief => ({
      id,
      code,
      name,
      strength,
      manufacturerName,
    });
    return {
      dqg: rows.filter((row) => row.source === 'DQG').map(brief),
      manual: rows.filter((row) => row.source === 'MANUAL').map((row) => ({ ...brief(row), productCount: row.productCount })),
    };
  }

  /**
   * Đối chiếu trùng với `resolution` (design §5.6 bước 2-3). `resolution` chỉ được nhận khi đúng loại và `drugId` nằm
   * trong danh sách trùng vừa tìm; không thì coi như không gửi. Còn trùng mà chưa xử lý thì ném lỗi 1616/1617 kèm
   * `details` (DQG ưu tiên báo trước).
   */
  decide(found: RegistrationDuplicates, resolution?: DuplicateResolutionRequest): DuplicateDecision {
    if (resolution?.type === 'LINK_DQG' && found.dqg.some((drug) => drug.id === resolution.drugId)) {
      return { type: 'LINK_DQG', drugId: resolution.drugId };
    }
    // Ghi đè thuốc nhập tay chỉ khi không có thuốc DQG ACTIVE cùng số đăng ký: có DQG thì phải liên kết (§5.6 bước 2).
    if (
      resolution?.type === 'OVERWRITE_MANUAL' &&
      found.dqg.length === 0 &&
      found.manual.some((drug) => drug.id === resolution.drugId)
    ) {
      return { type: 'OVERWRITE_MANUAL', drugId: resolution.drugId };
    }
    if (found.dqg.length) {
      throw new ErrorException({
        code: ErrorCode.DRUG_REGISTRATION_DUPLICATE_DQG,
        message: 'Số đăng ký đã có trong danh mục CSDL Dược, hãy liên kết với thuốc có sẵn',
        details: { drugs: found.dqg },
      });
    }
    if (found.manual.length) {
      throw new ErrorException({
        code: ErrorCode.DRUG_REGISTRATION_DUPLICATE_MANUAL,
        message: 'Số đăng ký đã có ở thuốc nhập tay khác',
        details: { drug: found.manual[0] },
      });
    }
    return { type: 'NEW' };
  }
}
