import { Body, Controller, Post, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { Request } from 'express';
import { SalesDocumentsService } from './sales-documents.service';
import { resolveSalesScope } from './sales-scope';
import { CreateSaleFromPurchaseDto } from './sales.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { PermissionsService } from '../permissions/permissions.service';

/**
 * Cross-flow: from a PURCHASE create a SALE (REQUIREMENTS §11). Registered in
 * the sales module (which owns sales creation + CUSTOMER validation + scope)
 * so the sales and purchase modules never import each other.
 */
@Controller('purchase')
export class PurchaseToSalesFlowController {
  constructor(
    private readonly salesService: SalesDocumentsService,
    private readonly companyContext: CompanyContextService,
    private readonly permissionsService: PermissionsService,
  ) {}

  @Post(':id/create-sale')
  @RequirePermissions('sales.create')
  async createSaleFromPurchase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSaleFromPurchaseDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(actor.id, companyId);
    const actorScope = { userId: actor.id, scope: resolveSalesScope(effective) };
    return this.salesService.createSaleFromPurchase(companyId, actorScope, id, dto, actor, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }
}
