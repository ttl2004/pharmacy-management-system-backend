import { Injectable } from '@nestjs/common';
import { Manufacturer, Prisma, RecordStatus } from '@prisma/client';
import { PrismaService } from 'src/common/databases/prisma.service';
import { PrismaBaseRepository } from 'src/providers/abstract-base/repositories/prisma-base.repository';
import { normalizeManufacturerName } from '../manufacturer-name';

/** Mã tự sinh: `NSX0001`. Vượt 9 999 thì mã tự dài thêm, không vỡ. */
export const MANUFACTURER_CODE_PREFIX = 'NSX';
const MANUFACTURER_CODE_DIGITS = 4;
/** Số lần bỏ qua mã đã bị nhập tay chiếm trước khi bỏ cuộc (thực tế chỉ vài lần). */
const MAX_CODE_ATTEMPTS = 100;
/** Khoá advisory dùng chung cho bước điền `nameKey` còn thiếu — tránh deadlock khi nhiều transaction cùng điền. */
const NAME_KEY_BACKFILL_LOCK = 'manufacturers:name-key-backfill';

export function formatManufacturerCode(value: bigint | number): string {
  return `${MANUFACTURER_CODE_PREFIX}${value.toString().padStart(MANUFACTURER_CODE_DIGITS, '0')}`;
}

@Injectable()
export class ManufacturerRepository extends PrismaBaseRepository<Manufacturer> {
  constructor(prisma: PrismaService) {
    super(prisma, 'Manufacturer');
  }

  /** Danh sách cho storefront: chỉ hãng ACTIVE, chỉ trường công khai. */
  findPublicList(): Promise<{ id: string; name: string; country: string | null }[]> {
    return this.prisma.manufacturer.findMany({
      where: { isDeleted: false, status: RecordStatus.ACTIVE },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, country: true },
    });
  }

  /** Đếm sản phẩm tham chiếu **kể cả** bản ghi đã xoá mềm: xoá mềm không giải phóng quan hệ. */
  countProducts(manufacturerId: string): Promise<number> {
    return this.prisma.product.count({ where: { manufacturerId } });
  }

  /**
   * Khoá theo tên chuẩn hoá đến hết transaction: hai request cùng tên (kể cả biến thể) xếp hàng nhau,
   * request sau thấy bản ghi request trước vừa tạo. Va chạm `hashtext` giữa hai tên khác nhau chỉ làm chờ thêm.
   */
  async lockNameKey(tx: Prisma.TransactionClient, nameKey: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`manufacturers:name:${nameKey}`}))`;
  }

  /**
   * Điền `nameKey` cho các hãng chưa có (dữ liệu trước migration, bản ghi seed…) — tính bằng TypeScript vì
   * quy tắc chuẩn hoá không biểu diễn chắc chắn bằng SQL. Hết dòng NULL thì chỉ tốn một truy vấn kiểm tra.
   */
  async fillMissingNameKeys(tx: Prisma.TransactionClient): Promise<number> {
    const probe = await tx.manufacturer.findFirst({ where: { nameKey: null }, select: { id: true } });
    if (!probe) return 0;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${NAME_KEY_BACKFILL_LOCK}))`;
    const rows = await tx.manufacturer.findMany({
      where: { nameKey: null },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    for (const row of rows) {
      await tx.manufacturer.update({ where: { id: row.id }, data: { nameKey: normalizeManufacturerName(row.name) } });
    }
    return rows.length;
  }

  /** Hãng chưa xoá có cùng khoá tên: ACTIVE trước, rồi bản tạo sớm nhất. */
  findByNameKey(tx: Prisma.TransactionClient, nameKey: string, excludeId?: string): Promise<Manufacturer | null> {
    return tx.manufacturer.findFirst({
      where: { nameKey, isDeleted: false, ...(excludeId ? { id: { not: excludeId } } : {}) },
      // Enum RecordStatus khai báo ACTIVE trước INACTIVE → sắp tăng dần đưa ACTIVE lên đầu.
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Mã tự sinh tiếp theo từ SEQUENCE `manufacturer_code_seq` — không dùng `MAX + 1` (hai request song song ra
   * cùng mã). Bỏ qua số đã bị mã nhập tay chiếm (vd "NSX0005"), kể cả bản ghi đã xoá mềm vì code unique toàn bảng.
   */
  async nextAutoCode(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const [row] = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('"manufacturer_code_seq"') AS value`;
      const code = formatManufacturerCode(row.value);
      const taken = await tx.manufacturer.findFirst({ where: { code }, select: { id: true } });
      if (!taken) return code;
    }
    throw new Error(`Không sinh được mã hãng sản xuất sau ${MAX_CODE_ATTEMPTS} lần thử`);
  }
}
