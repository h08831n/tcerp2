import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Management reports (Phase 10, Gate F): read-only SQL aggregates over the
 * operational sources of truth. The debt report mirrors the 7C subsidiary
 * balance formula with LEFT-JOIN semantics (its own g10-09 pin);
 * PrismaModule/PermissionsModule/Companies are global.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
