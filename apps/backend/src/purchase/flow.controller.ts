import { Body, Controller, Post, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { Request } from 'express';
import { PurchaseDocumentsService } from './purchase-documents.service';
import { CreatePurchaseFromSaleDto } from '../sales/sales.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Cross-flow: from a SALE create a PURCHASE (REQUIREMENTS §11). Registered in
 * the purchase module (which owns purchase creation + SUPPLIER validation) so
 * the sales and purchase modules never import each other.
 */
@Controller('sales')
export class SalesToPurchaseFlowController {
  constructor(
    private readonly purchaseService: PurchaseDocumentsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Post(':id/create-purchase')
  @RequirePermissions('purchase.create')
  async createPurchaseFromSale(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePurchaseFromSaleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.purchaseService.createPurchaseFromSale(companyId, id, dto, actor, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    } as RequestContext);
  }
}
