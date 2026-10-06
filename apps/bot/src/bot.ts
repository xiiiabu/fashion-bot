/**
 * The Telegram bot — spec §7.2, TG-002 (deep links), TG-004 (notifications),
 * TG-005 (a blocked bot stops sending) and USR-001 (RU/UZ/EN).
 *
 * What it is deliberately not: a shop. Everything transactional — browsing,
 * the stylist, the cart, checkout — happens in the Mini App, because that is
 * where a session, a price and a stock hold can be shown honestly. The bot's
 * job is to open that app at the right place, and to tell the shopper when
 * something about their order changed.
 *
 * Every button that opens the shop is a `web_app` button carrying a deep link,
 * so a tap lands on the product or the order it names rather than on the home
 * screen (TG-002).
 */

import { Bot, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LABELS,
  type Locale,
  encodeDeepLink,
  decodeDeepLink,
  deepLinkToRoute,
  resolveLocale,
  translate,
} from '@fashion/core';
import type { ApiClient, BotContext } from './api';
import type { BotConfig } from './config';
import { escapeHtml, t } from './copy';
import { logger } from './logger';

/** Per-chat state the bot needs between messages. Small and ephemeral. */
interface ChatState {
  locale: Locale;
  /** Set while the shopper is composing a message for support. */
  awaitingSupport: boolean;
  lastSeen: number;
}

export class FashionBot {
  readonly bot: Bot;

  private readonly state = new Map<number, ChatState>();
  private contextCache: { value: BotContext; at: number } | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly api: ApiClient,
  ) {
    this.bot = new Bot(config.token);
    this.register();
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  private register(): void {
    this.bot.catch((error) => {
      const { ctx } = error;
      if (error.error instanceof GrammyError) {
        logger.error(
          { chatId: ctx.chat?.id, description: error.error.description },
          'telegram rejected a request',
        );
      } else if (error.error instanceof HttpError) {
        logger.error({ chatId: ctx.chat?.id }, 'could not reach telegram');
      } else {
        logger.error({ chatId: ctx.chat?.id, err: String(error.error) }, 'bot handler failed');
      }
    });

    this.bot.command('start', (ctx) => this.onStart(ctx));
    this.bot.command(['shop', 'catalog'], (ctx) => this.onCatalog(ctx));
    this.bot.command('stylist', (ctx) => this.onStylist(ctx));
    this.bot.command('orders', (ctx) => this.onOrders(ctx));
    this.bot.command('brands', (ctx) => this.onBrands(ctx));
    this.bot.command('help', (ctx) => this.onHelp(ctx));
    this.bot.command('language', (ctx) => this.onLanguage(ctx));
    this.bot.command('stop', (ctx) => this.onStop(ctx));

    this.bot.on('callback_query:data', (ctx) => this.onCallback(ctx));

    // TG-005: the only reliable signal that a shopper blocked us is the
    // my_chat_member update; a send failure is noticed too, but later.
    this.bot.on('my_chat_member', async (ctx) => {
      const status = ctx.myChatMember.new_chat_member.status;
      const blocked = status === 'kicked' || status === 'left';
      const telegramId = ctx.from?.id;
      if (!telegramId) return;
      await this.api
        .reportBlocked(String(telegramId), blocked)
        .catch((error) => logger.warn({ err: String(error) }, 'could not report block state'));
      logger.info({ telegramId, blocked }, 'chat member state changed');
    });

    // Anything else: a free-text message. Either a support note, or a brief
    // for the stylist, which we open in the app with the text pre-filled.
    this.bot.on('message:text', (ctx) => this.onText(ctx));
  }

  /* ── Commands ──────────────────────────────────────────────────────────── */

  private async onStart(ctx: Context): Promise<void> {
    const from = ctx.from;
    if (!from) return;

    // TG-006: the API owns the user record; the bot reports what Telegram
    // told it and takes back the locale the shopper already chose.
    let locale = resolveLocale(from.language_code ?? null);
    let isNewUser = true;
    try {
      const synced = await this.api.syncUser({
        telegramId: String(from.id),
        firstName: from.first_name,
        lastName: from.last_name,
        username: from.username,
        languageCode: from.language_code,
        chatId: ctx.chat ? String(ctx.chat.id) : undefined,
      });
      locale = synced.locale;
      isNewUser = synced.isNewUser;
    } catch (error) {
      logger.warn({ err: String(error) }, 'could not sync the user; continuing from Telegram data');
    }
    this.setLocale(from.id, locale);

    // TG-002: /start can carry a deep-link payload. A shopper who tapped a
    // product link in a channel lands on that product, not on the menu.
    const payload = this.startPayload(ctx);
    if (payload) {
      const route = this.routeForPayload(payload);
      if (route) {
        await ctx.reply(t(locale, 'start.greeting'), {
          parse_mode: 'HTML',
          reply_markup: this.appButton(locale, route, t(locale, 'common.openApp')),
        });
        return;
      }
    }

    // A first-time shopper picks a language before anything else, because the
    // one Telegram reports is a guess and the whole shop is about to be in it.
    if (isNewUser && !from.language_code) {
      await ctx.reply(t(locale, 'start.pickLanguage'), { reply_markup: this.languageKeyboard() });
      return;
    }

    const greeting = isNewUser
      ? `${t(locale, 'start.greeting')}\n\n${t(locale, 'start.lead')}`
      : `${t(locale, 'start.welcomeBack', { name: escapeHtml(from.first_name ?? '') })}\n\n${t(
          locale,
          'start.lead',
        )}`;

    await ctx.reply(greeting, {
      parse_mode: 'HTML',
      reply_markup: await this.mainMenu(locale),
    });
  }

  private async onCatalog(ctx: Context): Promise<void> {
    const locale = this.localeFor(ctx);
    const context = await this.context(ctx);
    const keyboard = new InlineKeyboard();

    for (const category of context?.categories.slice(0, 8) ?? []) {
      keyboard.webApp(escapeHtml(category.name), this.appUrl(category.deepLink)).row();
    }
    keyboard.webApp(t(locale, 'catalog.all'), this.appUrl()).row();

    await ctx.reply(t(locale, 'catalog.pick'), { reply_markup: keyboard });
  }

  private async onBrands(ctx: Context): Promise<void> {
    const locale = this.localeFor(ctx);
    const context = await this.context(ctx);
    const keyboard = new InlineKeyboard();

    for (const brand of context?.brands.slice(0, 8) ?? []) {
      keyboard.webApp(escapeHtml(brand.name), this.appUrl(brand.deepLink)).row();
    }
    keyboard.webApp(t(locale, 'brands.all'), this.appUrl(encodeDeepLink({ kind: 'home' }))).row();

    await ctx.reply(t(locale, 'brands.pick'), { reply_markup: keyboard });
  }

  private async onStylist(ctx: Context): Promise<void> {
    const locale = this.localeFor(ctx);
    const context = await this.context(ctx);
    const suggestions = context?.stylistSuggestions.slice(0, 3) ?? [];

    const body = [
      t(locale, 'stylist.prompt'),
      suggestions.length > 0
        ? `\n${t(locale, 'stylist.examples')}\n${suggestions
            .map((suggestion) => `• <i>${escapeHtml(suggestion)}</i>`)
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(body, {
      parse_mode: 'HTML',
      reply_markup: this.appButton(
        locale,
        encodeDeepLink({ kind: 'stylist' }),
        t(locale, 'stylist.open'),
      ),
    });
  }

  private async onOrders(ctx: Context): Promise<void> {
    const locale = this.localeFor(ctx);
    const context = await this.context(ctx);
    const orders = context?.recentOrders ?? [];

    if (orders.length === 0) {
      await ctx.reply(t(locale, 'orders.none'), {
        reply_markup: this.appButton(locale, undefined, t(locale, 'start.openApp')),
      });
      return;
    }

    const keyboard = new InlineKeyboard();
    const lines = [t(locale, 'orders.recent')];
    for (const order of orders) {
      // The status wording is the shared catalogue's, so the bot and the app
      // never describe the same order differently.
      lines.push(
        `\n<b>${escapeHtml(order.number)}</b> — ${escapeHtml(
          translate(locale, `order.status.${order.status}`),
        )}`,
      );
      keyboard.webApp(escapeHtml(order.number), this.appUrl(order.deepLink)).row();
    }

    await ctx.reply(lines.join(''), { parse_mode: 'HTML', reply_markup: keyboard });
  }

  private async onHelp(ctx: Context): Promise<void> {
    const locale = this.localeFor(ctx);
    const context = await this.context(ctx);
    const entries = context?.faq?.entries ?? [];

    const lines = [`<b>${escapeHtml(t(locale, 'help.title'))}</b>`];
    for (const entry of entries.slice(0, 6)) {
      lines.push(`\n<b>${escapeHtml(entry.question)}</b>\n${escapeHtml(entry.answer)}`);
    }
    lines.push(`\n${escapeHtml(context?.faq?.escalation ?? t(locale, 'help.escalation'))}`);
    lines.push(`\n${t(locale, 'cmd.helpBody')}`);

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: this.appButton(locale, undefined, t(locale, 'start.openApp')),
    });
  }

  private async onLanguage(ctx: Context): Promise<void> {
    const locale = this.localeFor(ctx);
    await ctx.reply(t(locale, 'language.pick'), { reply_markup: this.languageKeyboard() });
  }

  /**
   * USR-003: turning notifications off is one command, takes effect at once,
   * and does not delete the account or the orders.
   */
  private async onStop(ctx: Context): Promise<void> {
    const locale = this.localeFor(ctx);
    const telegramId = ctx.from?.id;
    if (telegramId) {
      await this.api
        .reportBlocked(String(telegramId), true)
        .catch((error) => logger.warn({ err: String(error) }, 'could not record the opt-out'));
    }
    await ctx.reply(t(locale, 'notify.stopped'));
  }

  /* ── Callbacks ─────────────────────────────────────────────────────────── */

  private async onCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    if (data.startsWith('lang:')) {
      const chosen = data.slice(5);
      const locale = (LOCALES as readonly string[]).includes(chosen)
        ? (chosen as Locale)
        : DEFAULT_LOCALE;
      const telegramId = ctx.from?.id;
      if (telegramId) {
        this.setLocale(telegramId, locale);
        await this.api
          .syncUser({ telegramId: String(telegramId), languageCode: locale })
          .catch((error) => logger.warn({ err: String(error) }, 'could not persist the language'));
      }
      await ctx.answerCallbackQuery(t(locale, 'language.changed'));
      await ctx.reply(
        `${t(locale, 'language.changed')}\n\n${t(locale, 'start.lead')}`,
        { parse_mode: 'HTML', reply_markup: await this.mainMenu(locale) },
      );
      return;
    }

    if (data === 'support') {
      const locale = this.localeFor(ctx);
      const telegramId = ctx.from?.id;
      if (telegramId) this.patchState(telegramId, { awaitingSupport: true });
      await ctx.answerCallbackQuery();
      await ctx.reply(t(locale, 'help.contact'));
      return;
    }

    await ctx.answerCallbackQuery();
  }

  /* ── Free text ─────────────────────────────────────────────────────────── */

  private async onText(ctx: Context): Promise<void> {
    const locale = this.localeFor(ctx);
    const text = ctx.message?.text?.trim() ?? '';
    const telegramId = ctx.from?.id;
    if (!text || !telegramId) return;

    if (text.startsWith('/')) {
      await ctx.reply(t(locale, 'error.unknownCommand'));
      return;
    }

    const state = this.stateFor(telegramId);

    // A message written after tapping "message support" goes to support.
    if (state.awaitingSupport) {
      this.patchState(telegramId, { awaitingSupport: false });
      await this.forwardToSupport(ctx, text);
      await ctx.reply(t(locale, 'help.received'));
      return;
    }

    // Otherwise it reads like a stylist brief. We do not try to answer it in
    // the chat: the stylist needs prices, sizes and stock, and a look is only
    // honest where those can be shown. The brief is carried into the app.
    await ctx.reply(t(locale, 'stylist.prompt'), {
      parse_mode: 'HTML',
      reply_markup: this.appButton(
        locale,
        encodeDeepLink({ kind: 'stylist', prompt: text.slice(0, 120) }),
        t(locale, 'stylist.open'),
      ).text(t(locale, 'help.contact'), 'support'),
    });
  }

  /**
   * §10.2: a shopper's message reaches a human. Without a configured support
   * chat there is nowhere to forward it, and saying "we got it" would be a
   * lie, so that case is logged loudly instead.
   */
  private async forwardToSupport(ctx: Context, text: string): Promise<void> {
    if (!this.config.supportChatId) {
      logger.warn(
        { telegramId: ctx.from?.id },
        'support message received but TELEGRAM_SUPPORT_CHAT_ID is not set — nobody will see it',
      );
      return;
    }
    const from = ctx.from;
    const header = [
      '<b>Поддержка</b>',
      from?.username ? `@${escapeHtml(from.username)}` : null,
      from ? `id <code>${from.id}</code>` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    await this.bot.api
      .sendMessage(this.config.supportChatId, `${header}\n\n${escapeHtml(text)}`, {
        parse_mode: 'HTML',
      })
      .catch((error) => logger.error({ err: String(error) }, 'could not forward to support'));
  }

  /* ── Keyboards ─────────────────────────────────────────────────────────── */

  private async mainMenu(locale: Locale): Promise<InlineKeyboard> {
    const keyboard = new InlineKeyboard();
    if (this.config.miniAppUrl) {
      keyboard.webApp(t(locale, 'start.openApp'), this.appUrl()).row();
      keyboard
        .webApp(t(locale, 'menu.stylist'), this.appUrl(encodeDeepLink({ kind: 'stylist' })))
        .webApp(t(locale, 'menu.orders'), this.appUrl(encodeDeepLink({ kind: 'home' })))
        .row();
    }
    keyboard.text(t(locale, 'menu.help'), 'noop').text(t(locale, 'menu.language'), 'lang:pick');
    return keyboard;
  }

  private languageKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const locale of LOCALES) {
      keyboard.text(LOCALE_LABELS[locale], `lang:${locale}`);
    }
    return keyboard;
  }

  /**
   * A web_app button, or a plain link when the Mini App URL is not configured.
   * A dead button is worse than no button, so when there is no app we say so.
   */
  private appButton(locale: Locale, deepLink: string | undefined, label: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    if (!this.config.miniAppUrl) return keyboard.text(t(locale, 'error.noApp'), 'noop');
    return keyboard.webApp(label, this.appUrl(deepLink));
  }

  /**
   * TG-002: the Mini App URL with the deep-link payload as `startapp`, which
   * is what Telegram hands back to the app as `start_param`.
   */
  private appUrl(deepLink?: string): string {
    const base = this.config.miniAppUrl;
    if (!deepLink) return base;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}startapp=${encodeURIComponent(deepLink)}`;
  }

  /* ── State ─────────────────────────────────────────────────────────────── */

  private stateFor(telegramId: number): ChatState {
    const existing = this.state.get(telegramId);
    if (existing) return existing;
    const created: ChatState = { locale: DEFAULT_LOCALE, awaitingSupport: false, lastSeen: Date.now() };
    this.state.set(telegramId, created);
    return created;
  }

  private patchState(telegramId: number, patch: Partial<ChatState>): void {
    this.state.set(telegramId, { ...this.stateFor(telegramId), ...patch, lastSeen: Date.now() });
  }

  private setLocale(telegramId: number, locale: Locale): void {
    this.patchState(telegramId, { locale });
  }

  private localeFor(ctx: Context): Locale {
    const telegramId = ctx.from?.id;
    if (telegramId && this.state.has(telegramId)) return this.stateFor(telegramId).locale;
    return resolveLocale(ctx.from?.language_code ?? null);
  }

  /**
   * The /start payload. grammY exposes it as the command's match, and a
   * callback-initiated start has none.
   */
  private startPayload(ctx: Context): string | null {
    const text = ctx.message?.text ?? '';
    const match = /^\/start(?:@\w+)?\s+(.+)$/.exec(text);
    return match ? match[1].trim() : null;
  }

  private routeForPayload(payload: string): string | null {
    try {
      const target = decodeDeepLink(payload);
      // 'home' is what decodeDeepLink returns for anything it cannot read, so
      // a malformed payload opens the shop rather than erroring.
      return deepLinkToRoute(target) ? payload : null;
    } catch {
      return null;
    }
  }

  /** The /start context, cached briefly: it is the same for every shopper. */
  private async context(ctx: Context): Promise<BotContext | null> {
    const locale = this.localeFor(ctx);
    const fresh = this.contextCache && Date.now() - this.contextCache.at < 60_000;
    if (fresh && this.contextCache!.value.user === null) return this.contextCache!.value;

    try {
      const value = await this.api.context({
        telegramId: ctx.from ? String(ctx.from.id) : undefined,
        locale,
      });
      // Only the shopper-independent answer is worth caching.
      if (!ctx.from) this.contextCache = { value, at: Date.now() };
      return value;
    } catch (error) {
      logger.warn({ err: String(error) }, 'could not load the bot context');
      return null;
    }
  }

  /** Clears chat state that has not been touched for a day. */
  pruneState(maxAgeMs = 86_400_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [telegramId, state] of this.state) {
      if (state.lastSeen < cutoff) this.state.delete(telegramId);
    }
  }
}
