/**
 * Bot configuration — spec §7.2 and §13.2.
 *
 * The bot is a separate process from the API on purpose: it holds the
 * long-lived Telegram connection and the send-rate budget, and a restart of
 * either must not take the other down. It talks to the API over the service
 * channel, signing each request with an HMAC over the body keyed by the bot
 * token — so the two share exactly one secret and the bot needs no user
 * session (TG-006).
 */

import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

// The repository keeps one .env at the root; each app reads what it needs.
loadDotenv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
loadDotenv({ quiet: true });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Set it in .env — see .env.example. The bot cannot ` +
        'run without it, and starting without a token would silently process ' +
        'nothing.',
    );
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface BotConfig {
  readonly token: string;
  readonly username: string;
  readonly apiUrl: string;
  readonly miniAppUrl: string;
  readonly supportChatId: string | null;
  readonly webhookUrl: string;
  readonly webhookSecret: string;
  readonly port: number;
  readonly isProduction: boolean;
  /** How often to drain the notification queue, in milliseconds (NTF-002). */
  readonly drainIntervalMs: number;
  readonly drainBatchSize: number;
  /** Telegram allows ~30 messages a second globally; we stay well under. */
  readonly sendsPerSecond: number;
}

export function loadBotConfig(): BotConfig {
  const isProduction = process.env.NODE_ENV === 'production';
  const token = required('TELEGRAM_BOT_TOKEN');
  const miniAppUrl = optional('TELEGRAM_MINIAPP_URL');

  if (isProduction && !miniAppUrl) {
    throw new Error(
      'TELEGRAM_MINIAPP_URL is required in production: without it the bot has ' +
        'no shop to open and every button would be dead.',
    );
  }

  return {
    token,
    username: optional('TELEGRAM_BOT_USERNAME'),
    apiUrl: optional('API_INTERNAL_URL', optional('API_URL', 'http://localhost:4000')).replace(
      /\/$/,
      '',
    ),
    miniAppUrl: miniAppUrl.replace(/\/$/, ''),
    supportChatId: optional('TELEGRAM_SUPPORT_CHAT_ID') || null,
    webhookUrl: optional('TELEGRAM_WEBHOOK_URL'),
    webhookSecret: optional('TELEGRAM_WEBHOOK_SECRET'),
    port: number('BOT_PORT', 4100),
    isProduction,
    drainIntervalMs: number('BOT_DRAIN_INTERVAL_MS', 3000),
    drainBatchSize: number('BOT_DRAIN_BATCH', 25),
    sendsPerSecond: number('BOT_SENDS_PER_SECOND', 20),
  };
}
