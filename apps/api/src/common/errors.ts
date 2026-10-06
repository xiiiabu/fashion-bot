/**
 * Error contract — spec §14.3: "Error содержит stable code, localized message и
 * correlation ID; stack не раскрывается."
 */

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IllegalTransitionError, type ErrorCode, type Locale, translate } from '@fashion/core';
import { logger } from './logger';

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  OUT_OF_STOCK: HttpStatus.CONFLICT,
  RESERVATION_EXPIRED: HttpStatus.CONFLICT,
  QUOTE_EXPIRED: HttpStatus.CONFLICT,
  ILLEGAL_STATE_TRANSITION: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  AMOUNT_MISMATCH: HttpStatus.CONFLICT,
  CONSENT_REQUIRED: HttpStatus.FORBIDDEN,
  FEATURE_DISABLED: HttpStatus.SERVICE_UNAVAILABLE,
  PAYMENT_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

export class AppError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(
    code: ErrorCode | string,
    options: {
      message?: string;
      status?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(options.message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code] ?? HttpStatus.BAD_REQUEST;
    this.details = options.details;
    this.expose = this.status < 500;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  static notFound(what: string, id?: string): AppError {
    return new AppError('NOT_FOUND', {
      message: `${what} not found`,
      details: id ? { id, resource: what } : { resource: what },
    });
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('VALIDATION_FAILED', { message, details });
  }

  static forbidden(message = 'Not allowed', details?: Record<string, unknown>): AppError {
    return new AppError('FORBIDDEN', { message, details });
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHENTICATED', { message });
  }

  static conflict(code: ErrorCode | string, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(code, { message, details, status: HttpStatus.CONFLICT });
  }
}

interface RequestWithContext extends Request {
  correlationId?: string;
  locale?: Locale;
}

@Injectable()
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<Response>();
    const correlationId = request.correlationId ?? 'unknown';
    const locale: Locale = request.locale ?? 'ru';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = 'INTERNAL';
    let details: Record<string, unknown> | undefined;
    let allowedTransitions: string[] | undefined;
    let internalMessage = 'Unhandled exception';

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      details = exception.details;
      internalMessage = exception.message;
    } else if (exception instanceof IllegalTransitionError) {
      status = HttpStatus.CONFLICT;
      code = exception.code;
      allowedTransitions = [...exception.allowed];
      details = { machine: exception.machine, from: exception.from, to: exception.to };
      internalMessage = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      internalMessage = exception.message;
      code =
        typeof payload === 'object' && payload !== null && 'code' in payload
          ? String((payload as Record<string, unknown>).code)
          : mapStatusToCode(status);
      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;
        if (record.details && typeof record.details === 'object') {
          details = record.details as Record<string, unknown>;
        }
      }
    } else if (exception instanceof Error) {
      internalMessage = exception.message;
      // Prisma surfaces unique/foreign-key violations with a code field.
      const prismaCode = (exception as { code?: string }).code;
      if (prismaCode === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'CONFLICT';
        details = { constraint: (exception as { meta?: unknown }).meta };
      } else if (prismaCode === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
      }
    }

    const logPayload = {
      correlationId,
      code,
      status,
      method: request.method,
      path: request.originalUrl ?? request.url,
      err: exception instanceof Error ? { message: exception.message, stack: exception.stack } : exception,
    };
    if (status >= 500) logger.error(logPayload, 'request failed');
    else logger.warn({ ...logPayload, err: undefined, message: internalMessage }, 'request rejected');

    // §14.3: stack traces never reach the client.
    response.status(status).json({
      error: {
        code,
        message: translate(locale, `error.${code}`),
        correlationId,
        ...(details ? { details } : {}),
        ...(allowedTransitions ? { allowedTransitions } : {}),
      },
    });
  }
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED';
  }
}
