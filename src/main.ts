import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AUTH_JWT } from './common/constants/app.constant';
import { ResolveExceptionFilter } from './common/exceptions/resolve.exception';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { UPLOAD_ROOT } from './modules/feature-catalog/product/product-image.service';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: false,
      logger: false,
      // Mặc định 1MB; ảnh sản phẩm gửi base64 (≤2MB nhị phân ≈ 2.8MB) qua POST /product-image.
      bodyLimit: 4 * 1024 * 1024,
    }),
    { bufferLogs: true }, // không để bị log kép
  );

  await app.register(helmet);

  await app.register(compress, {
    global: true,
    encodings: ['gzip', 'deflate', 'br'],
  });

  const configService = app.get(ConfigService);

  // Chỉ origin được khai báo mới được gọi kèm cookie: `/auth/refresh` trả access token trong body, phản chiếu mọi
  // origin thì trang lạ nào trình duyệt chịu gửi cookie tới (cùng site, hoặc mọi nơi khi SameSite=none) đọc được token.
  const corsOrigins = configService.get<string[]>('CORS_ORIGINS') ?? [];
  await app.register(cors, {
    origin: corsOrigins.length ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  await app.register(cookie);

  // Ảnh sản phẩm đã tải lên (ProductImageService) — phục vụ tĩnh, không cần đăng nhập như ảnh công khai storefront.
  await mkdir(join(UPLOAD_ROOT, 'products'), { recursive: true });
  await app.register(fastifyStatic, { root: UPLOAD_ROOT, prefix: '/uploads/', decorateReply: false });

  const pinoLogger = app.get(Logger);
  app.useLogger(pinoLogger);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new ResolveExceptionFilter());

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('POS NDM')
    .setDescription('Hệ thống POS')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'Nhập access token JWT',
        in: 'header',
      },
      AUTH_JWT,
    )
    .setVersion('1.0')
    .addTag('POS')
    .build();

  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, documentFactory, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = configService.get<number>('port') || 3790;

  await app.listen(port, '0.0.0.0');

  pinoLogger.log(`App Running at: http://localhost:${port}`, 'Bootstrap');
  pinoLogger.log(`Swagger at: http://localhost:${port}/docs`, 'Swagger');
}

void bootstrap();
