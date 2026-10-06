'use client';

/**
 * First launch — spec USR-001 (language), USR-002 (the style quiz) and §12.1
 * (the terms and the privacy policy must be accepted, with the version
 * recorded, before the account is usable).
 *
 * The consent is a real gate: the start button stays disabled until the
 * checkbox is ticked, and the version accepted is whatever the API currently
 * publishes rather than a constant compiled into the app.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LOCALE_LABELS, LOCALES, type Locale } from '@fashion/core';
import { me as meApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { Wordmark } from '@/components/app-frame';
import { Button, Checkbox, cx } from '@/components/ui';
import { haptic } from '@/lib/telegram';

export default function OnboardingPage() {
  const router = useRouter();
  const { locale, setLocale, config, refreshUser, toast } = useApp();
  const t = useT();

  const [accepted, setAccepted] = useState(false);
  const [working, setWorking] = useState(false);

  const start = useCallback(
    async (next: 'style' | 'home') => {
      if (!accepted) {
        haptic.warning();
        toast(t('onboarding.termsRequired'), 'error');
        return;
      }
      setWorking(true);
      try {
        // §12.1: TERMS and PRIVACY are recorded together with the version the
        // API is currently serving, which it attaches server-side.
        await meApi.setConsents([
          { scope: 'TERMS', granted: true },
          { scope: 'PRIVACY', granted: true },
        ]);
        await refreshUser();
        haptic.success();
        router.replace(next === 'style' ? '/profile/style?onboarding=1' : '/');
      } catch (caught) {
        toast(errorMessage(caught, locale), 'error');
      } finally {
        setWorking(false);
      }
    },
    [accepted, refreshUser, router, toast, t, locale],
  );

  return (
    <div
      className="flex min-h-screen flex-col px-6"
      style={{ paddingTop: 'calc(var(--safe-top) + 48px)', paddingBottom: 'calc(var(--safe-bottom) + 24px)' }}
    >
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <Wordmark />
        <h1 className="t-hero mt-9 max-w-[16ch]">{t('onboarding.welcome')}</h1>
        <p className="mt-4 max-w-[34ch] text-[14.5px] leading-relaxed text-[var(--fg-muted)]">
          {t('onboarding.lead')}
        </p>
      </div>

      <div className="space-y-5 pb-2">
        <div>
          <p className="t-eyebrow mb-2.5 text-center">{t('onboarding.pickLanguage')}</p>
          <div className="flex gap-2">
            {LOCALES.map((candidate: Locale) => (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  haptic.select();
                  setLocale(candidate);
                }}
                className={cx(
                  'pressable flex-1 rounded-[var(--radius-md)] border py-3 text-[13.5px] font-medium',
                  candidate === locale
                    ? 'border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)]'
                    : 'border-[var(--line)] bg-[var(--bg-raised)]',
                )}
              >
                {LOCALE_LABELS[candidate]}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-[var(--radius-md)] bg-[var(--bg-raised)] p-3.5">
          <Checkbox
            checked={accepted}
            onChange={setAccepted}
            label={
              <span className="text-[13.5px] leading-snug">
                {t('onboarding.acceptTerms')}
                {config?.consentVersions?.TERMS && (
                  <span className="ml-1 text-[var(--fg-faint)]">({config.consentVersions.TERMS})</span>
                )}
              </span>
            }
          />
        </div>

        <div className="space-y-2.5">
          <Button size="lg" block disabled={!accepted} loading={working} onClick={() => void start('style')}>
            {t('onboarding.setupStyle')}
          </Button>
          <Button variant="ghost" block disabled={!accepted} onClick={() => void start('home')}>
            {t('onboarding.later')}
          </Button>
        </div>
      </div>
    </div>
  );
}
