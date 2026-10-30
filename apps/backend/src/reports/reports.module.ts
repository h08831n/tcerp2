import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Management reports (Phase 10, Gate F): read-only SQL aggregates over the
 * operational sources of truth. PrismaModule/PermissionsModule/Companies are
 * global — no extra imports.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
