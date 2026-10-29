import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Drug, Prisma, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';
import type { DrugSourceRecord } from '../drug-source.client';

@Injectable()
export class DrugRepository extends PrismaBaseRepository<Drug> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Drug');
  }

  /**
   * Ghi danh mục nguồn vào `drugs` trong một transaction: upsert theo `code`, rồi chuyển INACTIVE những thuốc không còn
   * trong nguồn (không xoá vì hàng hoá cũ vẫn trỏ tới).
   */
  async replaceFromSource(
    drugs: DrugSourceRecord[],
    syncedAt: Date,
    actorId: string,
  ): Promise<{ upserted: number; deactivated: number }> {
    const [upserted, { count: deactivated }] = await this.prisma.$transaction([
      this.upsertMany(drugs, syncedAt, actorId),
      this.prisma.drug.updateMany({
        where: { code: { notIn: drugs.map((drug) => drug.code) }, status: RecordStatus.ACTIVE, isDeleted: false },
        data: { status: RecordStatus.INACTIVE, updatedAt: syncedAt, updatedBy: actorId },
      }),
    ]);
    return { upserted, deactivated };
  }

  /** Thuốc ACTIVE, chưa xoá — điều kiện để hàng hoá được trỏ tới. */
  findActive(client: Prisma.TransactionClient, id: string): Promise<{ id: string } | null> {
    return client.drug.findFirst({
      where: { id, isDeleted: false, status: RecordStatus.ACTIVE },
      select: { id: true },
    });
  }

  /**
   * **Một** câu `INSERT … ON CONFLICT`: mỗi lượt DB ~100 ms nên upsert từng dòng sẽ chạm timeout transaction 5 s.
   * Thuốc có lại trong nguồn được bật ACTIVE trở lại. `id` tự cấp vì Prisma sinh uuid ở client.
   */
  private upsertMany(drugs: DrugSourceRecord[], syncedAt: Date, actorId: string) {
    const rows = drugs.map(
      (drug) => Prisma.sql`(
        ${randomUUID()}::uuid, ${drug.code}, ${drug.name}, ${drug.drugGroup}, ${drug.controlType},
        ${drug.isPrescription}, ${drug.registrationNumber}, ${drug.registeredAt}::date,
        ${drug.registrationExpiresAt}::date, ${drug.strength}, ${drug.ingredients}, ${drug.manufacturerName},
        ${drug.countryOfOrigin}, ${drug.packagingSpec}, ${drug.route}, ${syncedAt}, ${syncedAt}, ${actorId}::uuid
      )`,
    );

    return this.prisma.$executeRaw`
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
