import { Module } from '@nestjs/common';
import { AllocationsController } from './allocations.controller';
import { AllocationsService } from './allocations.service';

/**
 * Sales ↔ Purchase line-level M:N allocations (Phase 4, REQUIREMENTS §12).
 * Serializable transactions + row locks prevent concurrent over-allocation.
 */
@Module({
  controllers: [AllocationsController],
  providers: [AllocationsService],
  exports: [AllocationsService],
})
export class AllocationsModule {}
