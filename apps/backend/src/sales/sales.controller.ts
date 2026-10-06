import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { SalesDocumentsService, SalesActorContext } from './sales-documents.service';
import { resolveSalesScope } from './sales-scope';
import {
  AddSalesLineDto,
  CreateLinesFromMatrixDto,
  CreateSalesDocumentDto,
  LostDocumentDto,
  SalesDocumentQueryDto,
  UpdateSalesDocumentDto,
  UpdateSalesLineDto,
} from './sales.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import { PermissionsService } from '../permissions/permissions.service';

/**
 * Sales documents (Phase 4). Record scope OWN/TEAM/ALL is resolved from
 * `sales.scope.*` / `sales.view_all` and enforced in the service. The
 * cross-flow endpoint POST /api/sales/:id/create-purchase lives in the
 * purchase module (purchase/flow.controller.ts) so the two document modules
 * never import each other.
 */

@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesDocumentsService,
    private readonly companyContext: CompanyContextService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  /** Resolve company + scope + override rights for the actor. */
  private async actorContext(user: { id: string }, request: Request): Promise<{ companyId: string; context: SalesActorContext }> {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(user.id, companyId);
    const actorScope = { userId: user.id, scope: resolveSalesScope(effective) };
    return {
      companyId,
      context: {
        actorScope,
        teamUserIds: [], // resolved inside the service when scope = TEAM
        canOverrideConfirmedOrder: effective.has('sales.override_confirmed_order'),
      },
    };
  }

  @Post()
  @RequirePermissions('sales.create')
  async create(
    @Body() dto: CreateSalesDocumentDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.create(companyId, context.actorScope, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('sales.view')
  async list(@Query() query: SalesDocumentQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const { companyId, context } = await this.actorContext(user, request);
    return this.salesService.list(companyId, context.actorScope, query);
  }

  @Get('export')
  @RequirePermissions('sales.export')
  async exportAll(@Query() query: SalesDocumentQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const { companyId, context } = await this.actorContext(user, request);
    return this.salesService.list(companyId, context.actorScope, query);
  }

  @Get(':id')
  @RequirePermissions('sales.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const { companyId, context } = await this.actorContext(user, request);
    return this.salesService.getById(companyId, context.actorScope, id);
  }

  @Patch(':id')
  @RequirePermissions('sales.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalesDocumentDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.update(companyId, context, id, dto, actor, this.ctx(request));
  }

  // ── transitions (same id, same number — REQUIREMENTS §9) ──

  @Post(':id/send')
  @RequirePermissions('sales.edit')
  async send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.send(companyId, context.actorScope, id, actor, this.ctx(request));
  }

  @Post(':id/confirm')
  @RequirePermissions('sales.confirm')
  async confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.confirm(companyId, context.actorScope, id, actor, this.ctx(request));
  }

  @Post(':id/activate')
  @RequirePermissions('sales.confirm')
  async activate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.activate(companyId, context.actorScope, id, actor, this.ctx(request));
  }

  @Post(':id/lost')
  @RequirePermissions('sales.edit')
  async lost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LostDocumentDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.lost(companyId, context.actorScope, id, dto, actor, this.ctx(request));
  }

  @Post(':id/cancel')
  @RequirePermissions('sales.cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.cancel(companyId, context.actorScope, id, actor, this.ctx(request));
  }

  // ── lines ──

  @Post(':id/lines')
  @RequirePermissions('sales.edit')
  async addLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddSalesLineDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.addLine(companyId, context, id, dto, actor, this.ctx(request));
  }

  @Post(':id/lines/matrix')
  @RequirePermissions('sales.edit')
  async createFromMatrix(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateLinesFromMatrixDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.createFromMatrix(companyId, context, id, dto, actor, this.ctx(request));
  }

  @Patch(':id/lines/:lineId')
  @RequirePermissions('sales.edit')
  async updateLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: UpdateSalesLineDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.updateLine(companyId, context, id, lineId, dto, actor, this.ctx(request));
  }

  @Delete(':id/lines/:lineId')
  @RequirePermissions('sales.edit')
  async deleteLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: { overrideReason?: string },
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, context } = await this.actorContext(actor, request);
    return this.salesService.deleteLine(companyId, context, id, lineId, actor, this.ctx(request), body?.overrideReason);
  }
}
