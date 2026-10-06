'use client';

/**
 * Profile hub. The shopper's own data and the entry point to everything that is
 * not shopping: orders, returns, the style and fit profiles, the privacy centre
 * (USR-003/USR-006) and support.
 *
 * The language switcher is here rather than buried, because for a RU/UZ/EN
 * market the first thing a shopper may need to change is the language the app
 * guessed from Telegram (USR-001).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LOCALE_LABELS, LOCALES, type Locale } from '@fashion/core';
import { API_BASE } from '@/lib/api';
import { auth, notifications as notificationsApi } from '@/lib/endpoints';
import { useApp, useT } from '@/lib/app-context';
import { mediaUrl } from '@/lib/format';
import { ScreenHeader } from '@/components/shell';
import {
  BagIcon,
  Badge,
  ChatIcon,
  GlobeIcon,
  HeartIcon,
  HelpIcon,
  PinIcon,
  ReturnIcon,
  Row,
  RowGroup,
  RulerIcon,
  Section,
  Sheet,
  ShieldIcon,
  SparkleIcon,
  cx,
} from '@/components/ui';
import { confirm, haptic, hideBackButton, openExternal } from '@/lib/telegram';

export default function ProfilePage() {
  const router = useRouter();
  const { user, locale, setLocale, config, cartCount } = useApp();
  const t = useT();
  const [languageSheet, setLanguageSheet] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    hideBackButton();
    notificationsApi
      .list()
      .then((data) => setUnread(data.unread))
      .catch(() => {});
  }, []);

  const avatar = mediaUrl(user?.photoUrl, API_BASE);

  return (
    <div className="pb-6">
      <ScreenHeader title={t('profile.title')} />

      {/* ── Identity ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3.5 px-4 pt-5">
        <div className="h-[58px] w-[58px] shrink-0 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="t-display flex h-full w-full items-center justify-center text-[1.4rem] text-[var(--fg-muted)]">
              {(user?.firstName ?? '?').charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold">{user?.firstName ?? t('profile.guest')}</p>
          {user?.username && (
            <p className="truncate text-[13px] text-[var(--fg-faint)]">@{user.username}</p>
          )}
          {user?.phone && <p className="t-num truncate text-[12.5px] text-[var(--fg-faint)]">{user.phone}</p>}
        </div>
      </div>

      {/* A glanceable summary, each number a link to the thing it counts. */}
      <div className="mt-5 grid grid-cols-3 gap-2.5 px-4">
        <StatTile
          label={t('profile.orders')}
          value={user?.stats.orders ?? 0}
          onClick={() => router.push('/orders')}
        />
        <StatTile
          label={t('profile.wishlist')}
          value={user?.stats.wishlist ?? 0}
          onClick={() => router.push('/wishlist')}
        />
        <StatTile label={t('nav.cart')} value={cartCount} onClick={() => router.push('/cart')} />
      </div>

      {/* ── Personalisation ───────────────────────────────────────────── */}
      <Section title={t('profile.style')} className="pt-7">
        <RowGroup>
          <Row
            icon={<SparkleIcon size={17} />}
            title={t('profile.style')}
            hint={t('profile.styleHint')}
            trailing={user?.styleProfile?.completedAt ? '✓' : undefined}
            onClick={() => router.push('/profile/style')}
          />
          <Row
            icon={<RulerIcon size={17} />}
            title={t('profile.fit')}
            hint={
              user?.fitProfile?.consentPersonalizedFit === false
                ? t('fit.consentOff')
                : t('profile.fitHint')
            }
            trailing={user?.fitProfile?.updatedAt ? '✓' : undefined}
            onClick={() => router.push('/profile/fit')}
          />
          <Row
            icon={<PinIcon size={17} />}
            title={t('profile.addresses')}
            onClick={() => router.push('/profile/addresses')}
          />
        </RowGroup>
      </Section>

      {/* ── Orders & returns ──────────────────────────────────────────── */}
      <Section>
        <RowGroup>
          <Row
            icon={<BagIcon size={17} />}
            title={t('profile.orders')}
            onClick={() => router.push('/orders')}
          />
          <Row
            icon={<ReturnIcon size={17} />}
            title={t('profile.returns')}
            onClick={() => router.push('/returns')}
          />
          <Row
            icon={<HeartIcon size={17} />}
            title={t('profile.wishlist')}
            onClick={() => router.push('/wishlist')}
          />
        </RowGroup>
      </Section>

      {/* ── Settings ──────────────────────────────────────────────────── */}
      <Section>
        <RowGroup>
          <Row
            icon={<GlobeIcon size={17} />}
            title={t('profile.language')}
            trailing={LOCALE_LABELS[locale]}
            onClick={() => setLanguageSheet(true)}
          />
          <Row
            icon={<ShieldIcon size={17} />}
            title={t('profile.privacy')}
            onClick={() => router.push('/profile/privacy')}
          />
          <Row
            icon={<ChatIcon size={17} />}
            title={t('profile.support')}
            trailing={unread > 0 ? <Badge tone="accent">{unread}</Badge> : undefined}
            onClick={() => router.push('/support')}
          />
          <Row
            icon={<HelpIcon size={17} />}
            title={t('profile.faq')}
            onClick={() => router.push('/support/faq')}
          />
        </RowGroup>
      </Section>

      {/* ── Legal (§12.1: the documents have to be reachable) ─────────── */}
      <Section>
        <RowGroup>
          <Row title={t('profile.terms')} onClick={() => router.push('/pages/terms')} />
          <Row title={t('profile.privacyPolicy')} onClick={() => router.push('/pages/privacy')} />
          <Row title={t('profile.offer')} onClick={() => router.push('/pages/offer')} />
          <Row title={t('profile.about')} onClick={() => router.push('/pages/about')} />
        </RowGroup>
      </Section>

      {config?.botUsername && (
        <div className="px-4 pt-2">
          <RowGroup>
            <Row
              title={t('support.openInBot')}
              hint={`@${config.botUsername}`}
              onClick={() => openExternal(`https://t.me/${config.botUsername}`)}
            />
          </RowGroup>
        </div>
      )}

      <Section>
        <RowGroup>
          <Row
            title={t('profile.logout')}
            danger
            onClick={async () => {
              if (!(await confirm(t('profile.logout')))) return;
              await auth.logout();
              window.location.reload();
            }}
          />
        </RowGroup>
      </Section>

      <p className="px-4 pt-2 text-center text-[11px] text-[var(--fg-faint)]">
        Atlas · Tashkent
        {config && !config.paymentsLive && ` · ${t('checkout.sandboxPay')}`}
      </p>

      {/* ── Language ──────────────────────────────────────────────────── */}
      <Sheet open={languageSheet} onClose={() => setLanguageSheet(false)} title={t('profile.language')}>
        <div className="space-y-1 pb-2">
          {LOCALES.map((candidate: Locale) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                haptic.select();
                setLocale(candidate);
                setLanguageSheet(false);
              }}
              className={cx(
                'flex w-full items-center justify-between rounded-[var(--radius-md)] px-3.5 py-3.5 text-left text-[15px]',
                candidate === locale ? 'bg-[var(--accent-soft)] font-semibold' : 'active:bg-[var(--bg-sunken)]',
              )}
            >
              {LOCALE_LABELS[candidate]}
              {candidate === locale && <span className="text-[var(--accent)]">✓</span>}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function StatTile({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic.tap('light');
        onClick();
      }}
      className="pressable rounded-[var(--radius-md)] bg-[var(--bg-raised)] px-3 py-3.5 text-left"
    >
      <p className="t-num text-[20px] font-semibold leading-none">{value}</p>
      <p className="mt-1.5 truncate text-[11.5px] text-[var(--fg-muted)]">{label}</p>
    </button>
  );
}
