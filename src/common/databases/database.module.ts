import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseOptions } from './types/database.type';
import { PrismaDatabaseModule } from './drivers/prisma.module';

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    const modules: DynamicModule[] = [];

    switch (options.driver) {
      case 'prisma':
        modules.push(PrismaDatabaseModule.forRoot());
        break;
      default:
        throw new Error(`Unsupported database driver: ${String(options.driver)}`);
    }

    return {
      module: DatabaseModule,
      imports: modules,
      exports: modules,
    };
  }
}
