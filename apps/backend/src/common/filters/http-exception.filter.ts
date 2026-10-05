import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from '../errors';

interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  path: string;
  timestamp: string;
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_ERROR';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    default:
      return 'HTTP_ERROR';
  }
}

/**
 * Global exception filter. Maps AppError and HttpException (incl. the
 * ValidationPipe output) onto the standard error envelope.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof AppError) {
      statusCode = exception.statusCode;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      code = defaultCodeForStatus(statusCode);
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        code = (b.code as string) ?? code;
        // class-validator ValidationPipe returns message as string[]
        if (Array.isArray(b.message)) {
          message = 'Validation failed';
          code = b.code ? (b.code as string) : 'VALIDATION_ERROR';
          details = b.message;
        } else {
          message = (b.message as string) ?? exception.message;
          details = b.details;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} -> ${statusCode} ${code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const envelope: ErrorEnvelope = {
      statusCode,
      code,
      message,
      details,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    };
    response.status(statusCode).json(envelope);
  }
}
