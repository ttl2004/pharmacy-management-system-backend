import { Injectable } from '@nestjs/common';
import { DrugLeafletDraft, DrugLeafletDraftStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

/** Bản nháp còn mở: chưa lưu, chưa bỏ. */
export const OPEN_DRAFT_STATUSES: DrugLeafletDraftStatus[] = ['PROCESSING', 'READY', 'FAILED'];

/**
 * Truy cập bảng `drug_leaflet_drafts`. Không kế thừa `PrismaBaseRepository` vì bảng này không có cột `isDeleted`
 * (bản nháp đóng bằng `status`, không xoá mềm) - base repo luôn chèn `isDeleted: false` vào điều kiện.
 */
@Injectable()
export class DrugLeafletDraftRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.DrugLeafletDraftUncheckedCreateInput): Promise<DrugLeafletDraft> {
    return this.prisma.drugLeafletDraft.create({ data });
  }

  findById(id: string): Promise<DrugLeafletDraft | null> {
    return this.prisma.drugLeafletDraft.findUnique({ where: { id } });
  }

  /** Bản nháp còn mở, mới nhất trước. */
  listOpen(): Promise<DrugLeafletDraft[]> {
    return this.prisma.drugLeafletDraft.findMany({
      where: { status: { in: OPEN_DRAFT_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Cập nhật có điều kiện trạng thái hiện tại: không ghi đè bản nháp vừa bị đóng bởi request khác.
   * Trả bản ghi sau cập nhật, hoặc null nếu không còn khớp điều kiện.
   */
  async updateIfStatus(
    id: string,
    from: DrugLeafletDraftStatus[],
    data: Prisma.DrugLeafletDraftUncheckedUpdateManyInput,
  ): Promise<DrugLeafletDraft | null> {
    const result = await this.prisma.drugLeafletDraft.updateMany({
      where: { id, status: { in: from } },
      data: { ...data, updatedAt: new Date() },
    });
    return result.count > 0 ? this.findById(id) : null;
  }

  /**
   * Khoá dòng bản nháp (`SELECT ... FOR UPDATE`) trong transaction lưu: hai người bấm lưu cùng lúc thì người sau chờ
   * tới khi người trước commit rồi đọc được trạng thái SAVED. Trả null nếu không có bản nháp.
   */
  async lockForSave(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{ id: string; status: DrugLeafletDraftStatus } | null> {
    const rows = await tx.$queryRaw<{ id: string; status: DrugLeafletDraftStatus }[]>`
      SELECT "id", "status"::text AS "status" FROM "drug_leaflet_drafts" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  markSaved(tx: Prisma.TransactionClient, id: string, data: Prisma.DrugLeafletDraftUncheckedUpdateInput) {
    return tx.drugLeafletDraft.update({ where: { id }, data: { ...data, status: 'SAVED', updatedAt: new Date() } });
  }

  /** Bản nháp đã lưu còn việc sau lưu chưa xong (sao ảnh khi có thuốc MANUAL, gửi feedback), chưa hết lượt thử. */
  findFollowUpPending(maxAttempts: number, limit: number): Promise<DrugLeafletDraft[]> {
    return this.prisma.drugLeafletDraft.findMany({
      where: {
        status: 'SAVED',
        followUpAttempts: { lt: maxAttempts },
        OR: [{ drugId: { not: null }, imagesCopiedAt: null }, { feedbackSentAt: null }],
      },
      orderBy: { savedAt: 'asc' },
      take: limit,
    });
  }

  /** Bản nháp SAVED mới nhất gắn thuốc này: chỉ bản đó được đặt ảnh HDSD cho thuốc (ghi đè sau thắng). */
  async latestSavedIdForDrug(drugId: string): Promise<string | null> {
    const row = await this.prisma.drugLeafletDraft.findFirst({
      where: { drugId, status: 'SAVED' },
      orderBy: [{ savedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Thay toàn bộ ảnh tờ HDSD của thuốc (ảnh cũ trên đĩa không xoá). */
  async setDrugLeafletImages(drugId: string, urls: string[]): Promise<void> {
    await this.prisma.drug.update({ where: { id: drugId }, data: { leafletImageUrls: urls } });
  }

  /** Ghi kết quả một lượt việc sau lưu; `failed` thì tăng `followUpAttempts`. */
  async recordFollowUp(
    id: string,
    data: { imagesCopiedAt?: Date; feedbackSentAt?: Date; followUpError: string | null },
    failed: boolean,
  ): Promise<void> {
    await this.prisma.drugLeafletDraft.update({
      where: { id },
      data: { ...data, ...(failed && { followUpAttempts: { increment: 1 } }), updatedAt: new Date() },
    });
  }

  /** Tên người dùng theo id, để hiện "người tạo" ở danh sách (bảng draft chỉ giữ `createdBy` là id thô). */
  async userNames(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((user) => [user.id, user.fullName]));
  }
}
