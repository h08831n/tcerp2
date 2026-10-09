import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalRequestService } from './approvals.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartiesModule } from '../parties/parties.module';

/**
 * Lean approval engine (Phase 6). NotificationsModule supplies the
 * NotificationService (requester notification on decisions); PartiesModule
 * the shared TimelineService.
 */
@Module({
  imports: [NotificationsModule, PartiesModule],
  controllers: [ApprovalsController],
  providers: [ApprovalRequestService],
  exports: [ApprovalRequestService],
})
export class ApprovalsModule {}
