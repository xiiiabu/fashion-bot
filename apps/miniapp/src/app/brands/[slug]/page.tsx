'use client';

/** One brand's shopfront — spec CAT-002 (the brand story is seller content). */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { BrandSummary, ProductCard } from '@fashion/core';
import { API_BASE } from '@/lib/api';
import { catalog } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { mediaUrl } from '@/lib/format';
import { ProductGrid, ProductGridSkeleton } from '@/components/product';
import { ScreenHeader, useBackButton } from '@/components/shell';
import { Button, ErrorState, ShieldIcon } from '@/components/ui';

export default function BrandPage() {
  const params = useParams<{ slug: string }>();
  const { locale } = useApp();
  const t = useT();
  useBackButton('/brands');

  // The brand endpoint returns the brand record; its products come from
  // search, which is also what powers the "view all" link, so the two stay
  // consistent instead of the page showing a list the filter cannot reproduce.
  const [brand, setBrand] = useState<
    | (BrandSummary & {
        coverUrl: string | null;
        description: string | null;
        country: string | null;
      })
    | null
  >(null);
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const record = await catalog.brand(params.slug);
      setBrand(record);
      const page = await catalog.search({ brandSlug: [params.slug], limit: 24, sort: 'newest' });
      setProducts(page.items);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [params.slug, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div>
        <ScreenHeader back="/brands" title={t('home.brands')} />
        <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!brand) {
    return (
      <div>
        <ScreenHeader back="/brands" title="" />
        <div className="px-4 pt-6">
          <ProductGridSkeleton count={4} />
        </div>
      </div>
    );
  }

  const logo = mediaUrl(brand.logoUrl, API_BASE);

  return (
    <div className="pb-6">
      <ScreenHeader back="/brands" title={brand.name} />

      <header className="flex flex-col items-center px-6 pt-7 text-center">
        <div className="flex h-[84px] w-[84px] items-center justify-center overflow-hidden rounded-full border border-[var(--line)] bg-[var(--bg-raised)]">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt={brand.name} className="h-full w-full object-contain p-3" />
          ) : (
            <span className="t-display text-[1.7rem] text-[var(--fg-muted)]">
              {brand.name.charAt(0)}
            </span>
          )}
        </div>
        <h1 className="t-title mt-3.5 flex items-center gap-2">
          {brand.name}
          {brand.verified && <ShieldIcon size={17} className="text-[var(--accent)]" />}
        </h1>
        {brand.description && (
          <p className="mt-2.5 max-w-[38ch] text-[13.5px] leading-relaxed text-[var(--fg-muted)]">
            {brand.description}
          </p>
        )}
        {brand.productCount !== undefined && (
          <p className="t-num mt-2 text-[12px] text-[var(--fg-faint)]">{brand.productCount}</p>
        )}
      </header>

      <div className="px-4 pt-7">
        {products.length > 0 ? (
          <>
            <ProductGrid products={products} />
            <div className="pt-5">
              <Link href={`/search?brandSlug=${brand.slug}`}>
                <Button variant="outline" block>
                  {t('home.viewAll')}
                </Button>
              </Link>
            </div>
          </>
        ) : (
          <p className="py-10 text-center text-[14px] text-[var(--fg-muted)]">{t('common.empty')}</p>
        )}
      </div>
    </div>
  );
}
