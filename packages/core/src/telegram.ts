/**
 * Telegram initData validation — spec TG-001, TG-003, TG-005.
 *
 * TG-001: the signature and auth_date of `Telegram.WebApp.initData` are checked
 * server-side; `initDataUnsafe` is never trusted. An invalid or stale payload
 * must not produce an authenticated session.
 *
 * Two signing schemes exist and both are supported:
 *  - `hash`: HMAC-SHA256 with key = HMAC("WebAppData", botToken)   (bot-bound)
 *  - `signature`: Ed25519 over the same data-check-string            (third-party)
 * We verify `hash` when a bot token is configured, which is the normal case.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  /** TG-005: optional. Never used as identity. */
  readonly username?: string;
  readonly language_code?: string;
  readonly is_premium?: boolean;
  /** TG-005: optional, and not a reliable identifier. */
  readonly photo_url?: string;
  readonly allows_write_to_pm?: boolean;
}

export interface TelegramInitData {
  readonly user?: TelegramUser;
  readonly receiver?: TelegramUser;
  readonly chat_instance?: string;
  readonly chat_type?: string;
  readonly start_param?: string;
  readonly auth_date: number;
  readonly hash: string;
  readonly signature?: string;
  readonly query_id?: string;
}

export type InitDataFailure =
  | 'MISSING_INIT_DATA'
  | 'MISSING_HASH'
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'STALE'
  | 'NO_USER'
  | 'NO_BOT_TOKEN';

export type InitDataResult =
  | { ok: true; data: TelegramInitData; user: TelegramUser; startParam: string | null; authDate: Date }
  | { ok: false; reason: InitDataFailure };

/**
 * The data-check-string: every field except `hash` and `signature`, sorted by
 * key, joined with newlines. Must be built from the raw query string so the
 * exact bytes Telegram signed are the bytes we hash.
 */
export function buildDataCheckString(initData: string): { checkString: string; hash: string | null; pairs: Map<string, string> } {
  const params = new URLSearchParams(initData);
  const pairs = new Map<string, string>();
  let hash: string | null = null;
  for (const [key, value] of params.entries()) {
    if (key === 'hash') {
      hash = value;
      continue;
    }
    if (key === 'signature') continue;
    pairs.set(key, value);
  }
  const checkString = [...pairs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return { checkString, hash, pairs };
}

export function verifyInitData(
  initData: string | null | undefined,
  botToken: string | null | undefined,
  options: { maxAgeSeconds?: number; now?: Date } = {},
): InitDataResult {
  if (!initData || initData.trim() === '') return { ok: false, reason: 'MISSING_INIT_DATA' };
  if (!botToken || botToken.trim() === '') return { ok: false, reason: 'NO_BOT_TOKEN' };

  const { checkString, hash, pairs } = buildDataCheckString(initData);
  if (!hash) return { ok: false, reason: 'MISSING_HASH' };

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (!constantTimeEquals(expected, hash)) return { ok: false, reason: 'BAD_SIGNATURE' };

  const authDateRaw = pairs.get('auth_date');
  const authDateSeconds = authDateRaw ? Number.parseInt(authDateRaw, 10) : Number.NaN;
  if (!Number.isFinite(authDateSeconds)) return { ok: false, reason: 'MALFORMED' };

  const now = options.now ?? new Date();
  const maxAge = options.maxAgeSeconds ?? 86_400;
  const ageSeconds = Math.floor(now.getTime() / 1000) - authDateSeconds;
  // A payload from the future by more than a minute means a tampered clock.
  if (ageSeconds > maxAge || ageSeconds < -60) return { ok: false, reason: 'STALE' };

  let user: TelegramUser | undefined;
  const userRaw = pairs.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as TelegramUser;
    } catch {
      return { ok: false, reason: 'MALFORMED' };
    }
  }
  if (!user || typeof user.id !== 'number') return { ok: false, reason: 'NO_USER' };

  const data: TelegramInitData = {
    user,
    auth_date: authDateSeconds,
    hash,
    start_param: pairs.get('start_param'),
    chat_instance: pairs.get('chat_instance'),
    chat_type: pairs.get('chat_type'),
    query_id: pairs.get('query_id'),
  };

  return {
    ok: true,
    data,
    user,
    startParam: pairs.get('start_param') ?? null,
    authDate: new Date(authDateSeconds * 1000),
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * TG-004: deep links. `startapp` carries a compact payload that survives
 * Telegram's base64url-ish restrictions (A-Z a-z 0-9 _ -).
 */
export type DeepLinkTarget =
  | { kind: 'product'; id: string }
  | { kind: 'collection'; slug: string }
  | { kind: 'look'; id: string }
  | { kind: 'order'; id: string }
  | { kind: 'campaign'; slug: string }
  | { kind: 'category'; slug: string }
  | { kind: 'brand'; slug: string }
  | { kind: 'stylist'; prompt?: string }
  | { kind: 'home' };

const PREFIXES: Record<string, DeepLinkTarget['kind']> = {
  p: 'product',
  c: 'collection',
  l: 'look',
  o: 'order',
  m: 'campaign',
  g: 'category',
  b: 'brand',
  s: 'stylist',
};

const KINDS: Record<DeepLinkTarget['kind'], string> = {
  product: 'p',
  collection: 'c',
  look: 'l',
  order: 'o',
  campaign: 'm',
  category: 'g',
  brand: 'b',
  stylist: 's',
  home: 'h',
};

export function encodeDeepLink(target: DeepLinkTarget): string {
  switch (target.kind) {
    case 'home':
      return 'h';
    case 'product':
      return `${KINDS.product}_${compact(target.id)}`;
    case 'collection':
      return `${KINDS.collection}_${compact(target.slug)}`;
    case 'look':
      return `${KINDS.look}_${compact(target.id)}`;
    case 'order':
      return `${KINDS.order}_${compact(target.id)}`;
    case 'campaign':
      return `${KINDS.campaign}_${compact(target.slug)}`;
    case 'category':
      return `${KINDS.category}_${compact(target.slug)}`;
    case 'brand':
      return `${KINDS.brand}_${compact(target.slug)}`;
    case 'stylist':
      return target.prompt
        ? `${KINDS.stylist}_${Buffer.from(target.prompt, 'utf8').toString('base64url')}`
        : KINDS.stylist;
  }
}

export function decodeDeepLink(param: string | null | undefined): DeepLinkTarget {
  if (!param || param === 'h') return { kind: 'home' };
  const separator = param.indexOf('_');
  const prefix = separator === -1 ? param : param.slice(0, separator);
  const rest = separator === -1 ? '' : param.slice(separator + 1);
  const kind = PREFIXES[prefix];
  if (!kind) return { kind: 'home' };
  switch (kind) {
    case 'product':
      return { kind: 'product', id: rest };
    case 'collection':
      return { kind: 'collection', slug: rest };
    case 'look':
      return { kind: 'look', id: rest };
    case 'order':
      return { kind: 'order', id: rest };
    case 'campaign':
      return { kind: 'campaign', slug: rest };
    case 'category':
      return { kind: 'category', slug: rest };
    case 'brand':
      return { kind: 'brand', slug: rest };
    case 'stylist':
      if (!rest) return { kind: 'stylist' };
      try {
        return { kind: 'stylist', prompt: Buffer.from(rest, 'base64url').toString('utf8') };
      } catch {
        return { kind: 'stylist' };
      }
    default:
      return { kind: 'home' };
  }
}

/** The in-app route a deep link should land on after authentication. */
export function deepLinkToRoute(target: DeepLinkTarget): string {
  switch (target.kind) {
    case 'product':
      return `/product/${encodeURIComponent(target.id)}`;
    case 'collection':
      return `/collection/${encodeURIComponent(target.slug)}`;
    case 'look':
      return `/stylist/look/${encodeURIComponent(target.id)}`;
    case 'order':
      return `/orders/${encodeURIComponent(target.id)}`;
    case 'campaign':
      return `/campaign/${encodeURIComponent(target.slug)}`;
    case 'category':
      return `/catalog?category=${encodeURIComponent(target.slug)}`;
    case 'brand':
      return `/catalog?brand=${encodeURIComponent(target.slug)}`;
    case 'stylist':
      return target.prompt ? `/stylist?q=${encodeURIComponent(target.prompt)}` : '/stylist';
    case 'home':
    default:
      return '/';
  }
}

function compact(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '');
}

export function buildMiniAppLink(botUsername: string, target: DeepLinkTarget): string {
  const payload = encodeDeepLink(target);
  return `https://t.me/${botUsername}/app?startapp=${payload}`;
}

export function buildBotLink(botUsername: string, target: DeepLinkTarget): string {
  return `https://t.me/${botUsername}?start=${encodeDeepLink(target)}`;
}
