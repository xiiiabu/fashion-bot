/**
 * Idempotency — spec ORD-006 and §14.3: "Mutation endpoints с финансовым/
 * операционным эффектом принимают idempotency key", and a retry must not
 * create a duplicate.
 *
 * Postgres is the store, not Redis: a replayed payment callback after a
 * restart must still be recognised (PAY-004).
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { AppError } from './errors';
import { requestHash } from './crypto';
import { logger } from './logger';

const DEFAULT_TTL_HOURS = 48;

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` at most once per (scope, key).
   *
   *  - first call           -> executes and stores the response
   *  - retry, same body     -> replays the stored response
   *  - retry, different body-> IDEMPOTENCY_CONFLICT (the client has a bug)
   *  - retry while running  -> CONFLICT, so the caller backs off
   */
  async run<T>(
    options: {
      key: string | null | undefined;
      scope: string;
      body: unknown;
      userId?: string | null;
      ttlHours?: number;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    const { key, scope, body } = options;
    if (!key || key.trim() === '') {
      // The key is optional for callers that genuinely cannot retry safely
      // (e.g. an internal job); the endpoints that require it validate first.
      return work();
    }

    const hash = requestHash({ scope, body });
    const expiresAt = new Date(Date.now() + (options.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000);
    const compositeKey = `${scope}:${key}`;

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          key: compositeKey,
          scope,
          requestHash: hash,
          status: 'IN_PROGRESS',
          userId: options.userId ?? null,
          expiresAt,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.prisma.idempotencyRecord.findUnique({ where: { key: compositeKey } });
      if (!existing) throw error;

      if (existing.requestHash !== hash) {
        throw new AppError('IDEMPOTENCY_CONFLICT', {
          message: 'This idempotency key was already used with a different request body',
          details: { key, scope },
        });
      }

      if (existing.status === 'COMPLETED') {
        logger.info({ scope, key }, 'replaying idempotent response');
        return existing.response as T;
      }

      if (existing.status === 'FAILED') {
        // A previous attempt failed cleanly; let the caller try again.
        await this.prisma.idempotencyRecord.update({
          where: { key: compositeKey },
          data: { status: 'IN_PROGRESS', expiresAt },
        });
      } else {
        throw AppError.conflict('CONFLICT', 'A request with this idempotency key is still in flight', {
          key,
          scope,
        });
      }
    }

    try {
      const result = await work();
      await this.prisma.idempotencyRecord.update({
        where: { key: compositeKey },
        data: {
          status: 'COMPLETED',
          response: serializable(result) as Prisma.InputJsonValue,
          statusCode: 200,
        },
      });
      return result;
    } catch (error) {
      await this.prisma.idempotencyRecord
        .update({ where: { key: compositeKey }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      throw error;
    }
  }

  /** Requires the header and rejects the request if it is missing. */
  requireKey(key: string | null | undefined, endpoint: string): string {
    if (!key || key.trim().length < 8) {
      throw AppError.validation(`${endpoint} requires an Idempotency-Key header (min 8 chars)`, {
        header: 'Idempotency-Key',
      });
    }
    return key.trim();
  }

  /** Housekeeping: expired records carry no meaning. */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

function serializable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry)),
  );
}
