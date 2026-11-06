import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PortalAuthGuard } from './portal-auth.guard';
import { PortalBusinessService, PortalSessionContext } from './portal-business.service';

interface PortalRequest extends Request {
  portalSession?: PortalSessionContext;
}

/**
 * Portal Business API (Gate D-2 Phase 2) — safe read models for the
 * customer portal. Every endpoint is protected by PortalAuthGuard and
 * company+party scoped from the verified session.
 *
 * D2-13: GET /api/portal/me is THE single session-identity contract
 * ({companyId, partyId}) owned by PortalAuthController — the business
 * profile lives HERE at /api/portal/profile (a duplicate /me handler
 * would be shadowed and was removed).
 */
@Public()
@UseGuards(PortalAuthGuard)
@Controller('portal')
export class PortalBusinessController {
  constructor(private readonly business: PortalBusinessService) {}

  private ctx(request: PortalRequest): PortalSessionContext {
    return {
      companyId: request.portalSession!.companyId,
      partyId: request.portalSession!.partyId,
    };
  }

  // Business profile (party/company names, roles) — NOT identity (/me).
  @Get('profile')
  async profile(@Req() request: PortalRequest) {
    return this.business.getProfile(this.ctx(request));
  }

  @Get('orders')
  async listOrders(
    @Req() request: PortalRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.business.listOrders(this.ctx(request), {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
    });
  }

  @Get('orders/:id')
  async getOrder(@Req() request: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.business.getOrder(this.ctx(request), id);
  }

  @Get('loadings')
  async listLoadings(
    @Req() request: PortalRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.business.listLoadings(this.ctx(request), {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('loadings/:id')
  async getLoading(@Req() request: PortalRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.business.getLoading(this.ctx(request), id);
  }

  @Get('debt')
  async getDebt(@Req() request: PortalRequest) {
    return this.business.getDebt(this.ctx(request));
  }
}
