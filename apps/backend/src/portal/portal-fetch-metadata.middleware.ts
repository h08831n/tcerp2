import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * D2-13 (docs/17 §5): second CSRF defense layer for the cookie-authenticated
 * portal surface. Modern browsers send Sec-Fetch-Site on every request; a
 * cross-site value means the request was NOT initiated by our own site —
 * reject it before guards run. Clients that do not send the header at all
 * (non-browser integrations, older browsers) fall through — SameSite=Lax
 * already keeps the session cookie off cross-site requests for them.
 *
 * The error envelope mirrors GlobalExceptionFilter's shape because NestJS
 * exception filters do not intercept middleware errors.
 */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

@Injectable()
export class PortalFetchMetadataMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const fetchSite = request.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && !ALLOWED_FETCH_SITES.has(fetchSite)) {
      response.status(403).json({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'CROSS_SITE_REJECTED',
        path: request.path,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    next();
  }
}
