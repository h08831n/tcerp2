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
import { PartyRoleType } from '@prisma/client';
import { PartiesService, ActorScope } from './parties.service';
import { FinancialResponsibilityService } from './financial-responsibility.service';
import { CustomerScoreService } from './customer-score.service';
import { TimelineService } from './timeline.service';
import {
  AddFinancialResponsibilityDto,
  AddPartyPhoneDto,
  AddRoleDto,
  AssignOwnerDto,
  CheckDuplicateDto,
  CreateAddressDto,
  CreateContactDto,
  CreatePartyDto,
  PartyQueryDto,
  TimelineQueryDto,
  UpdateAddressDto,
  UpdateContactDto,
  UpdatePartyDto,
} from './parties.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import { PermissionsService } from '../permissions/permissions.service';
import { resolveRecordScope } from './party-scope';

@Controller('parties')
export class PartiesController {
  constructor(
    private readonly partiesService: PartiesService,
    private readonly financialResponsibilityService: FinancialResponsibilityService,
    private readonly customerScoreService: CustomerScoreService,
    private readonly timeline: TimelineService,
    private readonly companyContext: CompanyContextService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  /** Resolve the request company + record scope (OWN/TEAM/ALL) for the actor. */
  private async actorScope(
    user: { id: string },
    request: Request,
  ): Promise<{ companyId: string; actorScope: ActorScope }> {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(user.id, companyId);
    return { companyId, actorScope: { userId: user.id, scope: resolveRecordScope(effective) } };
  }

  // ─────────────────────── duplicate check / CRUD ───────────────────────

  @Post('check-duplicate')
  @RequirePermissions('parties.view')
  async checkDuplicate(
    @Body() dto: CheckDuplicateDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const { companyId } = await this.actorScope(user, request);
    return this.partiesService.checkDuplicate(companyId, dto);
  }

  @Post()
  @RequirePermissions('parties.create')
  async create(
    @Body() dto: CreatePartyDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId } = await this.actorScope(actor, request);
    return this.partiesService.create(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('parties.view')
  async list(
    @Query() query: PartyQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(user, request);
    return this.partiesService.list(companyId, actorScope, query);
  }

  @Get(':id')
  @RequirePermissions('parties.view')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(user, request);
    return this.partiesService.getById(companyId, actorScope, id);
  }

  @Patch(':id')
  @RequirePermissions('parties.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartyDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    const effective = await this.permissionsService.getEffectivePermissions(actor.id, companyId);
    return this.partiesService.update(
      companyId,
      actorScope,
      id,
      dto,
      { canChangeOwner: effective.has('parties.owner.change') },
      actor,
      this.ctx(request),
    );
  }

  /** Soft archive (DELETE semantics; reversible via restore). */
  @Delete(':id')
  @RequirePermissions('parties.archive')
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.archive(companyId, actorScope, id, actor, this.ctx(request));
  }

  @Post(':id/restore')
  @RequirePermissions('parties.archive')
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.restore(companyId, actorScope, id, actor, this.ctx(request));
  }

  // ─────────────────────── roles ───────────────────────

  @Post(':id/roles')
  @RequirePermissions('parties.role.manage')
  async addRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddRoleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.addRole(companyId, actorScope, id, dto, actor, this.ctx(request));
  }

  @Delete(':id/roles/:role')
  @RequirePermissions('parties.role.manage')
  async removeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: PartyRoleType,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.removeRole(
      companyId,
      actorScope,
      id,
      role,
      actor,
      this.ctx(request),
    );
  }

  // ─────────────────────── phones ───────────────────────

  @Post(':id/phones')
  @RequirePermissions('parties.phone.manage')
  async addPhone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddPartyPhoneDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.addPhone(companyId, actorScope, id, dto, actor, this.ctx(request));
  }

  @Delete(':id/phones/:phoneId')
  @RequirePermissions('parties.phone.manage')
  async removePhone(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('phoneId', ParseUUIDPipe) phoneId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.removePhone(
      companyId,
      actorScope,
      id,
      phoneId,
      actor,
      this.ctx(request),
    );
  }

  // ─────────────────────── contacts ───────────────────────

  @Post(':id/contacts')
  @RequirePermissions('parties.contact.manage')
  async addContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContactDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.addContact(companyId, actorScope, id, dto, actor, this.ctx(request));
  }

  @Patch(':id/contacts/:contactId')
  @RequirePermissions('parties.contact.manage')
  async updateContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateContactDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.updateContact(
      companyId,
      actorScope,
      id,
      contactId,
      dto,
      actor,
      this.ctx(request),
    );
  }

  @Delete(':id/contacts/:contactId')
  @RequirePermissions('parties.contact.manage')
  async removeContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.removeContact(
      companyId,
      actorScope,
      id,
      contactId,
      actor,
      this.ctx(request),
    );
  }

  // ─────────────────────── addresses ───────────────────────

  @Post(':id/addresses')
  @RequirePermissions('parties.address.manage')
  async addAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAddressDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.addAddress(companyId, actorScope, id, dto, actor, this.ctx(request));
  }

  @Patch(':id/addresses/:addressId')
  @RequirePermissions('parties.address.manage')
  async updateAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: UpdateAddressDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.updateAddress(
      companyId,
      actorScope,
      id,
      addressId,
      dto,
      actor,
      this.ctx(request),
    );
  }

  @Delete(':id/addresses/:addressId')
  @RequirePermissions('parties.address.manage')
  async removeAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.removeAddress(
      companyId,
      actorScope,
      id,
      addressId,
      actor,
      this.ctx(request),
    );
  }

  // ─────────────────────── owner ───────────────────────

  @Post(':id/owner')
  @RequirePermissions('parties.owner.change')
  async changeOwner(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignOwnerDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(actor, request);
    return this.partiesService.changeOwner(
      companyId,
      actorScope,
      id,
      dto,
      actor,
      this.ctx(request),
    );
  }

  // ─────────────────────── timeline ───────────────────────

  @Get(':id/timeline')
  @RequirePermissions('timeline.view')
  async getTimeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TimelineQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const { companyId, actorScope } = await this.actorScope(user, request);
    // Party existence + record scope enforcement.
    await this.partiesService.getById(companyId, actorScope, id);
    // Hidden events: only for scope-ALL holders (managers) or audit.view.
    const includeHidden =
      query.includeHidden === true &&
      (actorScope.scope === 'ALL' ||
        (await this.permissionsService.getEffectivePermissions(user.id, companyId)).has('audit.view'));
    return this.timeline.listForEntity(companyId, 'PARTY', id, {
      limit: query.limit,
      includeHidden,
    });
  }

  // ─────────────────────── financial responsibility ───────────────────────

  @Post(':id/financial-responsibility')
  @RequirePermissions('financialresponsibility.manage')
  async addToFinancialGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddFinancialResponsibilityDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId } = await this.actorScope(actor, request);
    return this.financialResponsibilityService.addMember(
      companyId,
      id,
      dto,
      actor,
      this.ctx(request),
    );
  }

  @Delete(':id/financial-responsibility')
  @RequirePermissions('financialresponsibility.manage')
  async removeFromFinancialGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId } = await this.actorScope(actor, request);
    return this.financialResponsibilityService.removeMembership(
      companyId,
      id,
      actor,
      this.ctx(request),
    );
  }

  @Get(':id/financial-responsibility')
  @RequirePermissions('financialresponsibility.manage')
  async getFinancialGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const { companyId } = await this.actorScope(user, request);
    return this.financialResponsibilityService.getGroup(companyId, id);
  }

  // ─────────────────────── customer score ───────────────────────

  @Post(':id/score/recompute')
  @RequirePermissions('parties.score.compute')
  async recomputeScore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId } = await this.actorScope(actor, request);
    return this.customerScoreService.compute(companyId, id, actor);
  }

  @Get(':id/score')
  @RequirePermissions('parties.view')
  async getScore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const { companyId } = await this.actorScope(user, request);
    return this.customerScoreService.getScore(companyId, id);
  }
}
