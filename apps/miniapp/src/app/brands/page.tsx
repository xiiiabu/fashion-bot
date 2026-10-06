'use client';

/**
 * Brand directory — spec CAT-002. In a multi-brand marketplace the brand list
 * is a primary way in, not a footer link, so it gets a screen with the logos at
 * a size where they are actually recognisable.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { BrandSummary } from '@fashion/core';
import { API_BASE } from '@/lib/api';
import { catalog } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { mediaUrl } from '@/lib/format';
import { ScreenHeader, useBackButton } from '@/components/shell';
import { ErrorState, SearchIcon, ShieldIcon, Skeleton, cx } from '@/components/ui';
import { haptic } from '@/lib/telegram';

export default function BrandsPage() {
  const { locale } = useApp();
  const t = useT();
  useBackButton('/');

  const [items, setItems] = useState<BrandSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await catalog.brands(120);
      setItems(data.items);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Grouped by first letter. A 40-brand list is scannable; a 200-brand one is
   * not, and the index is what makes it work on a phone.
   */
  const groups = useMemo(() => {
    const filtered = (items ?? []).filter((brand) =>
      brand.name.toLowerCase().includes(query.trim().toLowerCase()),
    );
    const map = new Map<string, BrandSummary[]>();
    for (const brand of filtered) {
      const letter = brand.name.charAt(0).toUpperCase();
      const bucket = map.get(letter);
      if (bucket) bucket.push(brand);
      else map.set(letter, [brand]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, locale));
  }, [items, query, locale]);

  return (
    <div className="pb-6">
      <ScreenHeader back="/" title={t('home.brands')} />

      <div className="px-4 pt-3">
        <div className="flex h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg-raised)] px-3.5">
          <SearchIcon size={16} className="shrink-0 text-[var(--fg-faint)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('filter.brand')}
            className="min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-[var(--fg-faint)] focus:outline-none"
          />
        </div>
      </div>

      {error && <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />}

      {!items && !error && (
        <div className="space-y-3 px-4 pt-5">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-[56px] w-full" />
          ))}
        </div>
      )}

      {groups.map(([letter, brands]) => (
        <section key={letter} className="pt-5">
          <h2 className="t-eyebrow sticky top-[52px] z-10 bg-[var(--bg)]/92 px-4 py-1.5 backdrop-blur-xl">
            {letter}
          </h2>
          <div className="px-4">
            {brands.map((brand) => (
              <Link
                key={brand.id}
                href={`/brands/${brand.slug}`}
                onClick={() => haptic.tap('light')}
                className="pressable flex items-center gap-3 border-b border-[var(--line-soft)] py-3"
              >
                <BrandMark brand={brand} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14.5px] font-medium">{brand.name}</span>
                    {brand.verified && <ShieldIcon size={13} className="shrink-0 text-[var(--accent)]" />}
                  </span>
                  {brand.productCount !== undefined && (
                    <span className="t-num block text-[12px] text-[var(--fg-faint)]">
                      {brand.productCount}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[var(--fg-faint)]">›</span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      {items && groups.length === 0 && (
        <p className="px-4 pt-10 text-center text-[14px] text-[var(--fg-muted)]">{t('search.nothing')}</p>
      )}
    </div>
  );
}

function BrandMark({ brand, size = 44 }: { brand: BrandSummary; size?: number }) {
  const logo = mediaUrl(brand.logoUrl, API_BASE);
  return (
    <span
      className={cx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        'border border-[var(--line)] bg-[var(--bg-raised)]',
      )}
      style={{ width: size, height: size }}
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" className="h-full w-full object-contain p-1.5" loading="lazy" />
      ) : (
        <span className="t-display text-[0.95rem] text-[var(--fg-muted)]">{brand.name.charAt(0)}</span>
      )}
    </span>
  );
}
