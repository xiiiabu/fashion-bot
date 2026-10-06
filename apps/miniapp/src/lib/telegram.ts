/**
 * Telegram WebApp bridge — spec §4.1, §7.1, TG-001…TG-006.
 *
 * Written against `window.Telegram.WebApp` directly rather than a wrapper
 * library for two reasons: the surface we actually use is small and stable,
 * and every method here has to degrade to something sensible when the app is
 * opened in a plain browser (which is how it gets developed and demoed). Every
 * call is therefore guarded, and `isTelegram()` tells the UI which world it is
 * in instead of the UI guessing.
 *
 * Nothing in this file trusts `initDataUnsafe` for anything but cosmetics. The
 * session comes from POSTing the signed `initData` to the API, which verifies
 * the HMAC server-side (TG-001). A client cannot verify its own signature.
 */

export type TelegramColorScheme = 'light' | 'dark';

interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  bottom_bar_bg_color?: string;
}

interface TelegramWebAppUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
  is_premium?: boolean;
}

interface TelegramBottomButton {
  text: string;
  color?: string;
  textColor?: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setText(text: string): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  setParams(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
    has_shine_effect?: boolean;
  }): void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: TelegramWebAppUser;
    start_param?: string;
    query_id?: string;
    auth_date?: number;
    hash?: string;
  };
  version: string;
  platform: string;
  colorScheme: TelegramColorScheme;
  themeParams: TelegramThemeParams;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  isActive?: boolean;
  isFullscreen?: boolean;
  headerColor: string;
  backgroundColor: string;
  bottomBarColor?: string;
  isClosingConfirmationEnabled: boolean;
  isVerticalSwipesEnabled?: boolean;
  BackButton: {
    isVisible: boolean;
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
  MainButton: TelegramBottomButton;
  SecondaryButton?: TelegramBottomButton;
  SettingsButton?: {
    isVisible: boolean;
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  CloudStorage?: {
    setItem(key: string, value: string, cb?: (err: string | null, ok?: boolean) => void): void;
    getItem(key: string, cb: (err: string | null, value?: string) => void): void;
    removeItem(key: string, cb?: (err: string | null, ok?: boolean) => void): void;
  };
  ready(): void;
  expand(): void;
  close(): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
  requestFullscreen?(): void;
  exitFullscreen?(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBottomBarColor?(color: string): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  openInvoice?(url: string, cb?: (status: string) => void): void;
  shareToStory?(mediaUrl: string, params?: { text?: string }): void;
  switchInlineQuery?(query: string, chatTypes?: string[]): void;
  showPopup(
    params: {
      title?: string;
      message: string;
      buttons?: Array<{ id?: string; type?: string; text?: string }>;
    },
    cb?: (buttonId: string) => void,
  ): void;
  showAlert(message: string, cb?: () => void): void;
  showConfirm(message: string, cb?: (confirmed: boolean) => void): void;
  showScanQrPopup?(params: { text?: string }, cb?: (data: string) => boolean): void;
  requestWriteAccess?(cb?: (granted: boolean) => void): void;
  requestContact?(cb?: (granted: boolean) => void): void;
  sendData?(data: string): void;
  onEvent(event: string, cb: (...args: unknown[]) => void): void;
  offEvent(event: string, cb: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function webApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/**
 * The SDK loads asynchronously, so a cold start can read `window.Telegram`
 * before the script lands. This waits for it up to `timeoutMs` and then gives
 * up, which is the whole point: a Mini App that blocks forever on telegram.org
 * is worse than one that falls back to a plain browser session.
 *
 * Resolves true when a real Telegram session is present.
 */
export function waitForTelegram(timeoutMs = 2500): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (isTelegram()) return Promise.resolve(true);

  // Outside a Telegram client the script loads but `initData` stays empty, and
  // no amount of waiting changes that. The referrer is the cheap tell: Telegram
  // webviews are opened from the client, never from a typed URL.
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (isTelegram()) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      window.setTimeout(poll, 60);
    };
    poll();
  });
}

export function isTelegram(): boolean {
  const app = webApp();
  // A browser with the script loaded but no initData is not a real session.
  return Boolean(app && typeof app.initData === 'string' && app.initData.length > 0);
}

/** Minimum Bot API version for a feature; Telegram clients lag behind. */
export function supports(minVersion: string): boolean {
  const app = webApp();
  if (!app) return false;
  const current = app.version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const needed = minVersion.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(current.length, needed.length); index += 1) {
    const a = current[index] ?? 0;
    const b = needed[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function initData(): string {
  return webApp()?.initData ?? '';
}

export function startParam(): string | null {
  return webApp()?.initDataUnsafe?.start_param ?? null;
}

export function telegramUser(): TelegramWebAppUser | null {
  return webApp()?.initDataUnsafe?.user ?? null;
}

export function platform(): string {
  return webApp()?.platform ?? 'web';
}

export function colorScheme(): TelegramColorScheme {
  const app = webApp();
  if (app) return app.colorScheme;
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

/**
 * The language Telegram reports, narrowed to what we actually ship. Uzbek is
 * returned as 'uz' for both uz and uz-Cyrl because our UZ copy is Latin
 * (USR-001: RU and UZ-Latin are MUST, EN is SHOULD).
 */
export function telegramLocale(): 'ru' | 'uz' | 'en' | null {
  const code = telegramUser()?.language_code?.toLowerCase();
  if (!code) return null;
  if (code.startsWith('uz')) return 'uz';
  if (code.startsWith('ru') || code.startsWith('kk') || code.startsWith('ky')) return 'ru';
  if (code.startsWith('en')) return 'en';
  return null;
}

/**
 * Called once on mount. Telling Telegram we are ready removes its loading
 * placeholder; expanding takes the full sheet height so the catalogue is not
 * shown through a letterbox. We also pin the header and background to our own
 * palette so the chrome matches the page rather than the chat behind it.
 */
export function initTelegram(onThemeChange: (scheme: TelegramColorScheme) => void): () => void {
  const app = webApp();
  if (!app) {
    // Browser fallback: still honour the OS theme so the dev experience matches.
    if (typeof window === 'undefined') return () => {};
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => onThemeChange(query.matches ? 'dark' : 'light');
    query.addEventListener('change', handler);
    applyViewportVars(window.innerHeight, window.innerHeight, 0, 0);
    const resize = () => applyViewportVars(window.innerHeight, window.innerHeight, 0, 0);
    window.addEventListener('resize', resize);
    return () => {
      query.removeEventListener('change', handler);
      window.removeEventListener('resize', resize);
    };
  }

  app.ready();
  app.expand();
  // A half-swipe down inside a scrollable catalogue would otherwise dismiss the
  // whole Mini App, which loses the shopper's place.
  app.disableVerticalSwipes?.();

  const syncTheme = () => {
    onThemeChange(app.colorScheme);
    const bg = app.colorScheme === 'dark' ? '#121010' : '#faf7f1';
    try {
      app.setBackgroundColor(bg);
      app.setHeaderColor(bg);
      app.setBottomBarColor?.(bg);
    } catch {
      // Older clients reject arbitrary colours; the page still renders.
    }
  };

  const syncViewport = () => {
    const safe = app.contentSafeAreaInset ?? app.safeAreaInset ?? { top: 0, bottom: 0 };
    applyViewportVars(app.viewportHeight, app.viewportStableHeight, safe.top, safe.bottom);
  };

  syncTheme();
  syncViewport();

  app.onEvent('themeChanged', syncTheme);
  app.onEvent('viewportChanged', syncViewport);
  app.onEvent('safeAreaChanged', syncViewport);
  app.onEvent('contentSafeAreaChanged', syncViewport);

  return () => {
    app.offEvent('themeChanged', syncTheme);
    app.offEvent('viewportChanged', syncViewport);
    app.offEvent('safeAreaChanged', syncViewport);
    app.offEvent('contentSafeAreaChanged', syncViewport);
  };
}

function applyViewportVars(height: number, stable: number, safeTop: number, safeBottom: number) {
  const root = document.documentElement;
  root.style.setProperty('--tg-viewport-height', `${height}px`);
  root.style.setProperty('--tg-viewport-stable-height', `${stable}px`);
  root.style.setProperty('--safe-top', `${Math.max(0, safeTop)}px`);
  root.style.setProperty('--safe-bottom', `${Math.max(0, safeBottom)}px`);
}

/* ── Back button ─────────────────────────────────────────────────────────── */

export function showBackButton(handler: () => void): () => void {
  const app = webApp();
  if (!app) return () => {};
  app.BackButton.onClick(handler);
  app.BackButton.show();
  return () => {
    app.BackButton.offClick(handler);
    app.BackButton.hide();
  };
}

export function hideBackButton(): void {
  webApp()?.BackButton.hide();
}

/* ── Main button ─────────────────────────────────────────────────────────── */

export interface MainButtonState {
  text: string;
  visible?: boolean;
  enabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

/**
 * Drives Telegram's native bottom button. We use it for the one primary action
 * of a screen (add to cart, pay, confirm return) because a native button keeps
 * its place above the keyboard and the home indicator, which an in-page button
 * cannot reliably do across clients. Screens that need two equal actions draw
 * their own bar instead — see BottomBar.
 */
export function setMainButton(state: MainButtonState | null): () => void {
  const app = webApp();
  if (!app) return () => {};
  const button = app.MainButton;
  if (!state) {
    button.hide();
    return () => {};
  }
  button.setParams({
    text: state.text,
    is_visible: state.visible ?? true,
    is_active: state.enabled ?? true,
    color: app.colorScheme === 'dark' ? '#d9825a' : '#b05a35',
    text_color: app.colorScheme === 'dark' ? '#17110d' : '#fffaf6',
  });
  if (state.loading) button.showProgress(true);
  else button.hideProgress();
  button.onClick(state.onClick);
  return () => {
    button.offClick(state.onClick);
    button.hide();
    button.hideProgress();
  };
}

/* ── Haptics ─────────────────────────────────────────────────────────────── */

export const haptic = {
  tap(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' = 'light') {
    webApp()?.HapticFeedback.impactOccurred(style);
  },
  success() {
    webApp()?.HapticFeedback.notificationOccurred('success');
  },
  warning() {
    webApp()?.HapticFeedback.notificationOccurred('warning');
  },
  error() {
    webApp()?.HapticFeedback.notificationOccurred('error');
  },
  select() {
    webApp()?.HapticFeedback.selectionChanged();
  },
};

/* ── Dialogs ─────────────────────────────────────────────────────────────── */

export function alert(message: string): Promise<void> {
  const app = webApp();
  if (!app) {
    window.alert(message);
    return Promise.resolve();
  }
  return new Promise((resolve) => app.showAlert(message, () => resolve()));
}

export function confirm(message: string): Promise<boolean> {
  const app = webApp();
  if (!app) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => app.showConfirm(message, (ok) => resolve(Boolean(ok))));
}

/* ── Links ───────────────────────────────────────────────────────────────── */

/** Opens outside the Mini App so the shopper does not lose their session. */
export function openExternal(url: string): void {
  const app = webApp();
  if (!app) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (url.startsWith('https://t.me/') || url.startsWith('tg://')) {
    app.openTelegramLink(url);
    return;
  }
  app.openLink(url);
}

export function closeApp(): void {
  const app = webApp();
  if (app) app.close();
}

/** TG-004: ask once, before the first notification we would send. */
export function requestWriteAccess(): Promise<boolean> {
  const app = webApp();
  if (!app?.requestWriteAccess) return Promise.resolve(false);
  return new Promise((resolve) => app.requestWriteAccess!((granted) => resolve(Boolean(granted))));
}

/**
 * Warn before closing while a checkout is in flight. Leaving a payment
 * half-finished is the one place where losing the webview actually costs the
 * shopper something.
 */
export function setClosingConfirmation(enabled: boolean): void {
  const app = webApp();
  if (!app) return;
  if (enabled) app.enableClosingConfirmation();
  else app.disableClosingConfirmation();
}
