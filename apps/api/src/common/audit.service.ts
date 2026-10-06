/**
 * Audit trail — spec ADM-006: "actor, timestamp, before/after, reason,
 * session/IP, correlation ID", and "audit не редактируется через UI"
 * (enforced by the append-only guard in PrismaService).
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { logger } from './logger';
import type { AuthenticatedActor } from './http';

export interface AuditInput {
  readonly action: string;
  readonly objectType: string;
  readonly objectId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly severity?: 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';
  readonly correlationId?: string | null;
  readonly sessionId?: string | null;
  readonly ipHash?: string | null;
  readonly userAgent?: string | null;
}

/** Fields that must never be written into the audit payload (§14.3, ADM-007). */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'mfaSecret',
  'tokenHash',
  'refreshTokenHash',
  'secret',
  'secretKey',
  'apiKey',
  'cvv',
  'pan',
  'cardNumber',
]);

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(actor: AuthenticatedActor | null | undefined, input: AuditInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorType: actor?.kind?.toUpperCase() ?? 'SYSTEM',
          actorId:
            actor?.adminUserId ?? actor?.sellerUserId ?? actor?.userId ?? null,
          actorEmail: actor?.email ?? null,
          action: input.action,
          objectType: input.objectType,
          objectId: input.objectId ?? null,
          before: sanitize(input.before),
          after: sanitize(input.after),
          reason: input.reason ?? null,
          sessionId: input.sessionId ?? actor?.sessionId ?? null,
          ipHash: input.ipHash ?? null,
          userAgent: input.userAgent ?? null,
          correlationId: input.correlationId ?? null,
          severity: input.severity ?? 'INFO',
        },
      });
    } catch (error) {
      // An audit write must never take down the business action, but losing one
      // is itself notable, so it is logged at error level.
      logger.error({ err: error, action: input.action }, 'failed to write audit log');
    }
  }

  /** Convenience for the common "field changed" case. */
  async recordChange(
    actor: AuthenticatedActor | null | undefined,
    objectType: string,
    objectId: string,
    action: string,
    before: unknown,
    after: unknown,
    options: { reason?: string; correlationId?: string; severity?: AuditInput['severity'] } = {},
  ): Promise<void> {
    await this.record(actor, {
      action,
      objectType,
      objectId,
      before,
      after,
      reason: options.reason,
      correlationId: options.correlationId,
      severity: options.severity,
    });
  }

  /**
   * ADM-007: reading an unmasked phone or address is itself an event, so
   * support access can be reviewed later.
   */
  async recordPiiAccess(
    actor: AuthenticatedActor,
    objectType: string,
    objectId: string,
    fields: string[],
    correlationId?: string,
  ): Promise<void> {
    await this.record(actor, {
      action: 'pii.read',
      objectType,
      objectId,
      after: { fields },
      severity: 'NOTICE',
      correlationId,
    });
  }
}

function sanitize(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return walk(value) as Prisma.InputJsonValue;
}

function walk(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => walk(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = walk(entry, depth + 1);
    }
    return out;
  }
  return value;
}
