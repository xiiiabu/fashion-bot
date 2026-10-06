/**
 * Notification delivery — spec NTF-001/NTF-002 and TG-004/TG-005.
 *
 * The API queues a notification when something about an order changes; this
 * drains that queue and sends it. Three properties matter:
 *
 *  - Exactly once, as far as the shopper can tell. The API hands out a claimed
 *    batch, and every job is reported back as sent or failed. A crash between
 *    sending and reporting can duplicate one message, which is the right side
 *    to err on: a repeated "your order shipped" is a nuisance, a missing one
 *    costs a delivery.
 *  - Within Telegram's rate limits. Sends are paced, and a 429 is obeyed
 *    rather than retried immediately.
 *  - A blocked shopper is told to the API at once (TG-005), so the queue stops
 *    producing for them instead of failing the same job forever.
 */

import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { Locale } from '@fashion/core';
import { encodeDeepLink } from '@fashion/core';
import type { ApiClient, NotificationJob } from './api';
import type { BotConfig } from './config';
import { escapeHtml, t } from './copy';
import { logger } from './logger';

export class Notifier {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private sentInWindow = 0;
  /** Set when Telegram rate-limits us, so the rest of the batch is given back. */
  private rateLimited = false;
  private windowStartedAt = Date.now();

  readonly stats = { sent: 0, failed: 0, blocked: 0, batches: 0 };

  constructor(
    private readonly bot: Bot,
    private readonly api: ApiClient,
    private readonly config: BotConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = () => {
      void this.drain().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.config.drainIntervalMs);
      });
    };
    this.timer = setTimeout(tick, this.config.drainIntervalMs);
    logger.info({ intervalMs: this.config.drainIntervalMs }, 'notification drain started');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Waits for a drain in flight to finish, so its release runs before the
   * process exits. Returns false if it did not settle in time, in which case
   * the claim lease is the backstop.
   */
  async settle(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      await sleep(50);
    }
    return !this.running;
  }

  /**
   * One pass over the queue. Overlapping passes are skipped rather than queued:
   * a slow Telegram must not pile up concurrent drains all claiming batches.
   */
  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const { items } = await this.api.claimNotifications(this.config.drainBatchSize);
      if (items.length === 0) return 0;
      this.stats.batches += 1;

      // Whatever is claimed is owned until it is reported or released. A batch
      // abandoned half-way — a shutdown, a rate-limit pause — would otherwise
      // sit unsent until its lease expired.
      const outstanding = new Set(items.map((job) => job.id));
      try {
        for (const job of items) {
          if (this.stopped) break;
          await this.waitForSendBudget();
          const settled = await this.deliver(job);
          if (settled) outstanding.delete(job.id);
          if (this.rateLimited) break;
        }
      } finally {
        this.rateLimited = false;
        await this.releaseOutstanding(outstanding);
      }
      return items.length;
    } catch (error) {
      logger.warn({ err: String(error) }, 'could not claim notifications');
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Returns true when the job's outcome was reported, false when it is still owned. */
  private async deliver(job: NotificationJob): Promise<boolean> {
    const chatId = job.chatId ?? job.telegramId;
    const markup = this.keyboardFor(job);

    try {
      const message = await this.bot.api.sendMessage(chatId, this.render(job), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(markup ? { reply_markup: markup } : {}),
      });
      this.stats.sent += 1;
      await this.api.reportNotification({
        id: job.id,
        sent: true,
        providerMessageId: String(message.message_id),
      });
      return true;
    } catch (error) {
      return this.handleSendFailure(job, error);
    }
  }

  private async releaseOutstanding(ids: Set<string>): Promise<void> {
    if (ids.size === 0) return;
    await this.api
      .releaseNotifications([...ids])
      .then(({ released }) => logger.info({ released }, 'released unsent notifications'))
      .catch((error) =>
        logger.warn({ err: String(error) }, 'could not release unsent notifications'),
      );
  }

  private async handleSendFailure(job: NotificationJob, error: unknown): Promise<boolean> {
    const telegramError = asTelegramError(error);
    if (telegramError) {
      const description = telegramError.description;

      // TG-005: the shopper blocked the bot, deleted their account, or never
      // started a chat. None of those get better by retrying.
      const blocked =
        telegramError.code === 403 ||
        /bot was blocked|user is deactivated|chat not found|bot can't initiate/i.test(description);

      if (blocked) {
        this.stats.blocked += 1;
        await this.api
          .reportBlocked(job.telegramId, true)
          .catch((reportError) =>
            logger.warn({ err: String(reportError) }, 'could not report the block'),
          );
        await this.api.reportNotification({
          id: job.id,
          sent: false,
          error: 'bot_blocked',
          blocked: true,
        });
        logger.info({ telegramId: job.telegramId }, 'suppressed: the bot is blocked');
        return true;
      }

      // 429: Telegram says exactly how long to wait, so we wait that long and
      // leave the job unreported — the next drain picks it up again.
      if (telegramError.code === 429) {
        const retryAfter = telegramError.retryAfter ?? 1;
        logger.warn({ retryAfter }, 'rate limited by telegram; pausing the drain');
        await sleep(Math.min(retryAfter, 30) * 1000);
        // The rest of the batch is released rather than rushed: Telegram has
        // just said we are going too fast.
        this.rateLimited = true;
        return false;
      }
    }

    this.stats.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    await this.api
      .reportNotification({ id: job.id, sent: false, error: message.slice(0, 300) })
      .catch((reportError) =>
        logger.warn({ err: String(reportError) }, 'could not report a failed send'),
      );
    logger.error({ id: job.id, err: message }, 'notification send failed');
    return true;
  }

  /**
   * NTF-001: the text is composed by the API in the shopper's language, so the
   * bot does not re-translate it. It only escapes it for Telegram's HTML
   * parser — an order number or a product title could otherwise break the
   * message.
   */
  private render(job: NotificationJob): string {
    return escapeHtml(job.text);
  }

  /**
   * TG-002/TG-004: a notification about an order opens that order. Without a
   * Mini App URL there is nothing to open, so no button is drawn rather than a
   * dead one.
   */
  private keyboardFor(job: NotificationJob): InlineKeyboard | null {
    const base = job.miniAppUrl ?? this.config.miniAppUrl;
    if (!base) return null;

    const deepLink = job.deepLink ?? encodeDeepLink({ kind: 'home' });
    const separator = base.includes('?') ? '&' : '?';
    const url = `${base}${separator}startapp=${encodeURIComponent(deepLink)}`;

    return new InlineKeyboard().webApp(t(job.locale as Locale, 'common.openApp'), url);
  }

  /**
   * Paces sends inside a one-second window. Telegram's documented ceiling is
   * about 30 messages a second across all chats; staying under it is cheaper
   * than handling the 429 that follows.
   */
  private async waitForSendBudget(): Promise<void> {
    const now = Date.now();
    if (now - this.windowStartedAt >= 1000) {
      this.windowStartedAt = now;
      this.sentInWindow = 0;
    }
    if (this.sentInWindow >= this.config.sendsPerSecond) {
      await sleep(1000 - (now - this.windowStartedAt));
      this.windowStartedAt = Date.now();
      this.sentInWindow = 0;
    }
    this.sentInWindow += 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Normalises a Telegram API failure.
 *
 * Deliberately not `error instanceof GrammyError`: with two copies of grammy
 * in the tree — which a transitive dependency can cause at any time — that
 * check silently returns false and every blocked shopper is retried forever
 * instead of being suppressed. The shape is what matters, and Telegram's error
 * shape is stable: a numeric `error_code`, a `description`, and `retry_after`
 * on a 429.
 */
function asTelegramError(
  error: unknown,
): { code: number; description: string; retryAfter?: number } | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    error_code?: unknown;
    description?: unknown;
    parameters?: { retry_after?: unknown };
  };
  if (typeof candidate.error_code !== 'number') return null;
  const retryAfter = candidate.parameters?.retry_after;
  return {
    code: candidate.error_code,
    description: typeof candidate.description === 'string' ? candidate.description : '',
    retryAfter: typeof retryAfter === 'number' ? retryAfter : undefined,
  };
}
