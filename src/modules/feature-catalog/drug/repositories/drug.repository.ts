import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Drug, Prisma, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { ErrorCode } from 'src/common/types/error-code';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';
import type { DrugSourceRecord } from '../drug-source.client';

/** 500 dòng × 18 tham số = 9.000 — xa giới hạn 65.535 tham số của một câu lệnh Postgres. */
export const UPSERT_BATCH_SIZE = 500;

/** Cả lần đồng bộ (tải nguồn + ghi) nằm trong một transaction để giữ khoá — mỗi lượt DB ~100 ms qua pooler. */
const SYNC_TX_TIMEOUT_MS = 120_000;
const SYNC_LOCK_KEY = 'drug-catalog-sync';

@Injectable()
export class DrugRepository extends PrismaBaseRepository<Drug> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Drug');
  }

  /**
   * Chạy `work` trong một transaction giữ khoá đồng bộ (`pg_try_advisory_xact_lock`): đang có lần đồng bộ khác thì báo
   * lỗi ngay chứ không chờ, để hai snapshot không ghi đè nhau. Khoá theo transaction nên tự nhả khi xong hoặc lỗi.
   */
  withSyncLock<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${SYNC_LOCK_KEY}, 0)) AS "locked"`,
        );
        if (!locked) {
          throw new ErrorException({
            code: ErrorCode.DRUG_SYNC_IN_PROGRESS,
            message: 'Đang có một lần đồng bộ danh mục thuốc khác chạy, thử lại sau',
          });
        }
        return work(tx);
      },
      { timeout: SYNC_TX_TIMEOUT_MS },
    );
  }

  countActive(tx: Prisma.TransactionClient): Promise<number> {
    return tx.drug.count({ where: { status: RecordStatus.ACTIVE, isDeleted: false } });
  }

  /** Upsert theo `code`, chia lô. Mọi dòng có trong nguồn được ghi `syncedAt` của lần này và bật ACTIVE trở lại. */
  async upsertAll(
    tx: Prisma.TransactionClient,
    drugs: readonly DrugSourceRecord[],
    syncedAt: Date,
    actorId: string,
  ): Promise<number> {
    let upserted = 0;
    for (let start = 0; start < drugs.length; start += UPSERT_BATCH_SIZE) {
      upserted += await this.upsertBatch(tx, drugs.slice(start, start + UPSERT_BATCH_SIZE), syncedAt, actorId);
    }
    return upserted;
  }

  /** Thuốc ACTIVE không có trong lần đồng bộ này (`syncedAt` cũ hơn) — sẽ bị chuyển INACTIVE. */
  countStale(tx: Prisma.TransactionClient, syncedAt: Date): Promise<number> {
    return tx.drug.count({ where: this.staleWhere(syncedAt) });
  }

  /** Không xoá vì hàng hoá cũ vẫn trỏ tới. */
  async deactivateStale(tx: Prisma.TransactionClient, syncedAt: Date, actorId: string): Promise<number> {
    const { count } = await tx.drug.updateMany({
      where: this.staleWhere(syncedAt),
      data: { status: RecordStatus.INACTIVE, updatedAt: syncedAt, updatedBy: actorId },
    });
    return count;
  }

  /**
   * Cờ kê đơn của hàng hoá luôn theo danh mục: nguồn đổi phân loại thì mọi hàng đang trỏ tới thuốc đó đổi theo.
   * Trả số hàng hoá đã sửa.
   */
  syncProductPrescription(tx: Prisma.TransactionClient, syncedAt: Date, actorId: string): Promise<number> {
    return tx.$executeRaw`
      UPDATE "products" p
      SET "requiresPrescription" = d."isPrescription", "updatedAt" = ${syncedAt}, "updatedBy" = ${actorId}::uuid
      FROM "drugs" d
      WHERE p."drugId" = d."id" AND p."requiresPrescription" <> d."isPrescription"`;
  }

  private staleWhere(syncedAt: Date): Prisma.DrugWhereInput {
    return { status: RecordStatus.ACTIVE, isDeleted: false, syncedAt: { not: syncedAt } };
  }

  /** `id` tự cấp vì Prisma sinh uuid ở client, SQL thô không có. */
  private upsertBatch(
    tx: Prisma.TransactionClient,
    drugs: readonly DrugSourceRecord[],
    syncedAt: Date,
    actorId: string,
  ): Promise<number> {
    const rows = drugs.map(
      (drug) => Prisma.sql`(
        ${randomUUID()}::uuid, ${drug.code}, ${drug.name}, ${drug.drugGroup}, ${drug.controlType},
        ${drug.isPrescription}, ${drug.registrationNumber}, ${drug.registeredAt}::date,
        ${drug.registrationExpiresAt}::date, ${drug.strength}, ${drug.ingredients}, ${drug.manufacturerName},
        ${drug.countryOfOrigin}, ${drug.packagingSpec}, ${drug.route}, ${syncedAt}, ${syncedAt}, ${actorId}::uuid
      )`,
    );

    return tx.$executeRaw`
      INSERT INTO "drugs" (
        "id", "code", "name", "drugGroup", "controlType",
        "isPrescription", "registrationNumber", "registeredAt",
        "registrationExpiresAt", "strength", "ingredients", "manufacturerName",
        "countryOfOrigin", "packagingSpec", "route", "syncedAt", "createdAt", "createdBy"
      )
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("code") DO UPDATE SET
        "name" = EXCLUDED."name",
        "drugGroup" = EXCLUDED."drugGroup",
        "controlType" = EXCLUDED."controlType",
        "isPrescription" = EXCLUDED."isPrescription",
        "registrationNumber" = EXCLUDED."registrationNumber",
        "registeredAt" = EXCLUDED."registeredAt",
        "registrationExpiresAt" = EXCLUDED."registrationExpiresAt",
        "strength" = EXCLUDED."strength",
        "ingredients" = EXCLUDED."ingredients",
        "manufacturerName" = EXCLUDED."manufacturerName",
        "countryOfOrigin" = EXCLUDED."countryOfOrigin",
        "packagingSpec" = EXCLUDED."packagingSpec",
        "route" = EXCLUDED."route",
        "status" = 'ACTIVE',
        "syncedAt" = EXCLUDED."syncedAt",
        "updatedAt" = EXCLUDED."syncedAt",
        "updatedBy" = EXCLUDED."createdBy"
    `;
  }
}
