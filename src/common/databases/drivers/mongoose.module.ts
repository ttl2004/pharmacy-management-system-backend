import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

@Module({})
export class MongooseDatabaseModule {
  static forRoot(): DynamicModule {
    return {
      module: MongooseDatabaseModule,
      imports: [
        MongooseModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => {
            return {
              uri: configService.get('mongo.uri'),
            };
          },
        }),
      ],
      exports: [MongooseModule],
    };
  }
}
