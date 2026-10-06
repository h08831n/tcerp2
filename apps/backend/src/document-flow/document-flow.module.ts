import { Module } from '@nestjs/common';
import { DocumentRelationsController } from './document-flow.controller';
import { DocumentRelationService } from './document-relation.service';

/** Document Flow navigation layer (REQUIREMENTS §13). */
@Module({
  controllers: [DocumentRelationsController],
  providers: [DocumentRelationService],
  exports: [DocumentRelationService],
})
export class DocumentFlowModule {}
