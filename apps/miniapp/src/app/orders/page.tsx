'use client';

/**
 * Order list — spec ORD-003: the buyer sees one order per checkout, not one per
 * seller. The per-seller split is visible inside the order as parcels, which is
 * the truth of how it ships without making the shopper reconcile four orders
 * they placed once.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrderView } from '@fashion/core';
import { translate } from '@fashion/core';
import { orders as ordersApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { date, money } from '@/lib/format';
import { ProductImage } from '@/components/product';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  BagIcon,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingScreen,
  Segmented,
  Skeleton,
  Spinner,
} from '@/components/ui';
import { haptic } from '@/lib/telegram';
import { orderTone } from '@/lib/order-status';

type Scope = 'active' | 'completed';

export default function OrdersPage() {
  const { locale } = useApp();
  const t = useT();
  useBackButton('/profile');

  const [scope, setScope] = useState<Scope>('active');
  const [items, setItems] = useState<OrderView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextScope: Scope) => {
      setItems(null);
      setError(null);
      try {
        const page = await ordersApi.list(nextScope);
        setItems(page.items);
        setCursor(page.nextCursor);
      } catch (caught) {
        setError(errorMessage(caught, locale));
      }
    },
    [locale],
  );

  useEffect(() => {
    void load(scope);
  }, [scope, load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await ordersApi.list(scope, cursor);
      setItems((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      /* keep what is on screen */
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, scope]);

  return (
    <div>
      <ScreenHeader back="/profile" title={t('orders.title')} />

      <div className="px-4 py-3">
        <Segmented<Scope>
          value={scope}
          onChange={setScope}
          options={[
            { value: 'active', label: t('orders.active') },
            { value: 'completed', label: t('orders.completed') },
          ]}
        />
      </div>

      {error && <ErrorState message={error} onRetry={() => void load(scope)} retryLabel={t('common.retry')} />}

      {!items && !error && (
        <div className="space-y-4 px-4 pt-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-[118px] w-full rounded-[var(--radius-lg)]" />
          ))}
        </div>
      )}

      {items && items.length === 0 && (
        <EmptyState
          icon={<BagIcon size={32} />}
          title={t('orders.empty')}
          action={
            <Link href="/search">
              <Button>{t('cart.goShopping')}</Button>
            </Link>
          }
        />
      )}

      {items && items.length > 0 && (
        <div className="space-y-3 px-4 pb-6">
          {items.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}

          {cursor && (
            <Button variant="outline" block loading={loadingMore} onClick={loadMore}>
              {t('common.more')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function OrderCard({ order }: { order: OrderView }) {
  const { locale } = useApp();
  const t = useT();

  const thumbnails = order.subOrders
    .flatMap((subOrder) => subOrder.items)
    .slice(0, 4);
  const itemCount = order.subOrders.reduce(
    (total, subOrder) => total + subOrder.items.reduce((sum, item) => sum + item.quantity, 0),
    0,
  );

  return (
    <Link
      href={`/orders/${order.id}`}
      onClick={() => haptic.tap('light')}
      className="pressable block rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)] p-3.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="t-num text-[13px] font-semibold">{order.number}</p>
          <p className="text-[12px] text-[var(--fg-faint)]">{date(order.placedAt, locale)}</p>
        </div>
        {/* The status copy is the shared catalogue's, so the bot's notification
            and this card never describe the same order differently. */}
        <Badge tone={orderTone(order.status)}>{translate(locale, `order.status.${order.status}`)}</Badge>
      </div>

      <div className="mt-3 flex items-center gap-2.5">
        <div className="flex gap-1">
          {thumbnails.map((item) => (
            <div key={item.id} className="w-[44px] overflow-hidden rounded-[var(--radius-xs)]">
              <ProductImage url={item.imageUrl} alt={item.title} sizes="44px" />
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 text-right">
          <p className="t-price text-[14px]">{money(order.grandTotal, locale)}</p>
          <p className="t-num text-[11.5px] text-[var(--fg-faint)]">
            {itemCount} {t('common.pcs')}
            {order.subOrders.length > 1 && ` · ${order.subOrders.length} ${t('orders.parcel')}`}
          </p>
        </div>
      </div>

      {/* The one thing a shopper might need to do right now. */}
      {order.status === 'AWAITING_PAYMENT' && (
        <p className="mt-2.5 text-[12.5px] font-semibold text-[var(--accent)]">{t('orders.payNow')} →</p>
      )}
      {order.refundedTotal.amount !== '0' && (
        <p className="mt-2.5 text-[12px] text-[var(--fg-muted)]">
          {t('orders.refunded')}: <span className="t-num">{money(order.refundedTotal, locale)}</span>
        </p>
      )}
    </Link>
  );
}
