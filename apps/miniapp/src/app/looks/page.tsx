'use client';

/**
 * Curated looks — spec ADM-009. These are merchandiser-assembled outfits, not
 * AI-generated ones: the distinction matters because a curated look is a
 * promise the shop made, and the stylist's look is a suggestion.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { catalog, type LookSummary } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { money } from '@/lib/format';
import { ProductImage } from '@/components/product';
import { ScreenHeader, useBackButton } from '@/components/shell';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { styleLabel } from '@/lib/taxonomy-labels';
import { haptic } from '@/lib/telegram';

export default function LooksPage() {
  const { locale } = useApp();
  const t = useT();
  useBackButton('/');

  const [items, setItems] = useState<LookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await catalog.looks(40);
      setItems(data.items);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="pb-6">
      <ScreenHeader back="/" title={t('home.looks')} />

      {error && <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />}

      {!items && !error && (
        <div className="space-y-5 px-4 pt-4">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="aspect-[4/3] w-full rounded-[var(--radius-lg)]" />
          ))}
        </div>
      )}

      {items && items.length === 0 && <EmptyState title={t('common.empty')} />}

      {items && items.length > 0 && (
        <div className="space-y-6 px-4 pt-4">
          {items.map((look) => (
            <Link
              key={look.id}
              href={`/looks/${look.slug || look.id}`}
              onClick={() => haptic.tap('light')}
              className="pressable block"
            >
              <div className="relative overflow-hidden rounded-[var(--radius-lg)]">
                {/* A grid of the actual garments, so the card cannot promise an
                    item the look does not contain. */}
                <div className="grid aspect-[4/3] grid-cols-3 gap-px bg-[var(--line-soft)]">
                  {look.products.slice(0, 3).map((product) => (
                    <ProductImage
                      key={product.id}
                      url={product.media[0]?.url}
                      alt={product.title}
                      ratio="portrait"
                      className="h-full"
                      sizes="33vw"
                    />
                  ))}
                </div>
                <div className="absolute left-3 top-3 flex gap-1.5">
                  <Badge tone="dark">{look.itemCount}</Badge>
                  {/* ADM-010: a paid placement is labelled as one. */}
                  {look.isSponsored && <Badge tone="accent">{t('home.sponsored')}</Badge>}
                </div>
              </div>
              <div className="pt-3">
                <h2 className="t-section">{look.title}</h2>
                {look.description && (
                  <p className="mt-1 text-[13px] leading-snug text-[var(--fg-muted)]">{look.description}</p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <span className="t-price text-[14px]">{money(look.total, locale)}</span>
                  {look.styleTags.slice(0, 2).map((tag) => (
                    <span key={tag} className="text-[11.5px] text-[var(--fg-faint)]">
                      {styleLabel(tag, locale)}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
