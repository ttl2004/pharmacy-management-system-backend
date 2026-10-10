import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../app.module';
import { APP_CONSTANTS, SYSTEM_ACTOR_ID } from 'src/common/constants/app.constant';
import { PrismaService } from 'src/common/databases/prisma.service';
import { SEED_USERS } from './data/users.seed';

/**
 * Tài khoản mẫu cho các vai trò nội bộ, kèm dòng `auths` để đăng nhập được — mục đích là để thử
 * phân quyền. Chạy lại nhiều lần vẫn an toàn: khoá upsert là `username`.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const logger = new Logger('SeedUsersScript');

  try {
    const prisma = app.get(PrismaService);

    for (const seed of SEED_USERS) {
      const existingAuth = await prisma.auth.findFirst({
        where: { username: seed.username },
        select: { id: true },
      });
      if (existingAuth) {
        logger.log(`Tài khoản ${seed.username} đã tồn tại, bỏ qua`);
        continue;
      }

      const role = await prisma.role.findFirst({ where: { code: seed.roleCode, isDeleted: false } });
      if (!role) {
        throw new Error(`Chưa có vai trò ${seed.roleCode}. Chạy "npm run seed:permissions" trước.`);
      }

      let branchId: string | null = null;
      if (seed.branchCode) {
        const branch = await prisma.branch.findFirst({
          where: { code: seed.branchCode, isDeleted: false },
          select: { id: true },
        });
        if (!branch) {
          throw new Error(`Chưa có chi nhánh ${seed.branchCode}. Chạy "npm run seed:catalog" trước.`);
        }
        branchId = branch.id;
      }

      // Người dùng và tài khoản đăng nhập phải cùng sống hoặc cùng chết.
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            fullName: seed.fullName,
            phoneNumber: seed.phoneNumber,
            email: seed.email,
            address: seed.address,
            roleId: role.id,
            branchId,
            status: 'ACTIVE',
            createdBy: SYSTEM_ACTOR_ID,
          },
        });

        await tx.auth.create({
          data: {
            username: seed.username,
            password: await bcrypt.hash(seed.password, APP_CONSTANTS.BCRYPT_SALT),
            userId: user.id,
            createdBy: SYSTEM_ACTOR_ID,
          },
        });
      });

      logger.log(`Đã tạo tài khoản ${seed.username} (${seed.roleCode})`);
    }

    logger.log('Users seed completed');
  } catch (error) {
    logger.error('Users seed failed', error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
