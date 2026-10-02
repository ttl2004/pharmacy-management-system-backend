import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma.service';

@Module({})
export class PrismaDatabaseModule {
  static forRoot(): DynamicModule {
    return {
      module: PrismaDatabaseModule,
      global: true,
      imports: [ConfigModule],
      providers: [PrismaService],
      exports: [PrismaService],
    };
  }
}
