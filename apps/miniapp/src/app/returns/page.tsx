'use client';

/**
 * Return list and detail — spec §9.2 and FUL-008 (the shopper can see where a
 * return stands without writing to support).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { ReturnRequestView } from '@fashion/core';
import { translate } from '@fashion/core';
import { returns as returnsApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { date, money } from '@/lib/format';
import { ProductImage } from '@/components/product';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  ReturnIcon,
  Skeleton,
} from '@/components/ui';
import { returnTone } from '@/lib/order-status';
import { haptic } from '@/lib/telegram';

export default function ReturnsPage() {
  const { locale } = useApp();
  const t = useT();
  useBackButton('/profile');

  const [items, setItems] = useState<ReturnRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await returnsApi.list();
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
      <ScreenHeader back="/profile" title={t('returns.title')} />

      {error && <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />}

      {!items && !error && (
        <div className="space-y-3 px-4 pt-4">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-[110px] w-full rounded-[var(--radius-lg)]" />
          ))}
        </div>
      )}

      {items && items.length === 0 && (
        <EmptyState
          icon={<ReturnIcon size={32} />}
          title={t('returns.empty')}
          action={
            <Link href="/orders">
              <Button variant="outline">{t('orders.title')}</Button>
            </Link>
          }
        />
      )}

      {items && items.length > 0 && (
        <div className="space-y-3 px-4 py-4">
          {items.map((request) => (
            <Link
              key={request.id}
              href={`/returns/${request.id}`}
              onClick={() => haptic.tap('light')}
              className="pressable block rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)] p-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="t-num text-[13px] font-semibold">{request.number}</p>
                  <p className="text-[12px] text-[var(--fg-faint)]">
                    {request.orderNumber} · {date(request.createdAt, locale)}
                  </p>
                </div>
                <Badge tone={returnTone(request.status)}>
                  {translate(locale, `return.status.${request.status}`)}
                </Badge>
              </div>

              <div className="mt-3 flex items-center gap-2.5">
                <div className="flex gap-1">
                  {request.items.slice(0, 3).map((item) => (
                    <div key={item.orderItemId} className="w-[42px] overflow-hidden rounded-[var(--radius-xs)]">
                      <ProductImage url={item.imageUrl} alt={item.title} sizes="42px" />
                    </div>
                  ))}
                </div>
                <div className="min-w-0 flex-1 text-right">
                  <p className="t-label">{t('returns.refundAmount')}</p>
                  <p className="t-price text-[14px]">{money(request.refundTotal, locale)}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
