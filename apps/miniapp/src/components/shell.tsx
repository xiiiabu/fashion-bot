'use client';

/**
 * The application shell: the tab bar, the screen header and the in-page bottom
 * bar.
 *
 * Telegram gives us a native BackButton, so the header carries no back chevron
 * inside Telegram — two back affordances on one screen is the sort of thing
 * that makes an app feel like a website in a webview. In a plain browser we
 * draw our own, because there is nothing else.
 */

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';
import { useApp, useT } from '@/lib/app-context';
import {
  BagIcon,
  ChevronLeftIcon,
  HomeIcon,
  IconButton,
  SearchIcon,
  SparkleIcon,
  UserIcon,
  cx,
} from './ui';
import { haptic, isTelegram, showBackButton } from '@/lib/telegram';

const TABS = [
  { href: '/', key: 'nav.home', Icon: HomeIcon, match: (p: string) => p === '/' },
  { href: '/search', key: 'nav.search', Icon: SearchIcon, match: (p: string) => p.startsWith('/search') },
  {
    href: '/stylist',
    key: 'nav.stylist',
    Icon: SparkleIcon,
    match: (p: string) => p.startsWith('/stylist'),
  },
  { href: '/cart', key: 'nav.cart', Icon: BagIcon, match: (p: string) => p.startsWith('/cart') },
  {
    href: '/profile',
    key: 'nav.profile',
    Icon: UserIcon,
    match: (p: string) => p.startsWith('/profile') || p.startsWith('/orders') || p.startsWith('/returns'),
  },
] as const;

/**
 * Screens that replace the tabs entirely with their own primary action. A
 * product page, a checkout and a return request are each a single task: the
 * tabs would invite the shopper to abandon it mid-way.
 *
 * The cart is deliberately NOT here. It is a tab root, so it keeps its tabs and
 * stacks its checkout bar above them (see BottomBar).
 */
const NO_TABS = [/^\/p\//, /^\/checkout/, /^\/onboarding/, /^\/orders\/[^/]+\/return/];

/** Height of the tab bar's own content, excluding the safe-area inset. */
const TAB_BAR_HEIGHT = 60;

function tabsHidden(pathname: string): boolean {
  return NO_TABS.some((pattern) => pattern.test(pathname));
}

export function TabBar() {
  const pathname = usePathname();
  const t = useT();
  const { cartCount } = useApp();

  if (tabsHidden(pathname)) return null;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--line)] bg-[var(--bg-raised)]/92 backdrop-blur-xl"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
      aria-label="Main"
    >
      <ul className="mx-auto flex max-w-screen-sm">
        {TABS.map(({ href, key, Icon, match }) => {
          const active = match(pathname);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                onClick={() => haptic.tap('light')}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'relative flex flex-col items-center gap-1 py-2.5 transition-colors',
                  active ? 'text-[var(--fg)]' : 'text-[var(--fg-faint)]',
                )}
              >
                <span className="relative">
                  <Icon size={21} />
                  {href === '/cart' && cartCount > 0 && (
                    <span className="t-num absolute -right-2 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-[var(--on-accent)]">
                      {cartCount > 99 ? '99+' : cartCount}
                    </span>
                  )}
                </span>
                <span className="text-[10.5px] font-medium tracking-[0.01em]">{t(key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Reserves the space the fixed tab bar covers, so content is never hidden. */
export function TabBarSpacer() {
  const pathname = usePathname();
  if (tabsHidden(pathname)) return null;
  return <div aria-hidden style={{ height: `calc(${TAB_BAR_HEIGHT}px + var(--safe-bottom))` }} />;
}

/**
 * Wires Telegram's native back button to a route. Call it from any screen that
 * is not a tab root: without it, the shopper's back gesture closes the whole
 * Mini App instead of going up one level.
 */
export function useBackButton(to?: string) {
  const router = useRouter();
  useEffect(() => {
    const dispose = showBackButton(() => {
      haptic.tap('light');
      if (to) router.push(to);
      else router.back();
    });
    return dispose;
  }, [router, to]);
}

export function ScreenHeader({
  title,
  eyebrow,
  action,
  back,
  sticky = true,
  large,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
  /** Where the browser-only back chevron goes; inside Telegram it is hidden. */
  back?: string | true;
  sticky?: boolean;
  /** Editorial treatment: a serif title on its own line below the bar. */
  large?: boolean;
}) {
  const router = useRouter();
  const showBack = Boolean(back) && !isTelegram();

  return (
    <header
      className={cx(
        'z-20 bg-[var(--bg)]/92 backdrop-blur-xl',
        sticky && 'sticky top-0',
      )}
      style={{ paddingTop: 'var(--safe-top)' }}
    >
      <div className="flex min-h-[52px] items-center gap-2 px-2.5">
        {showBack && (
          <IconButton
            label="Back"
            className="bg-transparent"
            onClick={() => (typeof back === 'string' ? router.push(back) : router.back())}
          >
            <ChevronLeftIcon />
          </IconButton>
        )}
        <div className={cx('min-w-0 flex-1', !showBack && 'pl-1.5')}>
          {!large && title && (
            <h1 className="truncate text-[16px] font-semibold tracking-[-0.012em]">{title}</h1>
          )}
          {!large && eyebrow && <p className="t-eyebrow truncate">{eyebrow}</p>}
        </div>
        {action && <div className="shrink-0 pr-1">{action}</div>}
      </div>
      {large && (
        <div className="px-4 pb-3 pt-1">
          {eyebrow && <p className="t-eyebrow mb-1.5">{eyebrow}</p>}
          <h1 className="t-title">{title}</h1>
        </div>
      )}
      <div className="h-px bg-[var(--line)]" />
    </header>
  );
}

/**
 * An in-page bar for the one or two primary actions of a screen. Used instead
 * of Telegram's MainButton where a total has to sit next to the action (cart,
 * checkout) — the native button cannot show a price, and a shopper should never
 * tap "Pay" without the amount in the same glance.
 */
export function BottomBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const withTabs = !tabsHidden(pathname);

  // On a screen that keeps its tabs (the cart), this bar sits above them and
  // on a higher layer. Both were `fixed bottom-0 z-30` at first, and since the
  // tab bar is painted later in the tree it silently covered the checkout
  // button: the cart looked complete and could not be checked out.
  return (
    <div
      className={cx(
        'fixed inset-x-0 z-40 border-t border-[var(--line)] bg-[var(--bg-raised)]/95 backdrop-blur-xl',
        className,
      )}
      style={{
        bottom: withTabs ? `calc(${TAB_BAR_HEIGHT}px + var(--safe-bottom))` : 0,
        paddingBottom: withTabs ? 10 : 'calc(var(--safe-bottom) + 10px)',
      }}
    >
      <div className="mx-auto max-w-screen-sm px-4 pt-3">{children}</div>
    </div>
  );
}

/**
 * Reserves the space the fixed bar covers. The tab bar's own space is reserved
 * by TabBarSpacer, so this only accounts for the bar itself.
 */
export function BottomBarSpacer({ height = 84 }: { height?: number }) {
  const pathname = usePathname();
  const withTabs = !tabsHidden(pathname);
  return (
    <div
      aria-hidden
      style={{ height: withTabs ? `${height}px` : `calc(${height}px + var(--safe-bottom))` }}
    />
  );
}

/** The toast stack. Sits above the tab bar, never over the Telegram chrome. */
export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4"
      style={{ bottom: 'calc(var(--safe-bottom) + 150px)' }}
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismissToast(toast.id)}
          className={cx(
            'rise pointer-events-auto max-w-[32ch] rounded-full px-4 py-2.5 text-[13.5px] font-medium shadow-lg',
            toast.kind === 'error'
              ? 'bg-danger text-white'
              : toast.kind === 'success'
                ? 'bg-[var(--fg)] text-[var(--bg)]'
                : 'bg-[var(--fg)] text-[var(--bg)]',
          )}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
