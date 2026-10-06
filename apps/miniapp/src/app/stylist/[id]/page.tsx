'use client';

/**
 * A saved look from the stylist's history — spec AI-005. Opening an old look
 * re-reads it from the server rather than from a cache, because its items'
 * prices and stock may have moved since it was generated: a look that can no
 * longer be bought has to say so rather than quote yesterday's total.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { OutfitView } from '@fashion/core';
import { ai, stylistRefusal, type StylistRefusal } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { money } from '@/lib/format';
import { OutfitDisplay } from '@/components/outfit';
import { BottomBar, BottomBarSpacer, ScreenHeader, useBackButton } from '@/components/shell';
import { Button, EmptyState, ErrorState, LoadingScreen } from '@/components/ui';
import { haptic } from '@/lib/telegram';

export default function SavedOutfitPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { locale, refreshCartCount, toast } = useApp();
  const t = useT();
  useBackButton('/stylist');

  const [outfit, setOutfit] = useState<OutfitView | null>(null);
  const [refusal, setRefusal] = useState<StylistRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOutfit(await ai.outfit(params.id));
    } catch (caught) {
      // A saved look can stop being buildable: its items may have sold out or
      // been unpublished since. The engine says so, and that is not an error.
      const reason = stylistRefusal(caught);
      if (reason) setRefusal(reason);
      else setError(errorMessage(caught, locale));
    }
  }, [params.id, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const addAll = useCallback(async () => {
    if (!outfit) return;
    setAdding(true);
    try {
      await ai.addToCart(outfit.id);
      await refreshCartCount();
      haptic.success();
      toast(t('ai.addedAll'), 'success');
      router.push('/cart');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setAdding(false);
    }
  }, [outfit, refreshCartCount, toast, t, locale, router]);

  if (error) {
    return (
      <div>
        <ScreenHeader back="/stylist" title={t('ai.title')} />
        <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (refusal) {
    return (
      <div>
        <ScreenHeader back="/stylist" title={t('ai.title')} />
        <EmptyState
          title={t('ai.failNoCombo')}
          body={refusal.detail || t('ai.failHint')}
          action={
            <Button variant="outline" onClick={() => router.push('/stylist')}>
              {t('ai.tryAgain')}
            </Button>
          }
        />
      </div>
    );
  }

  if (!outfit) {
    return (
      <div>
        <ScreenHeader back="/stylist" title={t('ai.title')} />
        <LoadingScreen />
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader back="/stylist" title={t('ai.title')} eyebrow={outfit.intent.rawQuery} />
      <OutfitDisplay outfit={outfit} />
      <BottomBarSpacer height={82} />
      <BottomBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="t-price text-[16px]">{money(outfit.total, locale)}</p>
            <p className="truncate text-[11.5px] text-[var(--fg-faint)]">
              {t('ai.sellers', { n: outfit.sellerCount })}
            </p>
          </div>
          <Button size="lg" className="min-w-[52%]" loading={adding} onClick={addAll}>
            {t('ai.addAll')}
          </Button>
        </div>
      </BottomBar>
    </div>
  );
}
