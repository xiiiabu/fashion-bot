'use client';

/** Saved items — spec BUY-006. */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProductCard } from '@fashion/core';
import { wishlist as wishlistApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { ProductGrid, ProductGridSkeleton } from '@/components/product';
import { ScreenHeader, useBackButton } from '@/components/shell';
import { Button, EmptyState, ErrorState, HeartIcon } from '@/components/ui';

export default function WishlistPage() {
  const { locale } = useApp();
  const t = useT();
  useBackButton('/profile');

  const [items, setItems] = useState<ProductCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await wishlistApi.list();
      setItems(data.items);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <ScreenHeader back="/profile" title={t('wishlist.title')} />

      {error && <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />}

      {!items && !error && (
        <div className="px-4 pt-4">
          <ProductGridSkeleton count={4} />
        </div>
      )}

      {items && items.length === 0 && (
        <EmptyState
          icon={<HeartIcon size={32} />}
          title={t('wishlist.empty')}
          body={t('wishlist.emptyHint')}
          action={
            <Link href="/search">
              <Button>{t('cart.goShopping')}</Button>
            </Link>
          }
        />
      )}

      {items && items.length > 0 && (
        <div className="px-4 py-4">
          <ProductGrid products={items} />
        </div>
      )}
    </div>
  );
}
