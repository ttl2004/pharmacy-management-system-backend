import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from 'src/common/databases/prisma.service';
import { SEED_BRANCHES } from './data/catalog.seed';

/**
 * Seed dữ liệu nền. Hiện chỉ có chi nhánh — đơn vị tính, nhóm thuốc, hãng sản xuất và sản phẩm
 * sẽ thêm vào đây khi module danh mục được dựng (xem spec mục 4.9).
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const logger = new Logger('SeedCatalogScript');

  try {
    const prisma = app.get(PrismaService);

    for (const branch of SEED_BRANCHES) {
      // findFirst theo code chứ không dùng upsert: cột `code` là UNIQUE nhưng bản ghi đã xoá mềm
      // vẫn giữ giá trị đó, nên upsert sẽ đâm vào ràng buộc thay vì bỏ qua.
      const existing = await prisma.branch.findFirst({ where: { code: branch.code } });
      if (existing) {
        await prisma.branch.update({
          where: { id: existing.id },
          data: { ...branch, isDeleted: false, updatedAt: new Date() },
        });
        logger.log(`Cập nhật chi nhánh ${branch.code}`);
      } else {
        await prisma.branch.create({ data: { ...branch } });
        logger.log(`Tạo chi nhánh ${branch.code}`);
      }
    }

    logger.log('Catalog seed completed');
  } catch (error) {
    logger.error('Catalog seed failed', error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
