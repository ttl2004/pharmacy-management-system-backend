import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AUTH_JWT } from './common/constants/app.constant';
import { ResolveExceptionFilter } from './common/exceptions/resolve.exception';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: false,
      logger: false,
    }),
    { bufferLogs: true }, // không để bị log kép
  );

  await app.register(helmet);

  await app.register(compress, {
    global: true,
    encodings: ['gzip', 'deflate', 'br'],
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  const configService = app.get(ConfigService);
  await app.register(cookie);

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

  const port = configService.get<number>('port') || 3000;

  await app.listen(port, '0.0.0.0');

  pinoLogger.log(`App Running at: http://localhost:${port}`, 'Bootstrap');
  pinoLogger.log(`Swagger at: http://localhost:${port}/docs`, 'Swagger');
}

void bootstrap();
