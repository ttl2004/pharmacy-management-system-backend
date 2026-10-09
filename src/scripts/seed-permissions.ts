import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PermissionService } from '../modules/feature-auth/permission/permission.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const logger = new Logger('SeedPermissionsScript');

  try {
    await app.get(PermissionService).seedCatalog();
    logger.log('Permission seed completed');
  } catch (error) {
    logger.error('Permission seed failed', error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

bootstrap();
