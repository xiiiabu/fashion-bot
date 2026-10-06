'use client';

/**
 * Operator session and app state.
 *
 * The session is a password plus a TOTP code (ADM-002), held in sessionStorage
 * so it dies with the tab. There is no refresh token: an operator panel that
 * can approve a payout should not keep itself signed in.
 *
 * `can()` is the UI's half of RBAC (ADM-003). It hides what the operator may
 * not do, so the panel is honest about their role — but it is only the UI's
 * half: the API denies by default and is the thing that actually enforces it.
 * A permission check here is a courtesy, never a control.
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
import type { Permission } from '@fashion/core';
import { ApiRequestError, session, setSessionLostHandler, type Principal } from './api';
import { auth } from './endpoints';
import type { Toast } from '@/components/ui';

interface AppContextValue {
  principal: Principal | null;
  permissions: string[];
  ready: boolean;
  /**
   * ADM-003. The argument is core's `Permission` union, not a string, so a
   * permission the API does not define fails to compile instead of quietly
   * hiding a screen from everyone — which is how a typo in a permission name
   * becomes a feature nobody can reach.
   */
  can: (permission: Permission) => boolean;
  isSeller: boolean;
  signIn: (principal: Principal, token: string, permissions: string[]) => void;
  signOut: () => Promise<void>;
  toast: (message: string, tone?: Toast['tone']) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

const THEME_KEY = 'atlas.ops.theme';

export function AppProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const toastId = useRef(0);

  /* ── Theme ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_KEY);
    } catch {
      /* private mode */
    }
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = stored === 'dark' || stored === 'light' ? stored : prefersDark ? 'dark' : 'light';
    setTheme(resolved);
    document.documentElement.dataset.theme = resolved;
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);

  /* ── Toasts ────────────────────────────────────────────────────────────── */

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: Toast['tone'] = 'info') => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((current) => [...current.slice(-3), { id, message, tone }]);
      // An error stays long enough to be read and copied; a confirmation does not.
      window.setTimeout(() => dismissToast(id), tone === 'error' ? 7000 : 3000);
    },
    [dismissToast],
  );

  /* ── Session ───────────────────────────────────────────────────────────── */

  const signOut = useCallback(async () => {
    await auth.logout();
    setPrincipal(null);
    setPermissions([]);
  }, []);

  const signIn = useCallback((next: Principal, token: string, grants: string[]) => {
    session.set(token, next);
    setPrincipal(next);
    setPermissions(grants);
  }, []);

  /* Restore a session on reload, and verify it is still good. */
  useEffect(() => {
    const stored = session.principal();
    if (!stored || !session.token()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    auth
      .me()
      .then((me) => {
        if (cancelled) return;
        setPrincipal({
          id: me.id,
          email: me.email,
          name: stored.name,
          roles: me.roles,
          kind: me.kind,
          sellerId: me.sellerId,
          sellerName: me.sellerName ?? stored.sellerName,
        });
        setPermissions(me.permissions);
      })
      .catch((error) => {
        if (cancelled) return;
        // Anything but an auth failure leaves the stored session alone: a
        // flaky network should not sign an operator out mid-task.
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
          session.clear();
          setPrincipal(null);
        } else {
          setPrincipal(stored);
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSessionLostHandler(() => {
      setPrincipal(null);
      setPermissions([]);
    });
    return () => setSessionLostHandler(null);
  }, []);

  /* ── Permissions (ADM-003) ─────────────────────────────────────────────── */

  const can = useCallback(
    (permission: Permission) => {
      if (permissions.length === 0) return false;
      if (permissions.includes('*') || permissions.includes('*:*')) return true;
      if (permissions.includes(permission)) return true;
      const [object] = permission.split(':');
      return permissions.includes(`${object}:*`);
    },
    [permissions],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      principal,
      permissions,
      ready,
      can,
      isSeller: principal?.kind === 'seller',
      signIn,
      signOut,
      toast,
      toasts,
      dismissToast,
      theme,
      toggleTheme,
    }),
    [principal, permissions, ready, can, signIn, signOut, toast, toasts, dismissToast, theme, toggleTheme],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Turns anything thrown into a sentence an operator can act on. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const known: Record<string, string> = {
      FORBIDDEN: 'Недостаточно прав для этого действия',
      UNAUTHENTICATED: 'Сессия истекла — войдите снова',
      VALIDATION_FAILED: 'Проверьте заполненные поля',
      CONFLICT: 'Состояние изменилось — обновите страницу',
      ILLEGAL_STATE_TRANSITION: 'Такой переход статуса недопустим',
      IDEMPOTENCY_CONFLICT: 'Повторный запрос с другими данными',
      RATE_LIMITED: 'Слишком много запросов — подождите',
      NETWORK: 'Нет связи с API',
    };
    const base = known[error.code] ?? error.message;
    // The correlation id is what support will ask for, so it is in the message
    // rather than only in a console nobody will open.
    return error.correlationId ? `${base} · ${error.correlationId.slice(0, 8)}` : base;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Что-то пошло не так';
}
