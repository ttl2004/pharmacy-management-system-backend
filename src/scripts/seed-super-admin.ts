import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuthzService } from '../modules/feature-auth/authz/authz.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const logger = new Logger('SeedSuperAdminScript');

  try {
    const authzService = app.get(AuthzService);
    await authzService.seedSuperAdmin();
    logger.log('Super admin seed completed');
  } catch (error) {
    logger.error('Super admin seed failed', error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

bootstrap();
