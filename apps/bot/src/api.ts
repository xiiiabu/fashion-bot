/**
 * The service channel to the API — spec TG-006.
 *
 * Every request is signed with an HMAC over a stable serialisation of the body,
 * keyed by the bot token. That is the whole authentication: the bot carries no
 * user session, cannot act as a shopper, and the endpoints it can reach are
 * the five the API exposes for it. A browser cannot forge the signature
 * because it does not have the token.
 *
 * The serialisation has to match the API's `stableStringify` exactly —
 * sorted keys, no whitespace — or every call is rejected. It is reimplemented
 * here rather than imported because the API's copy is not part of the shared
 * package, and a shared helper that silently diverged would be worse than two
 * explicit ones with a test over them.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Locale } from '@fashion/core';

/** Must mirror apps/api/src/common/crypto.ts `stableStringify`. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${parts.join(',')}}`;
}

export function signBody(body: unknown, token: string): string {
  return createHmac('sha256', token).update(stableStringify(body)).digest('hex');
}

/** Used by the webhook handler to check Telegram's own secret token. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface NotificationJob {
  id: string;
  telegramId: string;
  chatId: string | null;
  text: string;
  locale: Locale;
  deepLink: string | null;
  miniAppUrl: string | null;
  kind: string;
}

export interface BotContext {
  user: { id: string; locale: Locale } | null;
  categories: Array<{ slug: string; name: string; deepLink: string }>;
  brands: Array<{ slug: string; name: string; deepLink: string }>;
  stylistSuggestions: string[];
  recentOrders: Array<{ number: string; status: string; deepLink: string }>;
  faq: { entries: Array<{ id: string; category: string; question: string; answer: string }>; escalation: string | null };
  miniAppUrl: string | null;
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bot-signature': signBody(body, this.token),
      },
      // The signature covers the exact bytes we send, so the body is
      // serialised the same way it was signed.
      body: stableStringify(body),
    });

    const text = await response.text();
    const payload: unknown = text ? safeJson(text) : null;

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'INTERNAL',
        error?.message ?? `API responded ${response.status}`,
      );
    }
    return payload as T;
  }

  /** TG-006: the bot learns about a user from /start, never the other way. */
  syncUser(input: {
    telegramId: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    languageCode?: string;
    chatId?: string;
  }): Promise<{ userId: string; locale: Locale; isNewUser: boolean }> {
    return this.post('/bot/sync-user', { ...input });
  }

  /** NTF-002: claims a batch so two bot instances cannot send the same twice. */
  claimNotifications(limit: number): Promise<{ items: NotificationJob[] }> {
    return this.post('/bot/claim-notifications', { limit });
  }

  reportNotification(input: {
    id: string;
    sent: boolean;
    providerMessageId?: string;
    error?: string;
    blocked?: boolean;
  }): Promise<{ ok: true }> {
    return this.post('/bot/notification-result', { ...input });
  }

  /**
   * NTF-002: hands back notifications this sender claimed but will not send —
   * on shutdown, or when a rate limit cut the batch short. They go straight
   * back to QUEUED with no attempt counted against them.
   */
  releaseNotifications(ids: string[]): Promise<{ released: number }> {
    return this.post('/bot/release-notifications', { ids });
  }

  /** TG-005: a shopper who blocks the bot stops receiving anything. */
  reportBlocked(telegramId: string, blocked: boolean): Promise<{ ok: true }> {
    return this.post('/bot/blocked', { telegramId, blocked });
  }

  /** Everything /start needs, live from the database rather than hard-coded. */
  context(input: { telegramId?: string; locale?: Locale }): Promise<BotContext> {
    return this.post('/bot/context', { ...input });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
