import { Controller, Get, Headers, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PublicApiService } from './public-api.service';

/**
 * Public API (Phase 5, REQUIREMENTS §74-75) — @Public() routes under
 * /api/public. Auth placeholder: optional `X-API-KEY` header checked against
 * the company Setting `publicapi.key` when set (see PublicApiService).
 * All responses are read-only and company-scoped; the portal lookup leaks
 * NO customer data ({matched, linked} only).
 */
@Controller('public')
export class PublicApiController {
  constructor(private readonly publicApiService: PublicApiService) {}

  @Get('prices')
  @Public()
  async prices(
    @Query('date') date?: string,
    @Query('companyId') companyId?: string,
    @Headers('x-api-key') apiKey?: string,
  ) {
    const resolved = await this.publicApiService.resolveCompanyId({ apiKey, companyId });
    return this.publicApiService.prices(resolved, { date, companyId });
  }

  @Get('prices/:variantId/history')
  @Public()
  async priceHistory(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Query('days') days?: string,
    @Query('companyId') companyId?: string,
    @Headers('x-api-key') apiKey?: string,
  ) {
    const resolved = await this.publicApiService.resolveCompanyId({ apiKey, companyId });
    const parsedDays = days ? Number(days) : 30;
    return this.publicApiService.priceHistory(resolved, variantId, parsedDays);
  }

  @Get('portal/lookup')
  @Public()
  async portalLookup(
    @Query('mobile') mobile?: string,
    @Query('companyId') companyId?: string,
    @Headers('x-api-key') apiKey?: string,
  ) {
    const resolved = await this.publicApiService.resolveCompanyId({ apiKey, companyId });
    return this.publicApiService.portalLookup(resolved, mobile ?? '');
  }
}
