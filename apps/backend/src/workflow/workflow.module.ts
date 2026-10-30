import { Module, OnModuleInit } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowService, WorkflowResumeHandler } from './workflow.service';
import { WorkflowTimerModule } from '../workflow-timer/workflow-timer.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QueueHandlerRegistry } from '../queue/queue.handlers';

/**
 * Workflow state-machine engine (Phase 9B, Gate E). Depends on:
 * - WorkflowTimerModule (durable SLA/escalation timers + action registry)
 * - ApprovalsModule (approval-gated transitions + the one-way decision bus)
 * - NotificationsModule (approver / escalation / post-transition notifications)
 * QueueModule, AuditModule, PrismaModule, PermissionsModule are global.
 */
@Module({
  imports: [WorkflowTimerModule, ApprovalsModule, NotificationsModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowResumeHandler],
  exports: [WorkflowService],
})
export class WorkflowModule implements OnModuleInit {
  constructor(
    private readonly registry: QueueHandlerRegistry,
    private readonly resumeHandler: WorkflowResumeHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.resumeHandler);
  }
}
