import { Injectable } from '@nestjs/common';
import { ErrorException } from 'src/common/exceptions/error.exception';
import { rethrowDuplicate } from 'src/common/exceptions/prisma-error';
import { ErrorCode } from 'src/common/types/error-code';
import { PrismaService } from 'src/common/databases/prisma.service';

export type RouteSummary = { id: string; name: string };

/** Đường dùng (uống, tiêm…) — chỉ xem và tạo. Danh mục nhỏ nên đọc thẳng Prisma, không cần repository riêng. */
@Injectable()
export class RouteService {
  constructor(private readonly prisma: PrismaService) {}

  list(): Promise<RouteSummary[]> {
    return this.prisma.administrationRoute.findMany({
      where: { isDeleted: false },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  async create(dto: { name: string }, callerId: string): Promise<RouteSummary> {
    const existing = await this.prisma.administrationRoute.findFirst({
      where: { name: { equals: dto.name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new ErrorException({ code: ErrorCode.DUPLICATE_CODE, message: `Đường dùng "${dto.name}" đã tồn tại` });
    }
    try {
      return await this.prisma.administrationRoute.create({
        data: { name: dto.name, createdBy: callerId },
        select: { id: true, name: true },
      });
    } catch (error) {
      rethrowDuplicate(error);
    }
  }
}
