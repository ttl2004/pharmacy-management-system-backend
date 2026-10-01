import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import configuration from './common/configs/configuration';
import { validateEnv } from './common/configs/env.validation';
import { FeatureAuthzModule } from './modules/feature-auth/feature-auth.module';
import { DatabaseModule } from './common/databases/database.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [configuration],
      expandVariables: true,
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    DatabaseModule.forRoot({ driver: 'prisma' }),

    LoggerModule.forRoot({
      pinoHttp: {
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.refreshToken',
        ],
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            translateTime: 'SYS:standard',
          },
        },
      },
    }),

    //- Module chính
    FeatureAuthzModule,

    // MailerModule,
  ],
})
export class AppModule {}
