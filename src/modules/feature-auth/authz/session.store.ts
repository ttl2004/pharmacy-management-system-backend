import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';

export abstract class SessionStore {
  abstract isActive(sid: string): Promise<boolean>;
  abstract activate(sid: string, userId: string, ttl: number): Promise<void>;
  abstract revoke(sid: string): Promise<void>;
  abstract revokeAllByUser(userId: string): Promise<void>;
}

// Thực hiện tuần tự các transaction để tránh transaction lồng nhau, xen kẽ giữa các
// yêu cầu HTTP đồng thời. (Trước đây còn vì SQLite chỉ cho một writer; nay dùng PostgreSQL
// nhưng hành vi tuần tự vẫn được giữ và vẫn đang được dựa vào.)
@Injectable()
export class SessionTransactions {
  private tail: Promise<unknown> = Promise.resolve();
  revision = 0;
  constructor(private readonly prisma: PrismaService) {}
  read<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  write<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.read(async () => {
      try {
        return await this.prisma.$transaction(work);
      } finally {
        this.revision++;
      }
    });
  }
}

@Injectable()
export class DbSessionStore extends SessionStore {
  // Chỉ dùng cho một instance. Nhiều instance cần Redis và cơ chế vô hiệu hóa cache dùng chung.
  private readonly cache = new Map<string, number>();
  private revision = -1;
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: SessionTransactions,
  ) {
    super();
  }
  isActive(sid: string): Promise<boolean> {
    return this.transactions.read(async () => {
      if (this.revision !== this.transactions.revision) {
        this.cache.clear();
        this.revision = this.transactions.revision;
      }
      const now = Date.now();
      if ((this.cache.get(sid) ?? 0) > now) return true;
      this.cache.delete(sid);
      const token = await this.prisma.refreshToken.findFirst({
        where: { sid, revokedAt: null, expiresAt: { gt: new Date(now) } },
      });
      if (!token) return false;
      if (this.cache.size >= 10000) this.cache.clear();
      this.cache.set(sid, Math.min(now + 20000, token.expiresAt.getTime()));
      return true;
    });
  }
  activate(sid: string): Promise<void> {
    // Bản ghi refresh đã commit là nguồn xác nhận phiên; không cache trạng thái chưa commit.
    this.cache.delete(sid);
    return Promise.resolve();
  }
  async revoke(sid: string) {
    await this.transactions.write(async (tx) => {
      await tx.refreshToken.updateMany({ where: { sid, revokedAt: null }, data: { revokedAt: new Date() } });
      this.cache.delete(sid);
    });
  }
  async revokeAllByUser(userId: string) {
    await this.transactions.write(async (tx) => {
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      this.cache.clear();
    });
  }
}
