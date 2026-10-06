/**
 * Logging — spec NFR-010 (central logs with a correlation id) and §14.3
 * ("PII маскируется в logs/traces; secrets никогда не передаются frontend").
 *
 * The redaction list is deliberately broad: it is cheaper to redact a field
 * that turned out to be harmless than to discover a phone number in a log.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { LoggerService } from '@nestjs/common';

export interface RequestContext {
  correlationId: string;
  userId?: string;
  adminUserId?: string;
  sellerId?: string;
  route?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-telegram-init-data"]',
  'initData',
  'password',
  'passwordHash',
  'mfaSecret',
  'token',
  'refreshToken',
  'accessToken',
  'tokenHash',
  'secret',
  'secretKey',
  'apiKey',
  'phone',
  'contactPhone',
  'recipientName',
  'street',
  'building',
  'apartment',
  'accountNumber',
  'accountNumberMasked',
  'cardMask',
  'pan',
  'cvv',
  '*.password',
  '*.phone',
  '*.mfaSecret',
  '*.tokenHash',
  'user.phone',
  'address.phone',
  'address.street',
  'addressSnapshot',
  'body.phone',
  'body.password',
  'body.initData',
  'body.measurements',
  'measurements',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'fashion-api' },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({ pid: bindings.pid }),
  },
  mixin() {
    const store = requestContext.getStore();
    return store ? { correlationId: store.correlationId, userId: store.userId } : {};
  },
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});

/** Adapter so Nest's internal logs flow through the same pipeline. */
export class NestPinoLogger implements LoggerService {
  log(message: unknown, ...optional: unknown[]): void {
    logger.info({ context: optional[0] }, String(message));
  }

  error(message: unknown, ...optional: unknown[]): void {
    logger.error({ context: optional[1] ?? optional[0] }, String(message));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    logger.warn({ context: optional[0] }, String(message));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    logger.debug({ context: optional[0] }, String(message));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    logger.trace({ context: optional[0] }, String(message));
  }
}

export function currentCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? 'no-context';
}
