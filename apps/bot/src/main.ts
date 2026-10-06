/**
 * Bot entry point — spec §13.2.
 *
 * Long polling in development, a webhook in production when one is configured.
 * Polling needs no public URL, which is what makes the bot runnable on a
 * laptop; a webhook is what survives a restart without losing updates and is
 * what a deployment should use.
 *
 * The process exits non-zero on a fatal error rather than limping: a bot that
 * is up but not delivering notifications is worse than one that is visibly
 * down, because nothing alerts on the former.
 */

import { webhookCallback } from 'grammy';
import { createServer } from 'node:http';
import { ApiClient, constantTimeEqual } from './api';
import { FashionBot } from './bot';
import { loadBotConfig } from './config';
import { logger } from './logger';
import { Notifier } from './notifier';

async function main(): Promise<void> {
  const config = loadBotConfig();
  const api = new ApiClient(config.apiUrl, config.token);
  const fashionBot = new FashionBot(config, api);
  const notifier = new Notifier(fashionBot.bot, api, config);

  // The command list is what a shopper sees when they tap the menu button, so
  // it is set on start rather than configured by hand in BotFather.
  await fashionBot.bot.api
    .setMyCommands([
      { command: 'start', description: 'Открыть магазин / Doʻkonni ochish' },
      { command: 'shop', description: 'Каталог / Katalog' },
      { command: 'stylist', description: 'AI-стилист / AI-stilist' },
      { command: 'orders', description: 'Мои заказы / Buyurtmalarim' },
      { command: 'help', description: 'Помощь / Yordam' },
      { command: 'language', description: 'Язык / Til' },
      { command: 'stop', description: 'Отключить уведомления / Xabarnomalarni oʻchirish' },
    ])
    .catch((error) => logger.warn({ err: String(error) }, 'could not publish the command list'));

  // The chat menu button opens the Mini App directly, which is the shortest
  // path from a chat to the shop.
  if (config.miniAppUrl) {
    await fashionBot.bot.api
      .setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Atlas', web_app: { url: config.miniAppUrl } },
      })
      .catch((error) => logger.warn({ err: String(error) }, 'could not set the menu button'));
  }

  const prune = setInterval(() => fashionBot.pruneState(), 3_600_000);
  prune.unref();

  notifier.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    // Stop claiming, then wait for the drain in flight to finish: its `finally`
    // releases whatever it will not send, so a deploy does not strand an order
    // update for the length of the claim lease.
    notifier.stop();
    await notifier.settle(10_000);
    clearInterval(prune);
    await fashionBot.bot.stop().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  if (config.webhookUrl) {
    const handle = webhookCallback(fashionBot.bot, 'http');
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, mode: 'webhook', ...notifier.stats }));
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      // Telegram echoes the secret token we registered. Without this check the
      // endpoint would accept an update from anyone who found the URL.
      const presented = request.headers['x-telegram-bot-api-secret-token'];
      if (
        config.webhookSecret &&
        (typeof presented !== 'string' || !constantTimeEqual(presented, config.webhookSecret))
      ) {
        logger.warn('rejected a webhook call with a bad secret token');
        response.writeHead(401).end();
        return;
      }
      void handle(request, response);
    });

    server.listen(config.port, () => logger.info({ port: config.port }, 'bot webhook listening'));

    await fashionBot.bot.api.setWebhook(config.webhookUrl, {
      secret_token: config.webhookSecret || undefined,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false,
    });
    logger.info({ url: config.webhookUrl }, 'webhook registered');
    return;
  }

  // Long polling. Any webhook left over from an earlier deployment has to go,
  // or Telegram refuses to poll.
  await fashionBot.bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

  // A small health endpoint even in polling mode, so a supervisor can tell the
  // difference between "running" and "delivering".
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, mode: 'polling', ...notifier.stats }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(config.port, () => logger.info({ port: config.port }, 'bot health endpoint listening'));

  logger.info({ api: config.apiUrl, miniApp: config.miniAppUrl || '(not set)' }, 'bot starting (polling)');
  await fashionBot.bot.start({
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    onStart: (info) => logger.info({ username: info.username }, 'bot online'),
  });
}

main().catch((error) => {
  logger.fatal({ err: error instanceof Error ? error.message : String(error) }, 'bot failed to start');
  process.exit(1);
});
