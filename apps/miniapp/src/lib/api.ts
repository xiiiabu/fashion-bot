/**
 * Typed API client — spec §14.3.
 *
 * Three responsibilities beyond `fetch`:
 *  1. The access token is short-lived, so a 401 triggers one refresh and one
 *     retry. Concurrent 401s share a single refresh promise, otherwise a screen
 *     with four parallel requests would burn four refresh tokens and the reuse
 *     detection on the server would revoke the whole chain (SEC-001).
 *  2. Errors arrive as `{ code, message, correlationId }`. We surface them as
 *     `ApiRequestError` with the code intact so a caller can branch on
 *     OUT_OF_STOCK or QUOTE_EXPIRED rather than string-matching a message.
 *  3. Money is `{ amount: string, currency }` all the way to the component. The
 *     client never parses an amount into a Number (CAT-005).
 */

import type { ApiError } from '@fashion/core';

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

const ACCESS_KEY = 'fm.access';
const REFRESH_KEY = 'fm.refresh';
const LOCALE_KEY = 'fm.locale';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string;
  readonly details?: Record<string, unknown>;
  readonly allowedTransitions?: string[];

  constructor(status: number, payload: Partial<ApiError>) {
    super(payload.message || 'Request failed');
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = payload.code ?? 'INTERNAL';
    this.correlationId = payload.correlationId ?? '';
    this.details = payload.details;
    this.allowedTransitions = payload.allowedTransitions;
  }
}

/* ── Token storage ───────────────────────────────────────────────────────── */

/**
 * sessionStorage, not localStorage: a Telegram webview is per-launch anyway, and
 * a token that outlives the launch is a token that can be read later by anything
 * else served from this origin. The refresh token re-mints a session on the next
 * launch from initData, so nothing is lost.
 */
const memory = new Map<string, string>();

function readStore(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeStore(key: string, value: string | null) {
  if (value === null) {
    memory.delete(key);
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* private mode */
    }
    return;
  }
  memory.set(key, value);
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* private mode: the in-memory copy carries the launch */
  }
}

export const tokens = {
  access: () => readStore(ACCESS_KEY),
  refresh: () => readStore(REFRESH_KEY),
  set(accessToken: string, refreshToken: string) {
    writeStore(ACCESS_KEY, accessToken);
    writeStore(REFRESH_KEY, refreshToken);
  },
  clear() {
    writeStore(ACCESS_KEY, null);
    writeStore(REFRESH_KEY, null);
  },
  hasSession: () => Boolean(readStore(ACCESS_KEY)),
};

export const localePref = {
  get(): 'ru' | 'uz' | 'en' | null {
    const value = readStore(LOCALE_KEY);
    return value === 'ru' || value === 'uz' || value === 'en' ? value : null;
  },
  set(locale: 'ru' | 'uz' | 'en') {
    writeStore(LOCALE_KEY, locale);
    try {
      window.localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      /* ignore */
    }
  },
  remembered(): 'ru' | 'uz' | 'en' | null {
    try {
      const value = window.localStorage.getItem(LOCALE_KEY);
      return value === 'ru' || value === 'uz' || value === 'en' ? value : null;
    } catch {
      return null;
    }
  },
};

/* ── Refresh coordination ────────────────────────────────────────────────── */

let refreshInFlight: Promise<boolean> | null = null;
let onSessionLost: (() => void) | null = null;

export function setSessionLostHandler(handler: (() => void) | null) {
  onSessionLost = handler;
}

async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = tokens.refresh();
  if (!refreshToken) return false;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        tokens.clear();
        return false;
      }
      const data = (await response.json()) as { accessToken: string; refreshToken: string };
      tokens.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see it.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

/* ── Request ─────────────────────────────────────────────────────────────── */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | string[] | null | undefined>;
  /** ORD-006: a replayed POST must not create a second order. */
  idempotencyKey?: string;
  locale?: string;
  signal?: AbortSignal;
  /** Skip the bearer token (used by the auth endpoints themselves). */
  anonymous?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value)) {
        if (value.length > 0) url.searchParams.set(key, value.join(','));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'accept-language': options.locale ?? localePref.get() ?? 'ru',
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const access = tokens.access();
    if (access && !options.anonymous) headers.authorization = `Bearer ${access}`;

    return fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  };

  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiRequestError(0, {
      code: 'NETWORK',
      message: 'Нет связи с сервером. Проверьте интернет.',
    });
  }

  if (response.status === 401 && !options.anonymous) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await send();
    } else {
      tokens.clear();
      onSessionLost?.();
    }
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? safeJson(text) : null;

  if (!response.ok) {
    throw new ApiRequestError(response.status, errorBody(payload));
  }

  return payload as T;
}

/**
 * The API's exception filter wraps failures as `{ error: { code, message,
 * correlationId, details } }`. Reading the outer object directly meant every
 * error arrived as code 'INTERNAL' with a generic message, so OUT_OF_STOCK and
 * QUOTE_EXPIRED were indistinguishable from a server fault and the UI could
 * not recover from either. Both shapes are accepted, since a proxy or a
 * gateway in front of the API may produce the flat one.
 */
function errorBody(payload: unknown): Partial<ApiError> {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === 'object') return nested as Partial<ApiError>;
  return record as Partial<ApiError>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** A stable key per logical action, so a double-tap cannot double-charge. */
export function idempotencyKey(scope: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${scope}:${random}`;
}
