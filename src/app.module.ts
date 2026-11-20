import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import configuration from './common/configs/configuration';
import { validateEnv } from './common/configs/env.validation';
import { pinoHttpOptions } from './common/configs/logger.config';
import { FeatureAuthzModule } from './modules/feature-auth/feature-auth.module';
import { BranchModule } from './modules/feature-branch/branch.module';
import { EndOfDayReportModule } from './modules/feature-report/end-of-day/end-of-day-report.module';
import { CatalogModule } from './modules/feature-catalog/catalog.module';
import { StorefrontModule } from './modules/feature-storefront/storefront.module';
import { InventoryModule } from './modules/feature-inventory/inventory.module';
import { StaffReportModule } from './modules/feature-report/staff/staff-report.module';
import { SalesModule } from './modules/feature-sales/sales.module';
import { ReportModule } from './modules/feature-report/report.module';
import { AuditLogQueryModule } from './modules/feature-audit/audit-log-query.module';
import { SupplierReportModule } from './modules/feature-report/supplier/supplier-report.module';
import { AssistantModule } from './modules/feature-assistant/assistant.module';
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

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ pinoHttp: pinoHttpOptions(config.get<string>('NODE_ENV')) }),
    }),

    //- Module chính
    FeatureAuthzModule,
    BranchModule,
    EndOfDayReportModule,
    CatalogModule,
    StorefrontModule,
    InventoryModule,
    StaffReportModule,
    SalesModule,
    ReportModule,
    AuditLogQueryModule,
    SupplierReportModule,
    AssistantModule,

    // MailerModule,
  ],
})
export class AppModule {}
