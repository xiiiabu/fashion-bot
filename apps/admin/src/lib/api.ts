/**
 * Operator API client — spec §14.3, ADM-002 (MFA), ADM-003 (RBAC).
 *
 * Differences from the shopper's client that are deliberate:
 *
 *  - No refresh token. An operator session is short and re-authenticating
 *    costs a password and a TOTP code; a long-lived refresh token sitting in a
 *    browser that can approve a payout is a worse trade than a daily login.
 *  - A 403 is surfaced with its code intact, because "you do not have this
 *    permission" and "this is not your tenant" are different answers and the
 *    UI says which (ADM-003, SEL-007).
 *  - Every mutation that moves money or state carries an idempotency key.
 */

import type { ApiError } from '@fashion/core';

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

const TOKEN_KEY = 'atlas.ops.token';
const PRINCIPAL_KEY = 'atlas.ops.principal';

export interface Principal {
  id: string;
  email: string;
  name: string;
  roles: string[];
  kind: 'admin' | 'seller';
  sellerId?: string;
  sellerName?: string;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string;
  readonly details?: Record<string, unknown>;
  readonly allowedTransitions?: string[];

  constructor(status: number, payload: Partial<ApiError>) {
    super(payload.message || `Request failed (${status})`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = payload.code ?? 'INTERNAL';
    this.correlationId = payload.correlationId ?? '';
    this.details = payload.details;
    this.allowedTransitions = payload.allowedTransitions;
  }
}

/* ── Session storage ─────────────────────────────────────────────────────── */

/**
 * sessionStorage: an operator token dies with the tab. A panel that can
 * approve a payout should not be one click away for whoever opens the laptop
 * next.
 */
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null): void {
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
    /* private mode: the in-memory copy carries the tab */
  }
}

export const session = {
  token: () => read(TOKEN_KEY),
  principal(): Principal | null {
    const raw = read(PRINCIPAL_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Principal;
    } catch {
      return null;
    }
  },
  set(token: string, principal: Principal) {
    write(TOKEN_KEY, token);
    write(PRINCIPAL_KEY, JSON.stringify(principal));
  },
  clear() {
    write(TOKEN_KEY, null);
    write(PRINCIPAL_KEY, null);
  },
};

let onSessionLost: (() => void) | null = null;

export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler;
}

/* ── Request ─────────────────────────────────────────────────────────────── */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | string[] | null | undefined>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  anonymous?: boolean;
  /** Returns the raw Response, for CSV and other non-JSON downloads. */
  raw?: boolean;
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
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  const token = session.token();
  if (token && !options.anonymous) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiRequestError(0, { code: 'NETWORK', message: 'Нет связи с API' });
  }

  if (response.status === 401 && !options.anonymous) {
    session.clear();
    onSessionLost?.();
  }

  if (options.raw) {
    if (!response.ok) {
      throw new ApiRequestError(response.status, { code: 'INTERNAL', message: await response.text() });
    }
    return response as unknown as T;
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? safeJson(text) : null;

  if (!response.ok) throw new ApiRequestError(response.status, errorBody(payload));
  return payload as T;
}

/** The API wraps failures as `{ error: { … } }`; a gateway may not. */
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

/** A key per logical action, so a double-click cannot pay a seller twice. */
export function idempotencyKey(scope: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${scope}:${random}`;
}
