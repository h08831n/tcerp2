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
import { InventoryService } from './inventory.service';
import {
  CreateTransferDto,
  CreateWarehouseDto,
  LocationQueryDto,
  MovementQueryDto,
  StockQueryDto,
  UpdateWarehouseDto,
} from './inventory.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * GET  /api/inventory/stock       — computed per-variant stock, location
 *                                    semantics, normalizedQuantity sums
 *                                    (inventory.view)
 * GET  /api/inventory/movements   — movement ledger with both quantity/uom
 *                                    pairs + location endpoints (inventory.view)
 * GET  /api/inventory/locations   — stock locations (inventory.view)
 * GET  /api/inventory/warehouses  — warehouse list (inventory.view)
 * POST /api/inventory/transfer    — internal warehouse→warehouse transfer
 *                                    (inventory.edit)
 * POST/PATCH/DELETE /api/inventory/warehouses(+:id/set-default)
 *                                  — inventory.warehouses.manage
 */
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get('stock')
  @RequirePermissions('inventory.view')
  async stock(
    @Query() query: StockQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.inventory.stock(companyId, query);
  }

  @Get('movements')
  @RequirePermissions('inventory.view')
  async movements(
    @Query() query: MovementQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.inventory.movements(companyId, query);
  }

  @Get('locations')
  @RequirePermissions('inventory.view')
  async locations(
    @Query() query: LocationQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.inventory.listLocations(companyId, query);
  }

  /** Internal warehouse→warehouse transfer (single INTERNAL→INTERNAL movement). */
  @Post('transfer')
  @RequirePermissions('inventory.edit')
  async transfer(
    @Body() dto: CreateTransferDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.inventory.transfer(companyId, dto, actor, this.ctx(request));
  }

  @Get('warehouses')
  @RequirePermissions('inventory.view')
  async listWarehouses(
    @Query('active') active: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const activeFilter = active === undefined ? undefined : active === 'true';
    return this.inventory.listWarehouses(companyId, activeFilter);
  }

  @Post('warehouses')
  @RequirePermissions('inventory.warehouses.manage')
  async createWarehouse(
    @Body() dto: CreateWarehouseDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.inventory.createWarehouse(companyId, dto, actor, this.ctx(request));
  }

  @Patch('warehouses/:id')
  @RequirePermissions('inventory.warehouses.manage')
  async updateWarehouse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.inventory.updateWarehouse(companyId, id, dto, actor, this.ctx(request));
  }

  @Post('warehouses/:id/set-default')
  @RequirePermissions('inventory.warehouses.manage')
  async setDefaultWarehouse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.inventory.setDefaultWarehouse(companyId, id, actor, this.ctx(request));
  }

  @Delete('warehouses/:id')
  @RequirePermissions('inventory.warehouses.manage')
  async deleteWarehouse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.inventory.deleteWarehouse(companyId, id, actor, this.ctx(request));
    return { deleted: true };
  }
}
