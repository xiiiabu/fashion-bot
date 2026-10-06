'use client';

/**
 * Cart — spec ORD-001 (one cart across sellers, grouped by seller so delivery
 * terms stay legible) and CAT-008 (availability is re-checked server-side on
 * every read, so a line can come back flagged).
 *
 * Every total on this screen comes from the server. The client does not sum
 * line totals, apply a discount, or compute delivery: ORD-002 puts that in the
 * backend, and a client that duplicates the arithmetic eventually disagrees
 * with the order the shopper is actually charged for.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CartItemView, CartView } from '@fashion/core';
import { cart as cartApi, trackScreen } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { deliveryRange, money } from '@/lib/format';
import { ProductLine } from '@/components/product';
import { BottomBar, BottomBarSpacer, ScreenHeader } from '@/components/shell';
import {
  BagIcon,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingScreen,
  Note,
  Stepper,
  TrashIcon,
  cx,
} from '@/components/ui';
import { confirm, haptic } from '@/lib/telegram';

export default function CartPage() {
  const router = useRouter();
  const { locale, setCartCount, toast } = useApp();
  const t = useT();

  const [cart, setCart] = useState<CartView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await cartApi.get();
      setCart(data);
      setCartCount(data.itemCount);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [locale, setCartCount]);

  useEffect(() => {
    void load();
    trackScreen('cart');
  }, [load]);

  const apply = useCallback(
    (next: CartView) => {
      setCart(next);
      setCartCount(next.itemCount);
    },
    [setCartCount],
  );

  const setQuantity = useCallback(
    async (item: CartItemView, quantity: number) => {
      setBusyItem(item.id);
      try {
        apply(await cartApi.setQuantity(item.id, quantity));
        haptic.tap('light');
      } catch (caught) {
        toast(errorMessage(caught, locale), 'error');
        // The server is the source of truth for availability, so re-read
        // rather than guessing what the cart now looks like.
        void load();
      } finally {
        setBusyItem(null);
      }
    },
    [apply, toast, locale, load],
  );

  const removeItem = useCallback(
    async (item: CartItemView) => {
      if (!(await confirm(t('cart.removeConfirm')))) return;
      setBusyItem(item.id);
      try {
        apply(await cartApi.removeItem(item.id));
        haptic.tap('medium');
      } catch (caught) {
        toast(errorMessage(caught, locale), 'error');
      } finally {
        setBusyItem(null);
      }
    },
    [apply, toast, t, locale],
  );

  if (error && !cart) {
    return (
      <div>
        <ScreenHeader title={t('cart.title')} />
        <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!cart) {
    return (
      <div>
        <ScreenHeader title={t('cart.title')} />
        <LoadingScreen />
      </div>
    );
  }

  if (cart.itemCount === 0) {
    return (
      <div>
        <ScreenHeader title={t('cart.title')} />
        <EmptyState
          icon={<BagIcon size={32} />}
          title={t('cart.empty')}
          body={t('cart.emptyHint')}
          action={
            <Link href="/search">
              <Button>{t('cart.goShopping')}</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader
        title={t('cart.title')}
        eyebrow={t('cart.itemCount', { n: cart.itemCount })}
        action={
          <button
            type="button"
            onClick={async () => {
              if (!(await confirm(t('cart.clearConfirm')))) return;
              try {
                apply(await cartApi.clear());
              } catch (caught) {
                toast(errorMessage(caught, locale), 'error');
              }
            }}
            className="px-2 text-[var(--fg-faint)]"
            aria-label={t('common.remove')}
          >
            <TrashIcon size={18} />
          </button>
        }
      />

      {/* ORD-001: a flagged line blocks checkout until the shopper resolves it,
          because the alternative is an order the seller cannot fulfil. */}
      {cart.hasIssues && (
        <div className="px-4 pt-4">
          <Note tone="warn">{t('cart.fixIssues')}</Note>
        </div>
      )}

      {/* One group per seller. The split is not cosmetic: each seller ships
          separately and has its own delivery terms and handling time. */}
      {cart.groups.map((group) => (
        <section key={group.sellerId} className="pt-5">
          <header className="flex items-baseline justify-between gap-3 px-4 pb-3">
            <div className="min-w-0">
              <p className="t-eyebrow">{t('cart.fromSeller')}</p>
              <h2 className="truncate text-[14.5px] font-semibold">{group.sellerName}</h2>
            </div>
            <span className="t-price shrink-0 text-[13.5px]">{money(group.subtotal, locale)}</span>
          </header>

          <div className="space-y-4 px-4">
            {group.items.map((item) => (
              <CartLine
                key={item.id}
                item={item}
                busy={busyItem === item.id}
                onQuantity={(quantity) => void setQuantity(item, quantity)}
                onRemove={() => void removeItem(item)}
              />
            ))}
          </div>

          {group.deliveryOptions.length > 0 && (
            <p className="px-4 pt-3 text-[12px] text-[var(--fg-faint)]">
              {t('cart.deliverySeparately')} ·{' '}
              {deliveryRange(
                Math.min(...group.deliveryOptions.map((option) => option.minDays)),
                Math.max(...group.deliveryOptions.map((option) => option.maxDays)),
                locale,
              )}
            </p>
          )}
        </section>
      ))}

      {/* ORD-002: these are the server's numbers, shown as given. */}
      <section className="mt-7 border-t border-[var(--line)] px-4 py-5">
        <dl className="space-y-2.5">
          <Line label={t('cart.subtotal')} value={money(cart.subtotal, locale)} />
          <Line
            label={t('cart.delivery')}
            value={money(cart.estimatedDelivery, locale)}
            hint={cart.groups.length > 1 ? t('checkout.sellersNote', { n: cart.groups.length }) : undefined}
          />
          <div className="h-px bg-[var(--line)]" />
          <Line label={t('cart.total')} value={money(cart.estimatedTotal, locale)} strong />
        </dl>
      </section>

      <BottomBarSpacer height={82} />

      <BottomBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="t-price text-[16px]">{money(cart.estimatedTotal, locale)}</p>
            <p className="truncate text-[11.5px] text-[var(--fg-faint)]">
              {t('cart.itemCount', { n: cart.itemCount })}
            </p>
          </div>
          <Button
            size="lg"
            className="min-w-[52%]"
            disabled={cart.hasIssues}
            onClick={() => {
              haptic.tap('medium');
              router.push('/checkout');
            }}
          >
            {t('cart.checkout')}
          </Button>
        </div>
      </BottomBar>
    </div>
  );
}

function Line({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cx('min-w-0', strong ? 'text-[15px] font-semibold' : 'text-[13.5px] text-[var(--fg-muted)]')}>
        {label}
        {hint && <span className="mt-0.5 block text-[11.5px] text-[var(--fg-faint)]">{hint}</span>}
      </dt>
      <dd className={cx('t-price shrink-0', strong ? 'text-[17px]' : 'text-[13.5px]')}>{value}</dd>
    </div>
  );
}

function CartLine({
  item,
  busy,
  onQuantity,
  onRemove,
}: {
  item: CartItemView;
  busy: boolean;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
}) {
  const { locale } = useApp();
  const t = useT();

  const issueLabel: Record<CartItemView['issue'], string | null> = {
    NONE: null,
    OUT_OF_STOCK: t('cart.issueOutOfStock'),
    PRICE_CHANGED: t('cart.issuePriceChanged'),
    UNPUBLISHED: t('cart.issueUnpublished'),
    QUANTITY_REDUCED: t('cart.issueQuantityReduced'),
  };
  const issue = issueLabel[item.issue];
  const blocked = item.issue === 'OUT_OF_STOCK' || item.issue === 'UNPUBLISHED';

  return (
    <div className={cx(blocked && 'opacity-60')}>
      <ProductLine
        imageUrl={item.imageUrl}
        title={item.title}
        brandName={item.brandName}
        meta={`${item.sizeLabel} · ${item.colorName}`}
        price={money(item.lineTotal, locale)}
        comparePrice={
          item.compareAtUnitPrice ? money(item.compareAtUnitPrice, locale) : undefined
        }
        href={`/p/${item.productId}`}
        note={
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {issue && <Badge tone={blocked ? 'danger' : 'warn'}>{issue}</Badge>}
            {item.addedFromAi && <Badge tone="accent">{t('cart.aiPick')}</Badge>}
            {/* CAT-008: say how many are actually left, not just "low stock". */}
            {!blocked && item.available > 0 && item.available <= 3 && (
              <span className="text-[11.5px] text-warn">{t('pdp.onlyLeft', { n: item.available })}</span>
            )}
          </div>
        }
      />
      <div className="mt-2.5 flex items-center justify-between pl-[80px]">
        <Stepper
          value={item.quantity}
          min={1}
          max={Math.max(1, Math.min(10, item.available))}
          busy={busy}
          disabled={blocked}
          onChange={onQuantity}
        />
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="px-2 text-[12.5px] text-[var(--fg-faint)] disabled:opacity-40"
        >
          {t('common.remove')}
        </button>
      </div>
    </div>
  );
}
