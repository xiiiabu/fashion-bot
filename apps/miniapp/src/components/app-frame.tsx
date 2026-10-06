'use client';

/**
 * The authentication gate and the frame everything renders inside.
 *
 * Three states the shopper can actually be in:
 *  - signing in (we hold a branded splash rather than flashing an empty shell);
 *  - signed in (the app);
 *  - not in Telegram and dev auth is off, so there is no honest way to sign in.
 *
 * The third case is a real screen, not an error: this app is a Telegram Mini
 * App and opening its URL in a desktop browser is a reasonable thing to have
 * done by accident. We say where to go instead of showing a broken page.
 */

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useApp, useT } from '@/lib/app-context';
import { TabBar, TabBarSpacer, ToastStack } from './shell';
import { Button, Spinner } from './ui';
import { openExternal } from '@/lib/telegram';

export function AppFrame({ children }: { children: ReactNode }) {
  const { authState, retryAuth, startRoute, consumeStartRoute, user } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();

  // TG-002: land on whatever the bot's deep link pointed at, once.
  useEffect(() => {
    if (authState.status !== 'ready' || !startRoute) return;
    const route = consumeStartRoute();
    if (route) router.replace(route);
  }, [authState.status, startRoute, consumeStartRoute, router]);

  /**
   * §12.1: the terms and the privacy policy have to be accepted before the
   * account is usable, so a session without that record goes to onboarding.
   * A legal document is only reachable from there, otherwise the shopper would
   * be asked to accept something they cannot read.
   */
  const needsOnboarding =
    authState.status === 'ready' && user !== null && !user.consents?.TERMS?.granted;

  useEffect(() => {
    if (!needsOnboarding) return;
    if (pathname === '/onboarding' || pathname.startsWith('/pages/')) return;
    router.replace('/onboarding');
  }, [needsOnboarding, pathname, router]);

  if (authState.status === 'loading') return <Splash />;

  if (authState.status === 'error') {
    return (
      <Gate
        title={t('common.error')}
        body={authState.message}
        action={
          <Button onClick={retryAuth} variant="outline">
            {t('common.retry')}
          </Button>
        }
      />
    );
  }

  if (authState.status === 'needs-telegram') {
    const link = authState.botUsername ? `https://t.me/${authState.botUsername}` : null;
    return (
      <Gate
        title="Atlas"
        body={t('onboarding.lead')}
        action={
          link ? (
            <Button onClick={() => openExternal(link)}>Открыть в Telegram</Button>
          ) : (
            <Button onClick={retryAuth} variant="outline">
              {t('common.retry')}
            </Button>
          )
        }
      />
    );
  }

  // Onboarding and the legal documents it links to are full-bleed: no tab bar
  // under a screen whose only job is to be read and agreed to.
  const bare = pathname === '/onboarding' || (needsOnboarding && pathname.startsWith('/pages/'));

  if (bare) {
    return (
      <div className="mx-auto min-h-screen max-w-screen-sm">
        {children}
        <ToastStack />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-screen-sm flex-col">
      <main className="flex-1">{children}</main>
      <TabBarSpacer />
      <TabBar />
      <ToastStack />
    </div>
  );
}

/**
 * The splash is a wordmark, not a spinner on an empty page: the Mini App opens
 * over the chat and the first frame is what tells the shopper the tap worked.
 */
function Splash() {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-7 px-8"
      style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
    >
      <Wordmark />
      <Spinner size={18} className="text-[var(--fg-faint)]" />
    </div>
  );
}

function Gate({ title, body, action }: { title: string; body: string; action: ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-5 px-8 text-center"
      style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
    >
      <Wordmark />
      <div>
        <h1 className="t-title">{title}</h1>
        <p className="mx-auto mt-2.5 max-w-[32ch] text-[14px] leading-relaxed text-[var(--fg-muted)]">
          {body}
        </p>
      </div>
      <div className="mt-2">{action}</div>
    </div>
  );
}

export function Wordmark({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  return (
    <div className="rise flex flex-col items-center">
      <span
        className={cxWordmark(size)}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Atlas
      </span>
      <span className="mt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.34em] text-[var(--fg-faint)]">
        Tashkent
      </span>
    </div>
  );
}

function cxWordmark(size: 'sm' | 'lg'): string {
  return size === 'lg'
    ? 'text-[2.6rem] leading-none tracking-[-0.03em]'
    : 'text-[1.35rem] leading-none tracking-[-0.025em]';
}
