'use client';

/**
 * Return detail — spec §9.2. The two things the shopper needs: what state the
 * request is in, and what (if anything) they have to do next. The drop-off
 * instructions come from the seller's return policy, verbatim.
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { ReturnRequestView } from '@fashion/core';
import { translate } from '@fashion/core';
import { returns as returnsApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { dateTime, money } from '@/lib/format';
import { ProductLine } from '@/components/product';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Badge,
  Button,
  CheckIcon,
  ErrorState,
  LoadingScreen,
  Note,
  PinIcon,
  Row,
  RowGroup,
  Section,
  cx,
} from '@/components/ui';
import { returnTone } from '@/lib/order-status';
import { confirm, haptic } from '@/lib/telegram';

export default function ReturnDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ReturnDetailScreen />
    </Suspense>
  );
}

function ReturnDetailScreen() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { locale, toast } = useApp();
  const t = useT();
  useBackButton('/returns');

  const [request, setRequest] = useState<ReturnRequestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const justCreated = search.get('created') === '1';

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequest(await returnsApi.get(params.id));
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [params.id, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const handover = useCallback(async () => {
    setWorking(true);
    try {
      setRequest(await returnsApi.handover(params.id));
      haptic.success();
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setWorking(false);
    }
  }, [params.id, toast, locale]);

  const cancel = useCallback(async () => {
    if (!(await confirm(t('returns.cancel')))) return;
    setWorking(true);
    try {
      setRequest(await returnsApi.cancel(params.id));
      haptic.success();
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setWorking(false);
    }
  }, [params.id, toast, t, locale]);

  if (error) {
    return (
      <div>
        <ScreenHeader back="/returns" title={t('returns.title')} />
        <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!request) {
    return (
      <div>
        <ScreenHeader back="/returns" title={t('returns.title')} />
        <LoadingScreen />
      </div>
    );
  }

  const canHandover = request.status === 'APPROVED';
  const canCancel = request.status === 'REQUESTED' || request.status === 'APPROVED';

  return (
    <div className="pb-8">
      <ScreenHeader back="/returns" title={request.number} eyebrow={request.orderNumber} />

      {justCreated && (
        <div className="px-4 pt-4">
          <Note tone="success" title={t('returns.created')} icon={<CheckIcon size={15} />}>
            {t('returns.createdBody')}
          </Note>
        </div>
      )}

      <div className="px-4 pt-5">
        <Badge tone={returnTone(request.status)}>
          {translate(locale, `return.status.${request.status}`)}
        </Badge>
        <p className="t-label mt-3">{t('returns.refundAmount')}</p>
        <p className="t-price text-[22px]">{money(request.refundTotal, locale)}</p>
      </div>

      {/* The one action the shopper owns in this flow. */}
      {canHandover && (
        <div className="px-4 pt-4">
          <Button block loading={working} onClick={handover}>
            {t('returns.handover')}
          </Button>
        </div>
      )}

      {request.dropOffInstructions && (
        <Section title={t('returns.dropOff')}>
          <div className="flex gap-3 rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-4">
            <PinIcon size={17} className="mt-0.5 shrink-0 text-[var(--fg-muted)]" />
            <p className="min-w-0 flex-1 whitespace-pre-line text-[13.5px] leading-relaxed">
              {request.dropOffInstructions}
            </p>
          </div>
        </Section>
      )}

      <Section title={t('returns.chooseItems')}>
        <div className="space-y-3.5">
          {request.items.map((item) => (
            <ProductLine
              key={item.orderItemId}
              imageUrl={item.imageUrl}
              title={item.title}
              meta={`${item.sizeLabel} · ${item.quantity} ${t('common.pcs')}`}
              price={money(item.refundAmount, locale)}
              note={
                <p className="mt-0.5 text-[12px] text-[var(--fg-muted)]">
                  {t(`reason.${item.reason}`)}
                </p>
              }
            />
          ))}
        </div>
      </Section>

      {request.timeline.length > 0 && (
        <Section title={t('orders.timeline')}>
          <ol className="relative space-y-4 pl-5">
            <span aria-hidden className="absolute left-[3.5px] top-1.5 bottom-1.5 w-px bg-[var(--line)]" />
            {request.timeline.map((entry, index) => (
              <li key={`${entry.status}-${entry.at}`} className="relative">
                <span
                  aria-hidden
                  className={cx(
                    'absolute -left-5 top-1.5 h-2 w-2 rounded-full',
                    index === request.timeline.length - 1 ? 'bg-[var(--accent)]' : 'bg-[var(--line)]',
                  )}
                />
                <p className="text-[13.5px] font-medium">
                  {translate(locale, `return.status.${entry.status}`)}
                </p>
                <p className="text-[12px] text-[var(--fg-faint)]">{dateTime(entry.at, locale)}</p>
                {entry.note && <p className="mt-0.5 text-[12.5px] text-[var(--fg-muted)]">{entry.note}</p>}
              </li>
            ))}
          </ol>
        </Section>
      )}

      <div className="px-4 pt-2">
        <RowGroup>
          <Row title={t('orders.order')} hint={request.orderNumber} onClick={() => router.push(`/orders/${request.orderId}`)} />
          {canCancel && <Row title={t('returns.cancel')} danger onClick={cancel} />}
        </RowGroup>
      </div>
    </div>
  );
}
