import { Module } from '@nestjs/common';
import { ImportsController, ExportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * Import/export engine (Phase 11, Gate G): durable resumable CSV import +
 * parties export. AuditModule/PrismaModule/Companies are global.
 */
@Module({
  controllers: [ImportsController, ExportsController],
  providers: [ImportsService],
  exports: [ImportsService],
})
export class ImportsModule {}
