import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuthzService } from '../modules/feature-auth/authz/authz.service';
import { PermissionService } from '../modules/feature-auth/permission/permission.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const logger = new Logger('SeedPermissionsScript');

  try {
    await app.get(PermissionService).seedCatalog();
    // Ngay sau khi có vai trò: mọi seed sau đó đều ghi `createdBy = SYSTEM_ACTOR_ID`.
    await app.get(AuthzService).seedSystemActor();
    logger.log('Permission seed completed');
  } catch (error) {
    logger.error('Permission seed failed', error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

bootstrap();
