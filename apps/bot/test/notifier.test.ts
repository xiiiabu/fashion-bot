/**
 * Notification delivery — spec NTF-001/NTF-002, TG-004/TG-005.
 *
 * Driven against a stubbed Telegram and a stubbed API, because the behaviour
 * worth proving is what the notifier does with each kind of answer: a success,
 * a block, a rate limit, a transient fault. None of that needs a real network,
 * and all of it is the part that decides whether a shopper is told their order
 * shipped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GrammyError } from 'grammy';

import { Notifier } from '../src/notifier';
import type { ApiClient, NotificationJob } from '../src/api';
import type { BotConfig } from '../src/config';

const CONFIG: BotConfig = {
  token: 'test-token',
  username: 'test_bot',
  apiUrl: 'http://api.test',
  miniAppUrl: 'https://app.test',
  supportChatId: null,
  webhookUrl: '',
  webhookSecret: '',
  port: 0,
  isProduction: false,
  drainIntervalMs: 10_000,
  drainBatchSize: 10,
  // High enough that pacing never slows a test down.
  sendsPerSecond: 1000,
};

function job(overrides: Partial<NotificationJob> = {}): NotificationJob {
  return {
    id: 'n1',
    telegramId: '777000001',
    chatId: '777000001',
    text: 'Заказ FM-261006-0005 передан в доставку.',
    locale: 'ru',
    deepLink: 'oFM-261006-0005',
    miniAppUrl: null,
    kind: 'ORDER_SHIPPED',
    ...overrides,
  };
}

/** Records what the notifier told the API, which is the contract under test. */
function stubApi(items: NotificationJob[]) {
  const reports: Array<Record<string, unknown>> = [];
  const blocks: Array<{ telegramId: string; blocked: boolean }> = [];
  let claims = 0;

  const api = {
    claimNotifications: async () => {
      claims += 1;
      return { items: claims === 1 ? items : [] };
    },
    reportNotification: async (input: Record<string, unknown>) => {
      reports.push(input);
      return { ok: true as const };
    },
    reportBlocked: async (telegramId: string, blocked: boolean) => {
      blocks.push({ telegramId, blocked });
      return { ok: true as const };
    },
  } as unknown as ApiClient;

  return { api, reports, blocks, claimCount: () => claims };
}

/** A Telegram stub whose sendMessage behaviour each test decides. */
function stubBot(send: (chatId: string, text: string, options: unknown) => Promise<unknown>) {
  const calls: Array<{ chatId: string; text: string; options: Record<string, unknown> }> = [];
  const bot = {
    api: {
      sendMessage: async (chatId: string, text: string, options: Record<string, unknown>) => {
        calls.push({ chatId, text, options });
        return send(chatId, text, options);
      },
    },
  } as never;
  return { bot, calls };
}

/**
 * Telegram's error shape. The notifier matches on the shape rather than on
 * `instanceof GrammyError`, so this stands in for a real one — and the last
 * test in this file proves a genuine GrammyError is handled identically.
 */
class FakeGrammyError extends Error {
  readonly error_code: number;
  readonly description: string;
  readonly parameters?: { retry_after?: number };

  constructor(code: number, description: string, retryAfter?: number) {
    super(description);
    this.name = 'GrammyError';
    this.error_code = code;
    this.description = description;
    if (retryAfter !== undefined) this.parameters = { retry_after: retryAfter };
  }
}

describe('notification delivery', () => {
  it('sends a queued notification and reports it as sent', async () => {
    const { api, reports } = stubApi([job()]);
    const { bot, calls } = stubBot(async () => ({ message_id: 42 }));
    const notifier = new Notifier(bot, api, CONFIG);

    const count = await notifier.drain();

    assert.equal(count, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chatId, '777000001');
    assert.equal(notifier.stats.sent, 1);
    assert.deepEqual(reports, [{ id: 'n1', sent: true, providerMessageId: '42' }]);
  });

  it('escapes the text so a title cannot break the message', async () => {
    const { api } = stubApi([job({ text: 'Пальто <oversize> & шарф отправлены' })]);
    const { bot, calls } = stubBot(async () => ({ message_id: 1 }));
    await new Notifier(bot, api, CONFIG).drain();

    assert.equal(calls[0].text, 'Пальто &lt;oversize&gt; &amp; шарф отправлены');
    assert.equal(calls[0].options.parse_mode, 'HTML');
  });

  it('attaches a button that opens the thing the notification is about (TG-002)', async () => {
    const { api } = stubApi([job()]);
    const { bot, calls } = stubBot(async () => ({ message_id: 1 }));
    await new Notifier(bot, api, CONFIG).drain();

    const markup = calls[0].options.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; web_app?: { url: string } }>>;
    };
    const button = markup.inline_keyboard[0][0];
    assert.ok(button.web_app, 'it should be a web_app button, not a plain link');
    assert.ok(button.web_app!.url.startsWith('https://app.test'));
    assert.match(button.web_app!.url, /startapp=oFM-261006-0005/);
  });

  it('draws no button at all when there is no Mini App to open', async () => {
    const { api } = stubApi([job()]);
    const { bot, calls } = stubBot(async () => ({ message_id: 1 }));
    await new Notifier(bot, api, { ...CONFIG, miniAppUrl: '' }).drain();

    // A dead button is worse than none.
    assert.equal(calls[0].options.reply_markup, undefined);
  });

  it('prefers the per-job Mini App URL when the API supplies one', async () => {
    const { api } = stubApi([job({ miniAppUrl: 'https://other.test/app' })]);
    const { bot, calls } = stubBot(async () => ({ message_id: 1 }));
    await new Notifier(bot, api, CONFIG).drain();

    const markup = calls[0].options.reply_markup as {
      inline_keyboard: Array<Array<{ web_app?: { url: string } }>>;
    };
    assert.ok(markup.inline_keyboard[0][0].web_app!.url.startsWith('https://other.test/app'));
  });

  it('records a block and suppresses rather than retrying forever (TG-005)', async () => {
    const { api, reports, blocks } = stubApi([job()]);
    const { bot } = stubBot(async () => {
      throw new FakeGrammyError(403, 'Forbidden: bot was blocked by the user');
    });
    const notifier = new Notifier(bot, api, CONFIG);

    await notifier.drain();

    assert.equal(notifier.stats.blocked, 1);
    assert.equal(notifier.stats.sent, 0);
    assert.deepEqual(blocks, [{ telegramId: '777000001', blocked: true }]);
    assert.deepEqual(reports, [{ id: 'n1', sent: false, error: 'bot_blocked', blocked: true }]);
  });

  it('treats a deactivated account as a block too', async () => {
    const { api, blocks } = stubApi([job()]);
    const { bot } = stubBot(async () => {
      throw new FakeGrammyError(403, 'Forbidden: user is deactivated');
    });
    await new Notifier(bot, api, CONFIG).drain();
    assert.deepEqual(blocks, [{ telegramId: '777000001', blocked: true }]);
  });

  it('leaves a rate-limited job unreported so the next drain retries it', async () => {
    const { api, reports } = stubApi([job()]);
    const { bot } = stubBot(async () => {
      throw new FakeGrammyError(429, 'Too Many Requests', 1);
    });
    const notifier = new Notifier(bot, api, CONFIG);

    const started = Date.now();
    await notifier.drain();
    const elapsed = Date.now() - started;

    // Nothing reported: the job is still queued on the API side.
    assert.deepEqual(reports, []);
    assert.equal(notifier.stats.failed, 0);
    assert.equal(notifier.stats.sent, 0);
    // And it actually waited the retry_after Telegram asked for.
    assert.ok(elapsed >= 900, `expected to back off, waited ${elapsed}ms`);
  });

  it('reports a transient failure so it can be retried or alerted on', async () => {
    const { api, reports } = stubApi([job()]);
    const { bot } = stubBot(async () => {
      throw new Error('socket hang up');
    });
    const notifier = new Notifier(bot, api, CONFIG);

    await notifier.drain();

    assert.equal(notifier.stats.failed, 1);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].sent, false);
    assert.match(String(reports[0].error), /socket hang up/);
  });

  it('keeps going after one job fails', async () => {
    const { api, reports } = stubApi([job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]);
    const { bot } = stubBot(async (_chatId, _text, _options) => {
      if (reports.length === 1) throw new Error('one bad send');
      return { message_id: 7 };
    });
    const notifier = new Notifier(bot, api, CONFIG);

    await notifier.drain();

    assert.equal(reports.length, 3, 'every job in the batch is accounted for');
    assert.equal(notifier.stats.sent, 2);
    assert.equal(notifier.stats.failed, 1);
  });

  it('does not run two drains at once', async () => {
    const { api, claimCount } = stubApi([job()]);
    const { bot } = stubBot(
      () => new Promise((resolve) => setTimeout(() => resolve({ message_id: 1 }), 60)),
    );
    const notifier = new Notifier(bot, api, CONFIG);

    // A slow Telegram must not let drains pile up, each claiming its own batch.
    const [first, second] = await Promise.all([notifier.drain(), notifier.drain()]);

    assert.equal(claimCount(), 1, 'only one batch should have been claimed');
    assert.equal(first + second, 1);
  });

  it('paces sends to stay inside the rate limit', async () => {
    const jobs = Array.from({ length: 6 }, (_, index) => job({ id: `n${index}` }));
    const { api } = stubApi(jobs);
    const { bot, calls } = stubBot(async () => ({ message_id: 1 }));
    // Three a second: six messages must take at least one extra window.
    const notifier = new Notifier(bot, api, { ...CONFIG, sendsPerSecond: 3 });

    const started = Date.now();
    await notifier.drain();
    const elapsed = Date.now() - started;

    assert.equal(calls.length, 6);
    assert.ok(elapsed >= 900, `expected pacing, finished in ${elapsed}ms`);
  });

  it('does nothing when the queue is empty', async () => {
    const { api, reports } = stubApi([]);
    const { bot, calls } = stubBot(async () => ({ message_id: 1 }));
    const notifier = new Notifier(bot, api, CONFIG);

    assert.equal(await notifier.drain(), 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(reports, []);
  });

  it('handles a real GrammyError the same way as the shape-matched one', async () => {
    const { api, blocks, reports } = stubApi([job()]);
    const { bot } = stubBot(async () => {
      // Exactly what grammY throws when a shopper has blocked the bot.
      throw new GrammyError(
        'Call to "sendMessage" failed!',
        { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        'sendMessage',
        {},
      );
    });
    const notifier = new Notifier(bot, api, CONFIG);

    await notifier.drain();

    assert.equal(notifier.stats.blocked, 1);
    assert.deepEqual(blocks, [{ telegramId: '777000001', blocked: true }]);
    assert.equal(reports[0].error, 'bot_blocked');
  });

  it('survives an API that will not answer', async () => {
    const api = {
      claimNotifications: async () => {
        throw new Error('API unreachable');
      },
    } as unknown as ApiClient;
    const { bot } = stubBot(async () => ({ message_id: 1 }));
    const notifier = new Notifier(bot, api, CONFIG);

    // A down API must not take the bot process with it.
    assert.equal(await notifier.drain(), 0);
  });
});
