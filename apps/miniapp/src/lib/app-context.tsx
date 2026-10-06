'use client';

/**
 * Application context: the session, the locale, the cart badge and toasts.
 *
 * Authentication happens exactly once, on mount, in this order:
 *   1. If we are inside Telegram, POST the signed initData (TG-001).
 *   2. Otherwise, if the API says dev auth is enabled, use the shared secret so
 *      the app can be opened in a plain browser during development.
 *   3. Otherwise show the "open me in Telegram" screen. We never pretend to
 *      have a session we do not have — a guest cart would be a lie, because the
 *      server reserves stock against a user.
 *
 * The locale resolves as: what the shopper chose > what the API has stored >
 * what Telegram reports > RU (the market lingua franca).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Locale, MeView } from '@fashion/core';
import { ApiRequestError, localePref, setSessionLostHandler, tokens } from './api';
import { auth, cart as cartApi, me as meApi, type AuthConfig } from './endpoints';
import { t } from './copy';
import * as tg from './telegram';

export type AuthState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'needs-telegram'; botUsername: string | null }
  | { status: 'error'; message: string };

interface AppContextValue {
  authState: AuthState;
  config: AuthConfig | null;
  user: MeView | null;
  locale: Locale;
  setLocale: (locale: Locale) => void | Promise<void>;
  /** Reload /me, e.g. after changing a consent. */
  refreshUser: () => Promise<void>;
  cartCount: number;
  setCartCount: (count: number) => void;
  refreshCartCount: () => Promise<void>;
  /** Deep-link route from the bot's /start payload (TG-002), consumed once. */
  startRoute: string | null;
  consumeStartRoute: () => string | null;
  toast: (message: string, kind?: ToastKind) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  theme: 'light' | 'dark';
  /** Translate with the current locale already bound. */
  tr: (key: string, params?: Record<string, string | number>) => string;
  retryAuth: () => void;
}

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

/** Locale-bound translator, which is what screens actually want. */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  return useApp().tr;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({ status: 'loading' });
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [user, setUser] = useState<MeView | null>(null);
  const [locale, setLocaleState] = useState<Locale>(
    () => localePref.remembered() ?? 'ru',
  );
  const [cartCount, setCartCount] = useState(0);
  const [startRoute, setStartRoute] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [attempt, setAttempt] = useState(0);
  const toastId = useRef(0);

  /* ── Theme and Telegram chrome ─────────────────────────────────────────── */

  useEffect(() => {
    const dispose = tg.initTelegram((scheme) => {
      setTheme(scheme);
      document.documentElement.dataset.theme = scheme;
    });
    setTheme(tg.colorScheme());
    document.documentElement.dataset.theme = tg.colorScheme();
    return dispose;
  }, []);

  /* ── Toasts ────────────────────────────────────────────────────────────── */

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((current) => [...current.slice(-2), { id, message, kind }]);
      if (kind === 'error') tg.haptic.error();
      else if (kind === 'success') tg.haptic.success();
      window.setTimeout(() => dismissToast(id), kind === 'error' ? 5000 : 2600);
    },
    [dismissToast],
  );

  /* ── Sign-in ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setAuthState({ status: 'loading' });
      let authConfig: AuthConfig | null = null;
      try {
        authConfig = await auth.config();
        if (cancelled) return;
        setConfig(authConfig);
      } catch (error) {
        if (cancelled) return;
        setAuthState({
          status: 'error',
          message:
            error instanceof ApiRequestError && error.code === 'NETWORK'
              ? t(locale, 'err.NETWORK')
              : t(locale, 'common.error'),
        });
        return;
      }

      // An existing session survives a client-side navigation or a reload
      // within the same launch, so do not mint a second one.
      if (tokens.hasSession()) {
        try {
          const profile = await meApi.get();
          if (cancelled) return;
          applySession(profile, null);
          return;
        } catch {
          tokens.clear();
        }
      }

      try {
        // The SDK loads async, so give it a moment before concluding that this
        // is a plain browser rather than a Telegram webview.
        const inTelegram = await tg.waitForTelegram();
        if (inTelegram) {
          const session = await auth.telegram(tg.initData(), tg.platform());
          if (cancelled) return;
          tokens.set(session.accessToken, session.refreshToken);
          const resolved = localePref.remembered() ?? session.locale;
          localePref.set(resolved);
          setLocaleState(resolved);
          const profile = await meApi.get();
          if (cancelled) return;
          applySession(profile, session.startRoute ?? deepLinkFromStartParam());
          return;
        }

        if (authConfig.devAuthEnabled) {
          const session = await auth.dev(localePref.remembered() ?? undefined);
          if (cancelled) return;
          tokens.set(session.accessToken, session.refreshToken);
          const profile = await meApi.get();
          if (cancelled) return;
          applySession(profile, null);
          return;
        }

        if (cancelled) return;
        setAuthState({ status: 'needs-telegram', botUsername: authConfig.botUsername });
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof ApiRequestError
            ? t(locale, `err.${error.code}`) || error.message
            : t(locale, 'common.error');
        setAuthState({ status: 'error', message });
      }
    }

    function applySession(profile: MeView, route: string | null) {
      setUser(profile);
      const resolved = localePref.remembered() ?? profile.locale;
      localePref.set(resolved);
      setLocaleState(resolved);
      setCartCount(profile.stats?.cartItems ?? 0);
      if (route) setStartRoute(route);
      setAuthState({ status: 'ready' });
    }

    void boot();
    return () => {
      cancelled = true;
    };
    // `locale` is read only for an error message; re-running on a locale change
    // would re-authenticate the shopper mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  /** A refresh token that no longer works means the launch is over. */
  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null);
      setAuthState({ status: 'needs-telegram', botUsername: config?.botUsername ?? null });
    });
    return () => setSessionLostHandler(null);
  }, [config?.botUsername]);

  /* ── Actions ───────────────────────────────────────────────────────────── */

  const refreshUser = useCallback(async () => {
    try {
      const profile = await meApi.get();
      setUser(profile);
      setCartCount(profile.stats?.cartItems ?? 0);
    } catch {
      /* a failed refresh leaves the previous view in place */
    }
  }, []);

  const refreshCartCount = useCallback(async () => {
    try {
      const { count } = await cartApi.count();
      setCartCount(count);
    } catch {
      /* the badge is not worth an error toast */
    }
  }, []);

  const setLocale = useCallback(
    async (next: Locale) => {
      // The UI switches immediately; the server call only persists the choice.
      localePref.set(next);
      setLocaleState(next);
      document.documentElement.lang = next;
      try {
        // USR-001: stored server-side so the bot's messages arrive in the same
        // language. The response carries only `{ locale }`, so the user object
        // is re-read rather than replaced with it — assigning that response to
        // the user state erased `consents` and bounced the shopper back to the
        // onboarding screen for changing their language.
        await meApi.setLocale(next);
        await refreshUser();
      } catch {
        // A failed save leaves the UI in the chosen language for this launch;
        // the preference is remembered locally either way.
      }
    },
    [refreshUser],
  );

  const consumeStartRoute = useCallback(() => {
    const route = startRoute;
    if (route) setStartRoute(null);
    return route;
  }, [startRoute]);

  const tr = useCallback(
    (key: string, params?: Record<string, string | number>) => t(locale, key, params),
    [locale],
  );

  const retryAuth = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<AppContextValue>(
    () => ({
      authState,
      config,
      user,
      locale,
      setLocale,
      refreshUser,
      cartCount,
      setCartCount,
      refreshCartCount,
      startRoute,
      consumeStartRoute,
      toast,
      toasts,
      dismissToast,
      theme,
      tr,
      retryAuth,
    }),
    [
      authState,
      config,
      user,
      locale,
      setLocale,
      refreshUser,
      cartCount,
      refreshCartCount,
      startRoute,
      consumeStartRoute,
      toast,
      toasts,
      dismissToast,
      theme,
      tr,
      retryAuth,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/**
 * TG-002: the bot's deep link carries where to land. The server already decodes
 * it for us during Telegram sign-in; this is the fallback for a cold open where
 * the Mini App was launched with a start_param directly.
 */
function deepLinkFromStartParam(): string | null {
  const param = tg.startParam();
  if (!param) return null;
  // The encoding is `kind_id`, e.g. `product_abc123` or `order_FM-261006-0005`.
  const separator = param.indexOf('_');
  if (separator < 1) return null;
  const kind = param.slice(0, separator);
  const id = param.slice(separator + 1);
  if (!id) return null;
  switch (kind) {
    case 'product':
      return `/p/${encodeURIComponent(id)}`;
    case 'order':
      return `/orders/${encodeURIComponent(id)}`;
    case 'look':
      return `/looks/${encodeURIComponent(id)}`;
    case 'brand':
      return `/brands/${encodeURIComponent(id)}`;
    case 'category':
      return `/search?category=${encodeURIComponent(id)}`;
    case 'stylist':
      return `/stylist?q=${encodeURIComponent(id)}`;
    case 'return':
      return `/returns/${encodeURIComponent(id)}`;
    case 'cart':
      return '/cart';
    default:
      return null;
  }
}

/**
 * Turns any thrown value into a sentence worth showing. Stable API codes get a
 * localised message; anything else falls back to the server's own text, which
 * is already localised by the API's exception filter (§14.3).
 */
export function errorMessage(error: unknown, locale: Locale): string {
  if (error instanceof ApiRequestError) {
    const localised = t(locale, `err.${error.code}`);
    if (localised !== `err.${error.code}`) return localised;
    return error.message || t(locale, 'common.error');
  }
  if (error instanceof Error && error.message) return error.message;
  return t(locale, 'common.error');
}
