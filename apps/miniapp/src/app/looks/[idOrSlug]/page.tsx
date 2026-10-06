'use client';

/** One curated look, with every garment in it addable individually. */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { cart as cartApi, catalog, type LookSummary } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { money } from '@/lib/format';
import { ProductGrid, ProductGridSkeleton } from '@/components/product';
import { BottomBar, BottomBarSpacer, ScreenHeader, useBackButton } from '@/components/shell';
import { Button, ErrorState, Section } from '@/components/ui';
import { styleLabel } from '@/lib/taxonomy-labels';
import { haptic } from '@/lib/telegram';

export default function LookPage() {
  const params = useParams<{ idOrSlug: string }>();
  const router = useRouter();
  const { locale, refreshCartCount, toast } = useApp();
  const t = useT();
  useBackButton('/looks');

  const [look, setLook] = useState<LookSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setLook(await catalog.look(params.idOrSlug));
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [params.idOrSlug, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A curated look adds the first in-stock SKU of each product. Where a product
   * needs a size decision we send the shopper to its page rather than guessing
   * — picking a size for someone is how a return gets created.
   */
  const addAll = useCallback(async () => {
    if (!look) return;
    setAdding(true);
    try {
      const inStock = look.products.filter((product) => product.inStock);
      if (inStock.length === 0) {
        toast(t('pdp.outOfStock'), 'error');
        return;
      }
      // Single-size products can be added directly; anything with a size choice
      // is left to the shopper, and we say how many were added.
      const single = inStock.filter((product) => product.availableSizes.length === 1);
      if (single.length === 0) {
        toast(t('pdp.selectSize'), 'error');
        return;
      }
      const detail = await Promise.all(single.map((product) => catalog.product(product.slug)));
      const items = detail
        .map((product) => product.skus.find((sku) => sku.available > 0))
        .filter((sku): sku is NonNullable<typeof sku> => Boolean(sku))
        .map((sku) => ({ skuId: sku.id, quantity: 1 }));
      if (items.length === 0) {
        toast(t('pdp.outOfStock'), 'error');
        return;
      }
      await cartApi.addLook({ items });
      await refreshCartCount();
      haptic.success();
      toast(t('ai.addedAll'), 'success');
      router.push('/cart');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setAdding(false);
    }
  }, [look, refreshCartCount, toast, t, locale, router]);

  if (error) {
    return (
      <div>
        <ScreenHeader back="/looks" title={t('home.looks')} />
        <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!look) {
    return (
      <div>
        <ScreenHeader back="/looks" title="" />
        <div className="px-4 pt-6">
          <ProductGridSkeleton count={4} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader back="/looks" title={look.title} />

      <header className="px-4 pt-5">
        <h1 className="t-title">{look.title}</h1>
        {look.description && (
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--fg-muted)]">{look.description}</p>
        )}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {look.styleTags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[var(--bg-sunken)] px-2.5 py-1 text-[11.5px] text-[var(--fg-muted)]"
            >
              {styleLabel(tag, locale)}
            </span>
          ))}
        </div>
      </header>

      <Section>
        <ProductGrid products={look.products} />
      </Section>

      <BottomBarSpacer height={82} />

      <BottomBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="t-price text-[16px]">{money(look.total, locale)}</p>
            <p className="t-num truncate text-[11.5px] text-[var(--fg-faint)]">
              {look.itemCount} {t('common.pcs')}
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
