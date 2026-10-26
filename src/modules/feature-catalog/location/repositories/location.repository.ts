import { Injectable } from '@nestjs/common';
import { ShelfLocation } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';

export type LocationSummary = Pick<ShelfLocation, 'id' | 'name'>;

@Injectable()
export class LocationRepository extends PrismaBaseRepository<ShelfLocation> {
  constructor(prisma: PrismaService) {
    super(prisma, 'ShelfLocation');
  }

  /** Toàn bộ vị trí, xếp theo tên — danh mục nhỏ (vài chục kệ/tủ) nên không phân trang. */
  listAll(): Promise<LocationSummary[]> {
    return this.prisma.shelfLocation.findMany({
      where: { isDeleted: false },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  /** Trùng tên không phân biệt hoa thường ("Kệ A" và "kệ a" là một), quét cả bản đã xoá mềm như unique index. */
  findByNameInsensitive(name: string): Promise<{ id: string } | null> {
    return this.prisma.shelfLocation.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
  }
}
