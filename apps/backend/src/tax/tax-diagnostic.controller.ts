import { Controller, Get, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import {
  MoadianDiagnosticService,
  type DiagnosticReport,
} from './moadian/moadian-diagnostic.service';

const RATE_LIMIT_MS = 15_000; // 15s cooldown between administrator diagnostics

/**
 * Administrator-only Moadian connection diagnostics (Phase 8).
 * Permissions: `settings.edit` AND `tax.submit` — both required (AND), which
 * is the administrator/operator combination; the salesperson/accountant roles
 * cannot reach it. Backend authorization is enforced by the global guard
 * chain — the UI button is not the security boundary.
 */
@Controller('tax/diagnostics')
export class TaxDiagnosticController {
  constructor(
    private readonly diagnostics: MoadianDiagnosticService,
    private readonly companyContext: CompanyContextService,
    private readonly audit: AuditService,
  ) {}

  private async admin(companyId: string, actor: { id: string; username: string }) {
    await this.audit.record({
      entityType: 'moadian_diagnostic',
      entityId: companyId,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      newValues: { kind: 'connection', note: 'moadian diagnostic run' }, // no secrets recorded
    });
  }

  /** «تست اتصال به سامانه مؤدیان» — ordered, non-mutating diagnostic. */
  @Get('connection')
  @RequirePermissions('settings.edit', 'tax.submit')
  async connection(
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ): Promise<DiagnosticReport | { status: 'RUN_RATE_LIMITED'; waitSeconds: number }> {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const limited = this.diagnostics.rateLimit(RATE_LIMIT_MS);
    if (limited) return { status: 'RUN_RATE_LIMITED', waitSeconds: Number(limited.split(':')[1]) };
    await this.admin(companyId, actor);
    // one diagnostic at a time; concurrent clicks wait then run fresh
    return this.diagnostics.runSerialized(() => this.diagnostics.runConnectionDiagnostics());
  }

  /** «اجرای آزمون کامل محیط آزمایشی» — sandbox ONLY; blocked in live/mock. */
  @Post('sandbox-full-test')
  @RequirePermissions('settings.edit', 'tax.submit')
  async sandboxFullTest(
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const limited = this.diagnostics.rateLimit(RATE_LIMIT_MS);
    if (limited) return { status: 'RUN_RATE_LIMITED', waitSeconds: Number(limited.split(':')[1]) };
    await this.audit.record({
      entityType: 'moadian_diagnostic',
      entityId: companyId,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      newValues: { kind: 'sandbox-full-test', note: 'moadian sandbox test run' }, // no secrets recorded
    });
    return this.diagnostics.runSerialized(() => this.diagnostics.runSandboxFullTest());
  }
}
