import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

/**
 * Append-only tables — PAY-008 ("Append-only ledger") and ADM-006 ("audit не
 * редактируется через UI").
 *
 * The guard lives in Postgres rather than in ORM middleware, so it also holds
 * for raw SQL, a psql session and any future service. An admin cannot quietly
 * "fix" a ledger entry; the only correction is a compensating ADJUSTMENT
 * (PAY-017).
 *
 * ProviderEvent gets one narrow exception: marking an event processed is
 * bookkeeping on the receipt, not a rewrite of what the provider sent.
 */
const APPEND_ONLY_TABLES = [
  'LedgerEntry',
  'AuditLog',
  'StockMovement',
  'OrderStatusHistory',
  'ReturnStatusHistory',
  'AnalyticsEvent',
  'FiscalReceipt',
] as const;

/**
 * Postgres will not accept several statements in one prepared statement, so
 * each function is its own call rather than one script.
 */
const APPEND_ONLY_FUNCTION = `
CREATE OR REPLACE FUNCTION fashion_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only (PAY-008 / ADM-006): % is not permitted. Post a compensating entry instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql`;

const PROVIDER_EVENT_FUNCTION = `
CREATE OR REPLACE FUNCTION fashion_provider_event_guard() RETURNS trigger AS $fn$
BEGIN
  -- Only the processing columns may change; the payload and the signature
  -- verdict are the evidence and stay exactly as received.
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."externalEventId" IS DISTINCT FROM OLD."externalEventId"
     OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
     OR NEW."signatureValid" IS DISTINCT FROM OLD."signatureValid"
     OR NEW."payload"::text IS DISTINCT FROM OLD."payload"::text
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION
      'ProviderEvent is append-only apart from its processing columns (PAY-004)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql`;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    // @ts-expect-error -- Prisma's event typings do not narrow the string union
    this.$on('warn', (event: { message: string }) => logger.warn({ prisma: event }, 'prisma warning'));
    // @ts-expect-error -- see above
    this.$on('error', (event: { message: string }) => logger.error({ prisma: event }, 'prisma error'));
    await this.$connect();
    await this.installAppendOnlyGuards();
    logger.info('database connected');
  }

  /**
   * Idempotent: safe to run on every boot, and `prisma db push` recreating a
   * table drops its triggers, so re-asserting them here is deliberate.
   */
  async installAppendOnlyGuards(): Promise<void> {
    try {
      await this.$executeRawUnsafe(APPEND_ONLY_FUNCTION);
      await this.$executeRawUnsafe(PROVIDER_EVENT_FUNCTION);

      for (const table of APPEND_ONLY_TABLES) {
        await this.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS "${table}_append_only" ON "${table}"`,
        );
        await this.$executeRawUnsafe(
          `CREATE TRIGGER "${table}_append_only"
             BEFORE UPDATE OR DELETE ON "${table}"
             FOR EACH ROW EXECUTE FUNCTION fashion_append_only()`,
        );
      }

      await this.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ProviderEvent_append_only" ON "ProviderEvent"');
      await this.$executeRawUnsafe(
        `CREATE TRIGGER "ProviderEvent_append_only"
           BEFORE DELETE ON "ProviderEvent"
           FOR EACH ROW EXECUTE FUNCTION fashion_append_only()`,
      );
      await this.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ProviderEvent_processing_only" ON "ProviderEvent"');
      await this.$executeRawUnsafe(
        `CREATE TRIGGER "ProviderEvent_processing_only"
           BEFORE UPDATE ON "ProviderEvent"
           FOR EACH ROW EXECUTE FUNCTION fashion_provider_event_guard()`,
      );

      logger.info(
        { tables: APPEND_ONLY_TABLES.length + 1 },
        'append-only database guards installed',
      );
    } catch (error) {
      // A read-only replica or a restricted role cannot create triggers. Log
      // loudly rather than refusing to boot: the services never update these
      // tables, the trigger is defence in depth.
      logger.error(
        { err: error },
        'could not install append-only guards — ledger/audit immutability is not enforced at the database level',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Health probe for /health and the readiness gate. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      logger.error({ err: error }, 'database ping failed');
      return false;
    }
  }
}
