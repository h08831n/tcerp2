import { Injectable, Logger } from '@nestjs/common';
import { ApprovalRequest } from '@prisma/client';

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export interface ApprovalDecisionListener {
  onApprovalDecided(approval: ApprovalRequest, decision: ApprovalDecision): Promise<void>;
}

/**
 * One-way decision bridge between the approval engine and downstream
 * automations (the workflow engine subscribes to resume approval-gated
 * transitions). Kept as a tiny bus — not a direct service injection — so
 * ApprovalsModule never depends on WorkflowModule (one-way module graph).
 *
 * Contract: emit() runs strictly AFTER the deciding transaction has
 * committed; a listener failure NEVER un-decides the approval — the bridge
 * logs it and the listener owns its own recovery (retry enqueue).
 */
@Injectable()
export class ApprovalDecisionBus {
  private readonly logger = new Logger('ApprovalDecisionBus');
  private listener: ApprovalDecisionListener | null = null;

  register(listener: ApprovalDecisionListener): void {
    this.listener = listener;
  }

  async emit(approval: ApprovalRequest, decision: ApprovalDecision): Promise<void> {
    if (!this.listener) return;
    try {
      await this.listener.onApprovalDecided(approval, decision);
    } catch (error) {
      this.logger.error(
        `Approval decision bridge failed for request ${approval.id} (${decision}): ${String(error)}`,
      );
    }
  }
}
