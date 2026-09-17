import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseOptions } from './types/database.type';
import { MongooseDatabaseModule } from './drivers/mongoose.module';

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    let modules: DynamicModule[] = [];

    switch (options.driver) {
      case 'mongoose':
        modules.push(MongooseDatabaseModule.forRoot());
        break;
    }

    return {
      module: DatabaseModule,
      imports: modules,
      exports: modules,
    };
  }
}
