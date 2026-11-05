import { Injectable } from '@nestjs/common';
import type { RequestActor } from 'src/common/decorators/current-actor.decorator';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { PrismaService } from 'src/common/databases/prisma.service';
import { auditActorOf } from 'src/providers/audit-log/audit-actor';
import { AuditLogService } from 'src/providers/audit-log/audit-log.service';

export type RouteSummary = { id: string; name: string };

/** Đường dùng (uống, tiêm…) — chỉ xem và tạo. Danh mục nhỏ nên đọc thẳng Prisma, không cần repository riêng. */
@Injectable()
export class RouteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  list(): Promise<RouteSummary[]> {
    return this.prisma.administrationRoute.findMany({
      where: { isDeleted: false },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  async create(dto: { name: string }, actor: RequestActor): Promise<RouteSummary> {
    const existing = await this.prisma.administrationRoute.findFirst({
      where: { name: { equals: dto.name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Đường dùng "${dto.name}" đã tồn tại` });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.administrationRoute.create({
          data: { name: dto.name, createdBy: actor.user.userId },
          select: { id: true, name: true },
        });
        await this.audit.record(tx, auditActorOf(actor), [
          {
            event: 'ROUTE.CREATED',
            entityType: 'administration_routes',
            entityId: created.id,
            entityLabel: created.name,
            branchIds: [],
            after: { name: created.name },
            searchTerms: [created.name],
          },
        ]);
        return created;
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }
}
