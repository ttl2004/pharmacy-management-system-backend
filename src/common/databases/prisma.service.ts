import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma Client dưới dạng provider của Nest.
 *
 * URL đọc từ đúng biến `DATABASE_URL` mà Prisma CLI và Prisma Client dùng, nên CLI
 * (migrate) và runtime không bao giờ lệch nhau.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      datasourceUrl: config.getOrThrow<string>('DATABASE_URL'),
      log: config.get<boolean>('database.logging') ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
