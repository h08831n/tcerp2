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
import { LoadingService } from './loading.service';
import {
  CreateLoadingDto,
  LoadingQueryDto,
  ReleaseDriverInfoDto,
  ReverseLoadingDto,
  UpdateLoadingDto,
} from './loading.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import { PermissionsService } from '../permissions/permissions.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';

/**
 * Driver-info visibility (REQUIREMENTS §20 / p6-08): a caller sees restricted
 * driver/carrier details only when holding `loading.driver_info.release` OR
 * `approvals.decide`; everyone else (e.g. salespersons) gets the stripped
 * payload (`driver: null, carrier: null, restricted: true`).
 */
const DRIVER_INFO_PERMISSIONS = ['loading.driver_info.release', 'approvals.decide'];

@Controller('loadings')
export class LoadingController {
  constructor(
    private readonly loadingService: LoadingService,
    private readonly companyContext: CompanyContextService,
    private readonly permissionsService: PermissionsService,
    private readonly relations: DocumentRelationService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  private async viewer(companyId: string, userId: string) {
    const effective = await this.permissionsService.getEffectivePermissions(userId, companyId);
    return {
      canViewDriverInfo: DRIVER_INFO_PERMISSIONS.some((code) => effective.has(code)),
    };
  }

  @Get()
  @RequirePermissions('loading.view')
  async list(
    @Query() query: LoadingQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(user.id, companyId);
    return this.loadingService.list(
      companyId,
      { userId: user.id, scopeAll: effective.has('loading.view_all') },
      query,
    );
  }

  @Post()
  @RequirePermissions('loading.create')
  async create(
    @Body() dto: CreateLoadingDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.loadingService.create(
      companyId,
      {
        loadingDate: new Date(dto.loadingDate),
        route: dto.route,
        warehouseId: dto.warehouseId,
        customerPartyId: dto.customerPartyId,
        driverPartyId: dto.driverPartyId,
        carrierPartyId: dto.carrierPartyId,
        notes: dto.notes,
        lines: dto.lines,
      },
      actor,
      this.ctx(request),
    );
  }

  @Get(':id')
  @RequirePermissions('loading.view')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.loadingService.getById(companyId, id, await this.viewer(companyId, user.id));
  }

  @Patch(':id')
  @RequirePermissions('loading.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLoadingDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.loadingService.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Delete(':id')
  @RequirePermissions('loading.cancel')
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.loadingService.delete(companyId, id, actor, this.ctx(request));
    return { deleted: true };
  }

  @Post(':id/cancel')
  @RequirePermissions('loading.cancel')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.loadingService.cancel(companyId, id, actor, this.ctx(request));
  }

  @Post(':id/confirm')
  @RequirePermissions('loading.confirm')
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.loadingService.confirm(companyId, id, actor, this.ctx(request));
  }

  /**
   * CONFIRMED → REVERSED with a REQUIRED reason (Integrity Gate #11): one
   * atomic transaction — compensating movements (swapped endpoints,
   * reversalOfMovementId linkage), operational rollback on both documents,
   * pending driver-info approvals CANCELLED, audit + timeline. A reversed
   * loading is immutable forever.
   */
  @Post(':id/reverse')
  @RequirePermissions('loading.reverse')
  async reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseLoadingDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.loadingService.reverse(companyId, id, dto, actor, this.ctx(request));
  }

  /** Manager releases restricted driver/carrier info (debt gate APPROVED). */
  @Post(':id/driver-info/release')
  @RequirePermissions('loading.driver_info.release')
  async releaseDriverInfo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReleaseDriverInfoDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.loadingService.releaseDriverInfo(
      companyId,
      id,
      { decision: 'APPROVED', note: dto.note },
      actor,
      this.ctx(request),
    );
  }

  /** Manager rejects the release — the info stays hidden. */
  @Post(':id/driver-info/reject')
  @RequirePermissions('loading.driver_info.release')
  async rejectDriverInfo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReleaseDriverInfoDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.loadingService.releaseDriverInfo(
      companyId,
      id,
      { decision: 'REJECTED', note: dto.note },
      actor,
      this.ctx(request),
    );
  }

  /** Related documents for a loading (delegates to the document-flow layer). */
  @Get(':id/relations')
  @RequirePermissions('loading.view')
  async listRelations(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.relations.listRelations(companyId, 'loading', id);
  }
}
