import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AppConfig, CONFIG } from '../config/configuration';

/**
 * D2-16/D2-13 (docs/17 §5): CSRF defense layers for the cookie-authenticated
 * portal surface, evaluated BEFORE guards:
 *
 *   1. Sec-Fetch-Site (browsers): a `cross-site` value proves the request was
 *      NOT initiated by our site → reject.
 *   2. Origin whitelist (server-side): an Origin header that is not in the
 *      configured CORS_ORIGINS whitelist is rejected — this covers clients
 *      that send Origin but not Sec-Fetch-Site.
 *
 * EXPLICIT POLICY — a request with NO Origin and NO Sec-Fetch-Site header is
 * ACCEPTED: non-browser clients (curl, server-to-server integrations, Node
 * test clients) never send either header, and for browsers SameSite=Lax
 * already keeps the session cookie off cross-site requests. Both checks are
 * pure request-header decisions — a rejected request touches no database row.
 *
 * The error envelope mirrors GlobalExceptionFilter's shape because NestJS
 * exception filters do not intercept middleware errors.
 */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

@Injectable()
export class PortalFetchMetadataMiddleware implements NestMiddleware {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const fetchSite = request.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && !ALLOWED_FETCH_SITES.has(fetchSite)) {
      this.reject(response, request, 'CROSS_SITE_REJECTED');
      return;
    }
    const origin = request.headers['origin'];
    if (typeof origin === 'string' && origin.length > 0) {
      const allowed = this.config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
      if (!allowed.includes(origin)) {
        this.reject(response, request, 'ORIGIN_NOT_ALLOWED');
        return;
      }
    }
    next();
  }

  private reject(response: Response, request: Request, message: string): void {
    response.status(403).json({
      statusCode: 403,
      code: 'FORBIDDEN',
      message,
      path: request.path,
      timestamp: new Date().toISOString(),
    });
  }
}
