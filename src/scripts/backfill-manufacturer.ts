import { Prisma, PrismaClient } from '@prisma/client';
import { canonicalCountryOrNull } from 'src/modules/feature-catalog/manufacturer/manufacturer-countries';
import { normalizeManufacturerName } from 'src/modules/feature-catalog/manufacturer/manufacturer-name';
import { formatManufacturerCode } from 'src/modules/feature-catalog/manufacturer/repositories/manufacturer.repository';

/*
 * backfill:manufacturer — tính lại `nameKey`, đưa quốc gia về tên chuẩn, sinh mã NSX… cho hãng chưa có mã.
 * Dùng: npm run backfill:manufacturer
 * Idempotent: chạy lại chỉ ghi dòng còn lệch. Chạy sau khi đổi quy tắc chuẩn hoá tên/bí danh quốc gia.
 * Không xoá/gộp hãng trùng. Không ghi nhật ký kiểm toán (bảo trì dữ liệu, không phải thao tác người dùng).
 */

export interface BackfillManufacturerResult {
  nameKeys: number;
  countries: number;
  codes: number;
}

export async function backfillManufacturers(prisma: PrismaClient): Promise<BackfillManufacturerResult> {
  return prisma.$transaction(
    async (tx) => {
      // Cùng khoá với `ManufacturerRepository.fillMissingNameKeys` — không chạy chồng với service đang điền.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'manufacturers:name-key-backfill'}))`;
      const result: BackfillManufacturerResult = { nameKeys: 0, countries: 0, codes: 0 };
      const rows = await tx.manufacturer.findMany({
        select: { id: true, name: true, nameKey: true, country: true, code: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      for (const row of rows) {
        const data: { nameKey?: string; country?: string | null; code?: string } = {};
        const nameKey = normalizeManufacturerName(row.name);
        if (nameKey !== row.nameKey) {
          data.nameKey = nameKey;
          result.nameKeys++;
        }
        const country = canonicalCountryOrNull(row.country);
        if (country !== row.country) {
          data.country = country;
          result.countries++;
        }
        if (row.code === null) {
          data.code = await nextFreeCode(tx);
          result.codes++;
        }
        if (Object.keys(data).length > 0) await tx.manufacturer.update({ where: { id: row.id }, data });
      }
      return result;
    },
    { timeout: 120_000 },
  );
}

async function nextFreeCode(tx: Prisma.TransactionClient): Promise<string> {
  for (;;) {
    const [row] = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('"manufacturer_code_seq"') AS value`;
    const code = formatManufacturerCode(row.value);
    if (!(await tx.manufacturer.findFirst({ where: { code }, select: { id: true } }))) return code;
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await backfillManufacturers(prisma);
    console.log(
      `Đã cập nhật hãng sản xuất: ${result.nameKeys} khoá tên, ${result.countries} quốc gia, ${result.codes} mã mới`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
