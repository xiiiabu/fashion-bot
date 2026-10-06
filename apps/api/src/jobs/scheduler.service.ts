/**
 * Scheduled jobs.
 *
 * ORD-005 / CAT-008 Release expired reservations, so stock is never held forever.
 * PAY-011 Run reconciliation daily.
 * PAY-008 Verify that cached balances still equal the sum of entries.
 * NTF-003 Fan out back-in-stock and price-drop notifications.
 * FUL-004 Raise an alert when a seller misses the confirmation SLA.
 * FUL-008 / §15.2 Delete evidence and stale records past their retention date.
 *
 * Every job is guarded by a short lock so two instances do not duplicate work.
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { CacheService } from '../common/cache.service';
import { loadConfig } from '../common/config';
import { logger } from '../common/logger';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReconciliationService } from '../finance/reconciliation.service';
import { LedgerService } from '../finance/ledger.service';
import { ReturnsService } from '../fulfillment/returns.service';
import { PaymentService } from '../payments/payment.service';
import { OrdersService } from '../orders/orders.service';
import { AuthService } from '../identity/auth.service';
import { IdempotencyService } from '../common/idempotency.service';
import { SupportService } from '../support/support.service';
import { AnalyticsService } from '../analytics/analytics.service';

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
    private readonly reconciliation: ReconciliationService,
    private readonly ledger: LedgerService,
    private readonly returns: ReturnsService,
    private readonly payments: PaymentService,
    private readonly orders: OrdersService,
    private readonly auth: AuthService,
    private readonly idempotency: IdempotencyService,
    private readonly support: SupportService,
    private readonly analytics: AnalyticsService,
  ) {}

  async onModuleInit(): Promise<void> {
    logger.info('scheduler started');
  }

  /** CAT-008 / ORD-005: the hot path. Runs often, does little. */
  @Cron(CronExpression.EVERY_MINUTE)
  async releaseExpiredReservations(): Promise<void> {
    await this.withLock('reservations', 50, async () => {
      const result = await this.inventory.releaseExpiredReservations(300);
      if (result.released === 0) return;

      // NTF-003: a release can make a subscribed SKU available again.
      const subscriptions = await this.inventory.findBackInStockSubscriptions(result.skuIds);
      if (subscriptions.length > 0) {
        const notified = await this.notifications.notifyBackInStock(subscriptions as never);
        await this.inventory.markSubscriptionNotified(notified);
      }
    });
  }

  /** A payment session that never completed must not keep stock reserved. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async expirePayments(): Promise<void> {
    await this.withLock('payments-expire', 240, async () => {
      const expired = await this.payments.expireStalePayments();
      if (expired > 0) logger.info({ expired }, 'expired stale payment sessions');
    });
  }

  /** FUL-004: the SLA watchdog. */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async sellerSlaWatch(): Promise<void> {
    await this.withLock('sla-watch', 1500, async () => {
      const overdue = await this.orders.overdueConfirmations(100);
      for (const subOrder of overdue) {
        await this.support.raiseAlert({
          code: 'SELLER_CONFIRMATION_OVERDUE',
          severity: 'WARNING',
          title: `${subOrder.seller.displayName} has not confirmed ${subOrder.number}`,
          description: `Order ${subOrder.order.number} passed its confirmation SLA.`,
          objectType: 'SubOrder',
          objectId: subOrder.id,
          context: { sellerId: subOrder.sellerId, dueAt: subOrder.confirmDueAt?.toISOString() },
        });
      }
    });
  }

  /** NTF-003: price drops are checked on a slower cadence than stock. */
  @Cron(CronExpression.EVERY_HOUR)
  async priceDropNotifications(): Promise<void> {
    await this.withLock('price-drops', 3000, async () => {
      const sent = await this.notifications.notifyPriceDrops();
      if (sent > 0) logger.info({ sent }, 'queued price-drop notifications');
    });
  }

  /** CAT-006: an expired promotion must switch itself off. */
  @Cron(CronExpression.EVERY_HOUR)
  async expirePromotions(): Promise<void> {
    await this.withLock('promotions', 3000, async () => {
      const result = await this.prisma.promotion.updateMany({
        where: { isActive: true, endsAt: { lt: new Date() } },
        data: { isActive: false },
      });
      if (result.count > 0) logger.info({ count: result.count }, 'deactivated expired promotions');
    });
  }

  /** PAY-011: the daily reconciliation run, just after midnight Tashkent. */
  @Cron('11 19 * * *')
  async dailyReconciliation(): Promise<void> {
    await this.withLock('reconciliation', 3600, async () => {
      // UTC 19:11 is 00:11 in Asia/Tashkent (UTC+5, no DST), so the run covers
      // the day that has just closed locally.
      const yesterday = new Date(Date.now() - 86_400_000);
      const summaries = await this.reconciliation.runDaily(yesterday);
      logger.info({ summaries }, 'daily reconciliation complete');
    });
  }

  /** PAY-008: prove the ledger is still self-consistent. */
  @Cron('41 20 * * *')
  async ledgerIntegrity(): Promise<void> {
    await this.withLock('ledger-integrity', 3600, async () => {
      const result = await this.ledger.recomputeAccountBalances();
      if (result.corrected > 0) {
        await this.support.raiseAlert({
          code: 'LEDGER_BALANCE_DRIFT',
          severity: 'CRITICAL',
          title: `${result.corrected} ledger account balance(s) drifted from the entry sum`,
          description: 'Cached balances were corrected from the entries. Investigate the cause.',
          context: { drifts: result.drifts },
        });
      }
      const check = await this.reconciliation.verifyLedgerAgainstOrders();
      if (!check.ok) {
        logger.warn(check, 'order commission total differs from the ledger');
      }
    });
  }

  /** SEL-010: recompute seller quality scores from operational metrics. */
  @Cron('23 21 * * *')
  async sellerQualityScores(): Promise<void> {
    await this.withLock('quality-scores', 3600, async () => {
      const sellers = await this.prisma.seller.findMany({
        where: { onboardingStatus: 'ACTIVE' },
        select: { id: true },
      });
      for (const seller of sellers) {
        await this.analytics.computeSellerQuality(seller.id).catch(() => undefined);
      }
      logger.info({ sellers: sellers.length }, 'recomputed seller quality scores');
    });
  }

  /** FUL-008 and §15.2 retention. */
  @Cron('7 22 * * *')
  async retentionSweep(): Promise<void> {
    await this.withLock('retention', 3600, async () => {
      const [evidence, sessions, idempotency, analytics] = await Promise.all([
        this.returns.purgeExpiredEvidence(),
        this.auth.purgeExpiredSessions(),
        this.idempotency.purgeExpired(),
        // Raw events are only needed for recent analysis; aggregates persist.
        this.prisma.analyticsEvent.deleteMany({
          where: { occurredAt: { lt: new Date(Date.now() - 400 * 86_400_000) } },
        }),
      ]);
      logger.info(
        { evidence, sessions, idempotency, analyticsEvents: analytics.count },
        'retention sweep complete',
      );
    });
  }

  /** ADM-009: surface stale stock feeds so someone owns the problem. */
  @Cron('17 7 * * *')
  async staleStockAlert(): Promise<void> {
    await this.withLock('stale-stock', 3600, async () => {
      const stale = await this.inventory.staleStock(72, 50);
      if (stale.length === 0) return;
      await this.support.raiseAlert({
        code: 'STALE_STOCK_FEED',
        severity: 'WARNING',
        title: `${stale.length} SKU(s) have not had a stock update in 72 hours`,
        description: 'Stock may be out of date, which risks overselling and cancellations.',
        context: { skuIds: stale.slice(0, 20).map((row) => row.skuId) },
      });
    });
  }

  /** NFR-012: an export link should not live forever. */
  @Cron(CronExpression.EVERY_6_HOURS)
  async expireExports(): Promise<void> {
    await this.withLock('exports', 3000, async () => {
      await this.prisma.exportJob.updateMany({
        where: { status: 'COMPLETED', expiresAt: { lt: new Date() } },
        data: { status: 'EXPIRED', fileUrl: null },
      });
    });
  }

  /**
   * Payments are not live in this release, so this job only reports what a
   * live deployment would have paid out. It never creates a batch on its own:
   * PAY-012 requires maker/checker, and a cron is neither.
   */
  @Cron('29 6 * * 1')
  async payoutReminder(): Promise<void> {
    await this.withLock('payout-reminder', 3600, async () => {
      const due = await this.prisma.seller.count({ where: { onboardingStatus: 'ACTIVE' } });
      if (due === 0) return;
      logger.info({ sellers: due }, 'weekly payout window reached — batches await a finance operator');
    });
  }

  private async withLock(name: string, ttlSeconds: number, work: () => Promise<void>): Promise<void> {
    const key = `job:${name}`;
    const acquired = await this.cache.acquireLock(key, ttlSeconds);
    if (!acquired) return;
    const startedAt = Date.now();
    try {
      await work();
    } catch (error) {
      logger.error({ err: error, job: name }, 'scheduled job failed');
    } finally {
      // Hold the lock for its TTL so a crash cannot cause a tight retry loop,
      // but release early for quick jobs so the next tick is not skipped.
      if (Date.now() - startedAt < ttlSeconds * 250) await this.cache.releaseLock(key);
    }
  }

  /** Exposed so the e2e harness can run a job deterministically. */
  async runNow(
    job: 'reservations' | 'reconciliation' | 'ledger' | 'retention' | 'notifications' | 'quality',
  ): Promise<unknown> {
    switch (job) {
      case 'reservations':
        return this.inventory.releaseExpiredReservations(1000);
      case 'reconciliation':
        return this.reconciliation.runDaily(new Date());
      case 'ledger':
        return this.ledger.recomputeAccountBalances();
      case 'retention':
        return {
          evidence: await this.returns.purgeExpiredEvidence(),
          sessions: await this.auth.purgeExpiredSessions(),
        };
      case 'notifications':
        return { priceDrops: await this.notifications.notifyPriceDrops() };
      case 'quality': {
        const sellers = await this.prisma.seller.findMany({ select: { id: true } });
        const results = [];
        for (const seller of sellers) {
          results.push(await this.analytics.computeSellerQuality(seller.id));
        }
        return results;
      }
      default:
        return null;
    }
  }

  get timezone(): string {
    return this.config.TIMEZONE;
  }
}
