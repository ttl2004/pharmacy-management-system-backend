import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

/**
 * Prisma Client dưới dạng provider của Nest.
 *
 * `DATABASE_URL` dạng `file:../data/pos-ndm.sqlite` được Prisma CLI hiểu là tương đối
 * theo thư mục `prisma/`. Ở runtime, đường dẫn được đổi thành tuyệt đối để không phụ
 * thuộc vào cách Prisma Client resolve đường dẫn tương đối.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('database.url');
    const absolutePath = PrismaService.toAbsoluteSqlitePath(url);

    // SQLite không tự tạo thư mục cha; thiếu thư mục sẽ chỉ báo lỗi chung chung
    // "unable to open database file".
    if (absolutePath) mkdirSync(dirname(absolutePath), { recursive: true });

    super({
      datasourceUrl: absolutePath ? `file:${absolutePath}` : url,
      log: config.get<boolean>('database.logging') ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }

  /** Đường dẫn tuyệt đối cho URL `file:` tương đối (theo thư mục prisma/); null nếu không phải file. */
  private static toAbsoluteSqlitePath(url: string): string | null {
    if (!url.startsWith('file:')) return null;
    const path = url.slice('file:'.length);
    if (!path || path.startsWith(':memory:')) return null;
    return resolve(process.cwd(), 'prisma', path);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
