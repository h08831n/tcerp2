import { Global, Module } from '@nestjs/common';
import { SequencesController } from './sequences.controller';
import { SequencesService } from './sequences.service';

/**
 * Global: document numbering is a cross-cutting platform service
 * (journal posting, treasury documents, future domain documents).
 */
@Global()
@Module({
  controllers: [SequencesController],
  providers: [SequencesService],
  exports: [SequencesService],
})
export class SequencesModule {}
