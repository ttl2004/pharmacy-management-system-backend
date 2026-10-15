import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockAdvisoryKeys } from 'src/common/databases/advisory-lock';
import { PrismaService } from 'src/common/databases/prisma.service';

/** Ghi sản phẩm tốn ~20 lượt DB (~2 s qua pooler) cộng thời gian chờ khoá — mặc định 5 s của Prisma không đủ. */
const CATALOG_TX_TIMEOUT_MS = 15_000;
const CATALOG_TX_MAX_WAIT_MS = 5_000;

/**
 * Khoá của một lần ghi sản phẩm: chính sản phẩm đó (sửa/xoá) và từng mã vạch nó định dùng. Mã vạch phải không trùng
 * giữa HAI bảng `products` và `product_units` — unique của DB chỉ chặn trong từng bảng — nên hai lần ghi cùng giành
 * một mã vạch phải chạy nối tiếp để bước kiểm (đọc) thấy kết quả của bên kia.
 */
export function productWriteLocks(
  productId: string | null,
  barcodes: readonly (string | null | undefined)[],
): string[] {
  const claimed = barcodes.filter((barcode): barcode is string => Boolean(barcode));
  return [...(productId ? [`product:${productId}`] : []), ...claimed.map((barcode) => `barcode:${barcode}`)];
}

/**
 * Transaction ghi sản phẩm, khoá hẹp theo `productWriteLocks`: hai lần ghi chỉ chờ nhau khi đụng cùng sản phẩm hoặc
 * cùng mã vạch; đăng nhập, kho hay ghi sản phẩm khác không phải chờ.
 */
@Injectable()
export class CatalogTransactions {
  constructor(private readonly prisma: PrismaService) {}

  write<T>(locks: readonly string[], work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await lockAdvisoryKeys(tx, locks);
        return work(tx);
      },
      { timeout: CATALOG_TX_TIMEOUT_MS, maxWait: CATALOG_TX_MAX_WAIT_MS },
    );
  }
}
