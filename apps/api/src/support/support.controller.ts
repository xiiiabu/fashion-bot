/**
 * Buyer-facing support, notifications, analytics intake and the bot's
 * service channel.
 */

import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  ANALYTICS_EVENTS,
  ANALYTICS_TAXONOMY_VERSION,
  type Locale,
  encodeDeepLink,
} from '@fashion/core';
import { SupportService } from './support.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuthService } from '../identity/auth.service';
import { CatalogService } from '../catalog/catalog.service';
import { StylistService } from '../ai/stylist.service';
import { OrdersService } from '../orders/orders.service';
import { OptionalAuth, Public } from '../identity/guards';
import { Actor, CurrentUserId, RateLimit, RequestLocale, zodBody } from '../common/http';
import type { AuthenticatedActor } from '../common/http';
import { AppError } from '../common/errors';
import { loadConfig } from '../common/config';
import { stableStringify } from '../common/crypto';

const ticketSchema = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(3).max(4000),
  category: z.string().max(40).optional(),
  orderId: z.string().uuid().nullable().optional(),
  orderItemId: z.string().uuid().nullable().optional(),
  returnRequestId: z.string().uuid().nullable().optional(),
  paymentId: z.string().uuid().nullable().optional(),
});

const trackSchema = z.object({
  events: z
    .array(
      z.object({
        name: z.string().max(60),
        properties: z.record(z.string(), z.unknown()).optional(),
        anonymousId: z.string().max(64).optional(),
        sessionRef: z.string().max(64).optional(),
        consentState: z.record(z.string(), z.boolean()).optional(),
        source: z.string().max(20).optional(),
      }),
    )
    .min(1)
    .max(50),
});

@Controller()
export class SupportController {
  private readonly config = loadConfig();

  constructor(
    private readonly support: SupportService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly auth: AuthService,
    private readonly catalog: CatalogService,
    private readonly stylist: StylistService,
    private readonly orders: OrdersService,
  ) {}

  // ───────────────────────────────────────────────────────── tickets

  @Get('support/tickets')
  async tickets(@CurrentUserId() userId: string) {
    return { items: await this.support.listTickets(userId) };
  }

  @Get('support/tickets/:id')
  async ticket(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.support.getTicket(userId, id);
  }

  @RateLimit({ max: 20 })
  @Post('support/tickets')
  async createTicket(
    @CurrentUserId() userId: string,
    @Body(zodBody(ticketSchema)) body: z.infer<typeof ticketSchema>,
    @RequestLocale() locale: Locale,
  ) {
    return this.support.createTicket(userId, body, locale);
  }

  @RateLimit({ max: 40 })
  @Post('support/tickets/:id/reply')
  async reply(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body(zodBody(z.object({ body: z.string().min(1).max(4000) }))) body: { body: string },
  ) {
    return this.support.replyAsUser(userId, id, body.body);
  }

  /** FUL-010: self-service that always offers a human. */
  @Public()
  @Get('support/faq')
  faq(@RequestLocale() locale: Locale) {
    return this.support.faq(locale);
  }

  // ─────────────────────────────────────────────────── notifications

  @Get('notifications')
  async notificationList(@CurrentUserId() userId: string) {
    return { items: await this.notifications.listForUser(userId) };
  }

  @Post('notifications/read')
  async markRead(
    @CurrentUserId() userId: string,
    @Body(zodBody(z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }))) body: { ids: string[] },
  ) {
    await this.notifications.markRead(userId, body.ids);
    return { ok: true };
  }

  // ───────────────────────────────────────── analytics intake (ANL-001)

  @OptionalAuth()
  @Public()
  @RateLimit({ max: 300 })
  @Post('events')
  async track(
    @Body(zodBody(trackSchema)) body: z.infer<typeof trackSchema>,
    @Actor() actor: AuthenticatedActor | undefined,
  ) {
    return this.analytics.trackMany(
      body.events.map((event) => ({ ...event, userId: actor?.userId ?? null })),
    );
  }

  @Public()
  @Get('events/taxonomy')
  taxonomy() {
    // ANL-001: the taxonomy is documented and machine-readable.
    return { events: [...ANALYTICS_EVENTS], version: ANALYTICS_TAXONOMY_VERSION };
  }

  // ───────────────────────────────── bot service channel (TG-004/NTF-001)

  /**
   * The bot authenticates with an HMAC over the request body using the bot
   * token, so no user session is involved and the endpoint cannot be driven
   * from a browser.
   */
  @Public()
  @RateLimit({ max: 600 })
  @Post('bot/sync-user')
  async botSyncUser(
    @Body() body: { telegramId: string; firstName?: string; lastName?: string; username?: string; languageCode?: string; chatId?: string },
    @Headers('x-bot-signature') signature: string,
  ) {
    this.assertBotSignature(body, signature);
    const result = await this.auth.upsertFromBot({
      telegramId: BigInt(body.telegramId),
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      username: body.username ?? null,
      languageCode: body.languageCode ?? null,
      chatId: body.chatId ? BigInt(body.chatId) : null,
    });
    return result;
  }

  @Public()
  @RateLimit({ max: 600 })
  @Post('bot/claim-notifications')
  async botClaim(
    @Body() body: { limit?: number },
    @Headers('x-bot-signature') signature: string,
  ) {
    this.assertBotSignature(body, signature);
    const items = await this.notifications.claimQueued(Math.min(body.limit ?? 25, 50));
    return { items };
  }

  @Public()
  @RateLimit({ max: 600 })
  @Post('bot/notification-result')
  async botResult(
    @Body() body: { id: string; sent: boolean; providerMessageId?: string; error?: string; blocked?: boolean },
    @Headers('x-bot-signature') signature: string,
  ) {
    this.assertBotSignature(body, signature);
    if (body.sent) await this.notifications.markSent(body.id, body.providerMessageId);
    // TG-005: a block is terminal and is suppressed; anything else is retried
    // with a backoff until the attempts are used up (NTF-002).
    else await this.notifications.markFailed(body.id, body.error ?? 'send failed', {
      blocked: body.blocked === true,
    });
    return { ok: true };
  }

  /**
   * NTF-002: a sender gives back what it claimed but will not send — on
   * shutdown, or after a rate limit cut a batch short. Without this the rows
   * wait out their lease, which delays an order update on every deploy.
   */
  @Public()
  @RateLimit({ max: 600 })
  @Post('bot/release-notifications')
  async botRelease(
    @Body() body: { ids: string[] },
    @Headers('x-bot-signature') signature: string,
  ) {
    this.assertBotSignature(body, signature);
    const released = await this.notifications.release((body.ids ?? []).slice(0, 100));
    return { released };
  }

  @Public()
  @RateLimit({ max: 600 })
  @Post('bot/blocked')
  async botBlocked(
    @Body() body: { telegramId: string; blocked: boolean },
    @Headers('x-bot-signature') signature: string,
  ) {
    this.assertBotSignature(body, signature);
    await this.auth.markBotBlocked(BigInt(body.telegramId), body.blocked);
    return { ok: true };
  }

  /** What the bot shows in a /start message: live, localised, from the DB. */
  @Public()
  @RateLimit({ max: 600 })
  @Post('bot/context')
  async botContext(
    @Body() body: { telegramId?: string; locale?: Locale },
    @Headers('x-bot-signature') signature: string,
  ) {
    this.assertBotSignature(body, signature);
    const locale = (body.locale ?? 'ru') as Locale;
    const user = body.telegramId
      ? await this.auth.findUserByTelegramId(BigInt(body.telegramId))
      : null;

    const [categories, brands, suggestions, orders] = await Promise.all([
      this.catalog.rootCategories(locale),
      this.catalog.featuredBrands(locale, 6),
      Promise.resolve(this.stylist.suggestions(locale)),
      user ? this.orders.listForUser(user.id, locale, { limit: 3, status: undefined }) : null,
    ]);

    return {
      user: user ? { id: user.id, locale: user.locale } : null,
      categories: categories.slice(0, 8).map((category) => ({
        slug: category.slug,
        name: category.name,
        deepLink: encodeDeepLink({ kind: 'category', slug: category.slug }),
      })),
      brands: brands.map((brand) => ({
        slug: brand.slug,
        name: brand.name,
        deepLink: encodeDeepLink({ kind: 'brand', slug: brand.slug }),
      })),
      stylistSuggestions: suggestions,
      recentOrders:
        orders?.items.map((order) => ({
          number: order.number,
          status: order.status,
          deepLink: encodeDeepLink({ kind: 'order', id: order.id }),
        })) ?? [],
      faq: this.support.faq(locale),
      miniAppUrl: this.config.TELEGRAM_MINIAPP_URL || null,
    };
  }

  private assertBotSignature(body: unknown, signature: string | undefined): void {
    if (!signature) throw AppError.unauthenticated('Missing bot signature');
    const payload = stableStringify(body ?? {});
    if (!this.auth.verifyServiceSignature(payload, signature)) {
      throw AppError.unauthenticated('Invalid bot signature');
    }
  }
}


