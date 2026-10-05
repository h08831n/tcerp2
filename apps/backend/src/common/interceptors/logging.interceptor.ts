import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * One structured JSON log line per request:
 * { timestamp, level, context, method, url, statusCode, durationMs, userId }
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { id?: string } }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.write(http.getResponse().statusCode, request, startedAt),
        error: (err: { status?: number }) =>
          this.write(err?.status ?? 500, request, startedAt),
      }),
    );
  }

  private write(
    statusCode: number,
    request: Request & { user?: { id?: string } },
    startedAt: number,
  ): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: statusCode >= 500 ? 'error' : 'info',
      context: 'http',
      method: request.method,
      url: request.originalUrl,
      statusCode,
      durationMs: Date.now() - startedAt,
      userId: request.user?.id,
    });
    this.logger.log(line);
  }
}
