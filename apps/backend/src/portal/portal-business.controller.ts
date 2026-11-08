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
import { AppError } from '../common/errors';

/**
 * Pagination query parsing for the portal read models: garbage input is a
 * typed 400 BAD_REQUEST — never a 500 from NaN leaking into Prisma
 * skip/take. Non-numeric, negative and decimal values are rejected;
 * out-of-range values are capped by the service.
 */
function parseIntQuery(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError(400, 'BAD_REQUEST', `${name} must be a positive safe integer (got "${raw}")`);
  }
  // Prisma skip/take are int32 — a page beyond ~42M rows at limit 50 would
  // overflow the offset calculation even if the page itself fits in a safe
  // integer. The cap is generous (no real dataset needs page 1M+).
  if (name === 'page' && value > 1_000_000) {
    throw new AppError(400, 'BAD_REQUEST', `${name} must be at most 1000000 (got "${raw}")`);
  }
  return value;
}

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
      page: parseIntQuery(page, 'page', 1),
      limit: parseIntQuery(limit, 'limit', 20),
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
      page: parseIntQuery(page, 'page', 1),
      limit: parseIntQuery(limit, 'limit', 20),
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
