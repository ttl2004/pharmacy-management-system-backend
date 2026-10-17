import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
import { PrismaService } from 'src/common/databases/prisma.service';

export abstract class SessionStore {
  abstract isActive(sid: string): Promise<boolean>;
  abstract activate(sid: string, userId: string, ttl: number): Promise<void>;
  abstract revoke(sid: string): Promise<void>;
  abstract revokeAllByUser(userId: string): Promise<void>;
}

/**
 * Transaction ghi lên phiên đăng nhập của MỘT người dùng: đăng nhập, đổi mật khẩu, đăng xuất mọi nơi.
 *
 * Khoá advisory theo `userId`: thao tác trên cùng một người dùng chạy nối tiếp — hai lần đăng nhập song song không
 * để lọt hai phiên cùng sống (luật một máy), "đăng xuất mọi nơi" không bỏ sót phiên vừa tạo — còn người dùng khác
 * nhau chạy song song. Khoá nằm trong Postgres nên vẫn đúng khi chạy nhiều instance (riêng cache phiên của
 * `DbSessionStore` thì chỉ của một instance).
 *
 * Không gọi lồng `forUser` cho cùng người dùng: transaction trong mở trên kết nối khác và chờ khoá của transaction
 * ngoài tới hết timeout.
 *
 * `revision` tăng sau mỗi lần phiên có thể đã bị thu hồi, để `DbSessionStore` bỏ cache của instance này.
 */
@Injectable()
export class SessionTransactions {
  revision = 0;
  constructor(private readonly prisma: PrismaService) {}

  async forUser<T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockAdvisoryKeys(tx, [`session:${userId}`]);
        return work(tx);
      });
    } finally {
      // Tăng cả khi lỗi: không biết chắc transaction đã commit tới đâu.
      this.changed();
    }
  }

  changed(): void {
    this.revision++;
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
  /**
   * Đọc thuần, không khoá gì: mọi request có token đều gọi hàm này. Đúng đắn nhờ `revision`: thu hồi phiên xong là
   * `revision` tăng, nên kết quả đọc trùng lúc với một lần thu hồi phiên không được đưa vào cache, còn cache cũ bị
   * xoá ở lần gọi kế tiếp.
   */
  async isActive(sid: string): Promise<boolean> {
    if (this.revision !== this.transactions.revision) {
      this.cache.clear();
      this.revision = this.transactions.revision;
    }
    const seen = this.revision;
    const now = Date.now();
    if ((this.cache.get(sid) ?? 0) > now) return true;
    this.cache.delete(sid);
    const token = await this.prisma.refreshToken.findFirst({
      where: { sid, revokedAt: null, expiresAt: { gt: new Date(now) } },
    });
    if (!token) return false;
    // Có lần thu hồi nào commit trong lúc đang đọc thì không cache — có thể đó chính là lần thu hồi phiên này.
    if (this.transactions.revision !== seen) return true;
    if (this.cache.size >= 10000) this.cache.clear();
    this.cache.set(sid, Math.min(now + 20000, token.expiresAt.getTime()));
    return true;
  }
  activate(sid: string): Promise<void> {
    // Bản ghi refresh đã commit là nguồn xác nhận phiên; không cache trạng thái chưa commit.
    this.cache.delete(sid);
    return Promise.resolve();
  }
  /** Thu hồi một phiên — một câu lệnh, không cần khoá: phiên đã thu hồi không bao giờ sống lại. */
  async revoke(sid: string) {
    try {
      await this.prisma.refreshToken.updateMany({ where: { sid, revokedAt: null }, data: { revokedAt: new Date() } });
    } finally {
      this.cache.delete(sid);
      this.transactions.changed();
    }
  }
  async revokeAllByUser(userId: string) {
    await this.transactions.forUser(userId, (tx) =>
      tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    );
  }
}
