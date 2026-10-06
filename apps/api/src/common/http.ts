/**
 * Request plumbing: correlation ids, locale resolution, validation,
 * BigInt-safe serialisation, rate limiting and the request-scoped actor.
 */

import {
  type ArgumentsHost,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type NestMiddleware,
  type PipeTransform,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { type Locale, resolveLocale } from '@fashion/core';
import { AppError } from './errors';
import { CacheService } from './cache.service';
import { loadConfig } from './config';
import { requestContext } from './logger';
import { hashIp, uuid } from './crypto';

export interface AuthenticatedActor {
  readonly kind: 'user' | 'admin' | 'seller' | 'service' | 'anonymous';
  readonly userId?: string;
  readonly adminUserId?: string;
  readonly sellerUserId?: string;
  readonly sellerId?: string;
  readonly sessionId?: string;
  readonly roles: string[];
  readonly permissions: Set<string>;
  readonly mfaVerified?: boolean;
  readonly email?: string;
}

export interface AppRequest extends Request {
  correlationId: string;
  locale: Locale;
  actor?: AuthenticatedActor;
  ipHash: string | null;
  rawBodyText?: string;
}

/** §14.3 / NFR-010: one id from the Telegram client through to the PSP call. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const request = req as AppRequest;
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : uuid();
    request.correlationId = correlationId;
    request.locale = resolveLocale(
      req.header('x-locale') ?? req.header('accept-language')?.split(',')[0] ?? null,
    );
    request.ipHash = hashIp(
      (req.header('x-forwarded-for')?.split(',')[0] ?? req.ip ?? '').trim(),
      loadConfig().SESSION_JWT_SECRET,
    );
    res.setHeader('x-correlation-id', correlationId);
    requestContext.run({ correlationId, route: `${req.method} ${req.path}` }, () => next());
  }
}

/**
 * Zod validation pipe. Produces one shaped VALIDATION_FAILED error with the
 * field paths, which is what the Mini App needs to highlight inputs.
 */
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    try {
      return this.schema.parse(value) as z.infer<S>;
    } catch (error) {
      if (error instanceof ZodError) {
        throw AppError.validation('Request validation failed', {
          fields: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        });
      }
      throw error;
    }
  }
}

export function zodBody<S extends ZodTypeAny>(schema: S): ZodValidationPipe<S> {
  return new ZodValidationPipe(schema);
}

/**
 * BigInt is not JSON-serialisable and every money column is BigInt (CAT-005).
 * Mappers normally convert to a `Money` object; this interceptor is the
 * safety net so a forgotten field becomes a string instead of a 500.
 */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => normalize(value)));
  }
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [k, normalize(v)]));
    if (value instanceof Set) return [...value].map(normalize);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

// ─────────────────────────────────────────────────── rate limiting (SEC-006)

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  readonly max?: number;
  readonly windowMs?: number;
  /** 'ai' and 'auth' get their own, tighter budgets. */
  readonly bucket?: 'default' | 'ai' | 'auth' | 'checkout' | 'webhook';
}

export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = loadConfig();
    const options =
      this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? {};

    const request = context.switchToHttp().getRequest<AppRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const bucket = options.bucket ?? 'default';
    const max =
      options.max ??
      (bucket === 'ai'
        ? config.RATE_LIMIT_AI_MAX
        : bucket === 'auth'
          ? config.RATE_LIMIT_AUTH_MAX
          : config.RATE_LIMIT_MAX);
    const windowMs = options.windowMs ?? config.RATE_LIMIT_WINDOW_MS;

    const identity =
      request.actor?.userId ??
      request.actor?.adminUserId ??
      request.actor?.sellerUserId ??
      request.ipHash ??
      'anonymous';
    const key = `rl:${bucket}:${context.getClass().name}.${context.getHandler().name}:${identity}`;

    const { count, resetAt } = await this.cache.increment(key, windowMs);
    response.setHeader('x-ratelimit-limit', String(max));
    response.setHeader('x-ratelimit-remaining', String(Math.max(0, max - count)));
    response.setHeader('x-ratelimit-reset', String(Math.ceil(resetAt / 1000)));

    if (count > max) {
      throw new AppError('RATE_LIMITED', {
        message: 'Too many requests',
        details: { retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) },
      });
    }
    return true;
  }
}

// ──────────────────────────────────────────────────────────── decorators

export const Actor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AppRequest>();
  return request.actor;
});

export const CurrentUserId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AppRequest>();
  if (!request.actor?.userId) throw AppError.unauthenticated();
  return request.actor.userId;
});

export const RequestLocale = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AppRequest>();
  return request.locale ?? 'ru';
});

export const CorrelationId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AppRequest>();
  return request.correlationId;
});

export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AppRequest>();
  return request.header('idempotency-key') ?? null;
});

export function hostOf(host: ArgumentsHost): AppRequest {
  return host.switchToHttp().getRequest<AppRequest>();
}

/** Cursor pagination helpers (§14.3). */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, string | number>>(cursor: string | null | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
