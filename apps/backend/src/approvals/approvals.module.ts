import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalRequestService } from './approvals.service';
import { ApprovalDecisionBus } from './approval-decision.bus';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartiesModule } from '../parties/parties.module';

/**
 * Approval engine (Phase 6 lean + Phase 9B generalization).
 * NotificationsModule supplies the NotificationService (requester /
 * approver notifications); PartiesModule the shared TimelineService.
 * ApprovalDecisionBus is the one-way bridge downstream engines (workflow)
 * subscribe to — ApprovalsModule never imports them back.
 */
@Module({
  imports: [NotificationsModule, PartiesModule],
  controllers: [ApprovalsController],
  providers: [ApprovalRequestService, ApprovalDecisionBus],
  exports: [ApprovalRequestService, ApprovalDecisionBus],
})
export class ApprovalsModule {}
