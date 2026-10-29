import { Module } from '@nestjs/common';
import { ActivitiesController } from './activities.controller';
import { ActivityService } from './activity.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PartiesModule } from '../parties/parties.module';

@Module({
  imports: [PrismaModule, AuditModule, PartiesModule],
  controllers: [ActivitiesController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivitiesModule {}
