/**
 * Notifications — spec §12.
 *
 * NTF-001 Telegram service notifications for payment, confirmation, shipment,
 *         delivery, return and refund, each with a deep link and minimal PII.
 * NTF-002 Marketing only with consent and under a frequency cap; opt-out takes
 *         effect immediately (UAT-22).
 * NTF-003 Back-in-stock and price-drop subscriptions, deduplicated/throttled.
 *
 * Delivery is decoupled: rows are queued here and the bot (or a worker) drains
 * them, so a Telegram outage never fails a payment.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type NotificationKind, type Locale as PrismaLocale } from '@prisma/client';
import { type Locale, encodeDeepLink, translate } from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { logger } from '../common/logger';
import { sha256 } from '../common/crypto';

/** NTF-002: at most this many marketing messages per user per window. */
const MARKETING_CAP = 3;
const MARKETING_WINDOW_DAYS = 7;

export interface QueueOptions {
  readonly kind?: NotificationKind;
  readonly locale?: Locale;
  readonly deepLink?: string | null;
  readonly dedupeKey?: string | null;
  readonly params?: Record<string, string | number>;
}

@Injectable()
export class NotificationsService {
  private readonly config = loadConfig();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * NTF-001: a service notification. Service messages are transactional and
   * are not gated on marketing consent, but they still carry minimal PII —
   * the order number and a deep link, never an address or a phone.
   */
  async sendOrderNotification(
    userId: string,
    templateKey: string,
    input: { orderNumber: string; orderId: string; locale?: Locale; extra?: Record<string, string> },
  ): Promise<{ id: string; status: string } | null> {
    return this.queue(userId, templateKey, {
      kind: 'SERVICE',
      locale: input.locale,
      deepLink: encodeDeepLink({ kind: 'order', id: input.orderId }),
      dedupeKey: `${templateKey}:${input.orderId}`,
      params: { orderNumber: input.orderNumber, ...(input.extra ?? {}) },
    });
  }

  async queue(
    userId: string,
    templateKey: string,
    options: QueueOptions = {},
  ): Promise<{ id: string; status: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        locale: true,
        deletedAt: true,
        isBlocked: true,
        telegramIdentity: { select: { botBlocked: true, chatId: true, telegramId: true } },
      },
    });
    if (!user || user.deletedAt || user.isBlocked) return null;

    const kind = options.kind ?? 'SERVICE';
    const locale = options.locale ?? (user.locale as Locale);

    // NTF-002 / UAT-22: no marketing without a live consent row.
    if (kind !== 'SERVICE') {
      const allowed = await this.marketingAllowed(userId, kind);
      if (!allowed.allowed) {
        logger.debug({ userId, templateKey, reason: allowed.reason }, 'marketing notification suppressed');
        await this.prisma.notification
          .create({
            data: {
              userId,
              kind,
              templateKey,
              locale: locale as PrismaLocale,
              status: 'SUPPRESSED',
              error: allowed.reason,
              payload: (options.params ?? {}) as Prisma.InputJsonValue,
              dedupeKey: options.dedupeKey ? sha256(`${userId}:${options.dedupeKey}`) : null,
            },
          })
          .catch(() => undefined);
        return null;
      }
    }

    // NTF-003: dedupe so a flapping stock feed cannot spam one shopper.
    const dedupeKey = options.dedupeKey ? sha256(`${userId}:${options.dedupeKey}`) : null;

    try {
      const notification = await this.prisma.notification.create({
        data: {
          userId,
          channel: 'TELEGRAM',
          kind,
          templateKey,
          locale: locale as PrismaLocale,
          payload: (options.params ?? {}) as Prisma.InputJsonValue,
          deepLink: options.deepLink ?? null,
          dedupeKey,
          status: user.telegramIdentity?.botBlocked ? 'SUPPRESSED' : 'QUEUED',
          error: user.telegramIdentity?.botBlocked ? 'bot_blocked' : null,
        },
      });
      return { id: notification.id, status: notification.status };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        logger.debug({ userId, templateKey }, 'duplicate notification suppressed');
        return null;
      }
      throw error;
    }
  }

  private async marketingAllowed(
    userId: string,
    kind: NotificationKind,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const scope = kind === 'MARKETING' ? 'MARKETING' : 'MARKETING';
    const consent = await this.prisma.consent.findFirst({
      where: { userId, scope, granted: true, revokedAt: null },
      orderBy: { grantedAt: 'desc' },
      select: { id: true },
    });

    // Back-in-stock and price-drop are shopper-initiated subscriptions, so
    // they do not need marketing consent — the subscription itself is the
    // consent. Pure marketing does.
    if (kind === 'MARKETING' && !consent) {
      return { allowed: false, reason: 'no_marketing_consent' };
    }

    if (kind === 'MARKETING') {
      const since = new Date(Date.now() - MARKETING_WINDOW_DAYS * 86_400_000);
      const sent = await this.prisma.notification.count({
        where: { userId, kind: 'MARKETING', status: { in: ['SENT', 'READ'] }, createdAt: { gte: since } },
      });
      if (sent >= MARKETING_CAP) {
        return { allowed: false, reason: 'frequency_cap' };
      }
    }
    return { allowed: true };
  }

  /** The bot drains this. Returns rendered text so the sender stays dumb. */
  async claimQueued(limit = 25): Promise<
    Array<{
      id: string;
      telegramId: string;
      chatId: string | null;
      text: string;
      locale: Locale;
      deepLink: string | null;
      miniAppUrl: string | null;
      kind: NotificationKind;
    }>
  > {
    const rows = await this.prisma.notification.findMany({
      where: { status: 'QUEUED', channel: 'TELEGRAM' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { user: { include: { telegramIdentity: true } } },
    });

    const out: Awaited<ReturnType<NotificationsService['claimQueued']>> = [];
    for (const row of rows) {
      const identity = row.user.telegramIdentity;
      if (!identity) {
        await this.markFailed(row.id, 'no_telegram_identity');
        continue;
      }
      if (identity.botBlocked) {
        await this.prisma.notification.update({
          where: { id: row.id },
          data: { status: 'SUPPRESSED', error: 'bot_blocked' },
        });
        continue;
      }

      const params = (row.payload as Record<string, string | number>) ?? {};
      const locale = row.locale as Locale;
      out.push({
        id: row.id,
        telegramId: identity.telegramId.toString(),
        chatId: identity.chatId?.toString() ?? null,
        text: translate(locale, row.templateKey, params),
        locale,
        deepLink: row.deepLink,
        miniAppUrl: this.miniAppUrl(row.deepLink),
        kind: row.kind,
      });
    }
    return out;
  }

  private miniAppUrl(deepLink: string | null): string | null {
    if (!this.config.TELEGRAM_MINIAPP_URL) return null;
    const base = this.config.TELEGRAM_MINIAPP_URL;
    return deepLink ? `${base}${base.includes('?') ? '&' : '?'}startapp=${deepLink}` : base;
  }

  async markSent(id: string, providerMessageId?: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date(), providerMessageId: providerMessageId ?? null },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { status: 'FAILED', error: error.slice(0, 500) },
    });
  }

  /** NTF-003: fan out the back-in-stock alerts for SKUs that just restocked. */
  async notifyBackInStock(
    subscriptions: Array<{
      id: string;
      userId: string;
      skuId: string;
      sku: { product: { id: string; titleRu: string; titleUz: string; titleEn: string | null } };
      user: { locale: string };
    }>,
  ): Promise<string[]> {
    const notified: string[] = [];
    for (const subscription of subscriptions) {
      const locale = subscription.user.locale as Locale;
      const title =
        locale === 'uz'
          ? subscription.sku.product.titleUz
          : locale === 'en'
            ? (subscription.sku.product.titleEn ?? subscription.sku.product.titleRu)
            : subscription.sku.product.titleRu;

      const queued = await this.queue(subscription.userId, 'notify.back_in_stock', {
        kind: 'BACK_IN_STOCK',
        locale,
        deepLink: encodeDeepLink({ kind: 'product', id: subscription.sku.product.id }),
        dedupeKey: `back_in_stock:${subscription.skuId}:${weekStamp()}`,
        params: { title },
      });
      if (queued) notified.push(subscription.id);
    }
    return notified;
  }

  /** NTF-003: price-drop alerts for subscribers whose threshold was met. */
  async notifyPriceDrops(): Promise<number> {
    const subscriptions = await this.prisma.stockSubscription.findMany({
      where: { wantsPriceDrop: true, notifiedAt: null },
      include: {
        sku: {
          include: {
            product: { select: { id: true, titleRu: true, titleUz: true, titleEn: true, lifecycle: true } },
          },
        },
        user: { select: { id: true, locale: true } },
      },
      take: 200,
    });

    let sent = 0;
    for (const subscription of subscriptions) {
      if (subscription.sku.product.lifecycle !== 'PUBLISHED') continue;
      const threshold = subscription.priceThresholdMinor;
      const dropped =
        threshold != null
          ? subscription.sku.priceMinor <= threshold
          : subscription.sku.compareAtMinor != null &&
            subscription.sku.priceMinor < subscription.sku.compareAtMinor;
      if (!dropped) continue;

      const locale = subscription.user.locale as Locale;
      const title =
        locale === 'uz'
          ? subscription.sku.product.titleUz
          : locale === 'en'
            ? (subscription.sku.product.titleEn ?? subscription.sku.product.titleRu)
            : subscription.sku.product.titleRu;

      const queued = await this.queue(subscription.user.id, 'notify.price_drop', {
        kind: 'PRICE_DROP',
        locale,
        deepLink: encodeDeepLink({ kind: 'product', id: subscription.sku.product.id }),
        dedupeKey: `price_drop:${subscription.skuId}:${weekStamp()}`,
        params: { title },
      });
      if (queued) {
        await this.prisma.stockSubscription.update({
          where: { id: subscription.id },
          data: { notifiedAt: new Date() },
        });
        sent += 1;
      }
    }
    return sent;
  }

  async listForUser(userId: string, limit = 30) {
    const rows = await this.prisma.notification.findMany({
      where: { userId, status: { in: ['SENT', 'READ', 'QUEUED'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      text: translate(row.locale as Locale, row.templateKey, (row.payload as Record<string, string>) ?? {}),
      deepLink: row.deepLink,
      read: row.readAt != null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async markRead(userId: string, ids: string[]): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, id: { in: ids }, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** Used by the admin panel to see what went out and what was suppressed. */
  async adminList(options: { kind?: NotificationKind; status?: string; limit?: number }) {
    return this.prisma.notification.findMany({
      where: {
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.status ? { status: options.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
      include: { user: { select: { id: true, firstName: true } } },
    });
  }
}

/** Week bucket so a dedupe key allows one message per week per SKU. */
function weekStamp(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const week = Math.floor((now.getTime() - start.getTime()) / (7 * 86_400_000));
  return `${now.getUTCFullYear()}w${week}`;
}
