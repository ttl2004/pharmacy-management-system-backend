import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { LoggerModule } from 'nestjs-pino';
import configuration from './common/configs/configuration';
import { FeatureAuthzModule } from './modules/feature-auth/feature-auth.module';
import { DatabaseModule } from './common/databases/database.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [configuration],
      expandVariables: true,
    }),
    DatabaseModule.forRoot({ driver: 'mongoose' }),

    LoggerModule.forRoot({
      pinoHttp: {
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

    //- Main module
    FeatureAuthzModule,

    // MailerModule,
  ],
})
export class AppModule {}
