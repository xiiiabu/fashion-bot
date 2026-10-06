'use client';

/**
 * Order detail — spec ORD-003, ORD-010 (order, payment and return statuses are
 * distinct and shown as such), FUL-004 (tracking per parcel), FUL-006 (return
 * eligibility is explained, not just allowed or denied) and FIT-005 (the
 * post-delivery fit question).
 *
 * The buyer-facing status is derived from the parcels by the backend. This
 * screen shows both: the one line that answers "where is my order" and the
 * per-seller detail underneath for when that is not enough.
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { OrderView, SubOrderView } from '@fashion/core';
import { translate } from '@fashion/core';
import { fit as fitApi, orders as ordersApi, payments as paymentsApi, track } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { date, dateTime, deliveryRange, money } from '@/lib/format';
import { ProductLine } from '@/components/product';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Badge,
  Button,
  CheckIcon,
  ErrorState,
  LoadingScreen,
  Note,
  ReceiptIcon,
  ReturnIcon,
  Row,
  RowGroup,
  Section,
  Sheet,
  Textarea,
  TruckIcon,
  cx,
} from '@/components/ui';
import { orderTone, subOrderTone } from '@/lib/order-status';
import { confirm, haptic, openExternal } from '@/lib/telegram';

export default function OrderPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <OrderScreen />
    </Suspense>
  );
}

function OrderScreen() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { locale, toast } = useApp();
  const t = useT();
  useBackButton('/orders');

  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelSheet, setCancelSheet] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [working, setWorking] = useState(false);
  const [pendingFit, setPendingFit] = useState<
    Array<{ orderItemId: string; productId: string; title: string; imageUrl: string | null; sizeLabel: string }>
  >([]);

  const justPlaced = search.get('placed') === '1';

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrder(await ordersApi.get(params.id));
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [params.id, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  /* FIT-005: ask only about items from this order that were delivered. */
  useEffect(() => {
    if (!order || order.status !== 'DELIVERED') return;
    const ownItemIds = new Set(
      order.subOrders.flatMap((subOrder) => subOrder.items.map((item) => item.id)),
    );
    ordersApi
      .pendingFeedback()
      .then((data) => setPendingFit(data.items.filter((item) => ownItemIds.has(item.orderItemId))))
      .catch(() => {});
  }, [order]);

  const cancel = useCallback(async () => {
    if (!order) return;
    setWorking(true);
    try {
      setOrder(await ordersApi.cancel(order.id, cancelReason.trim() || undefined));
      setCancelSheet(false);
      haptic.success();
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setWorking(false);
    }
  }, [order, cancelReason, toast, locale]);

  const pay = useCallback(async () => {
    if (!order) return;
    setWorking(true);
    try {
      const session = await paymentsApi.init({
        orderId: order.id,
        returnUrl: `${window.location.origin}/orders/${order.id}`,
      });
      if (session.redirectUrl) openExternal(session.redirectUrl);
      else toast(t('err.FEATURE_DISABLED'), 'error');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setWorking(false);
    }
  }, [order, toast, t, locale]);

  if (error) {
    return (
      <div>
        <ScreenHeader back="/orders" title={t('orders.order')} />
        <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!order) {
    return (
      <div>
        <ScreenHeader back="/orders" title={t('orders.order')} />
        <LoadingScreen />
      </div>
    );
  }

  return (
    <div className="pb-8">
      <ScreenHeader back="/orders" title={order.number} eyebrow={date(order.placedAt, locale)} />

      {justPlaced && (
        <div className="px-4 pt-4">
          <Note tone="success" title={t('checkout.success')} icon={<CheckIcon size={15} />}>
            {t('checkout.successBody')}
          </Note>
        </div>
      )}

      {/* ORD-010: the order status and the payment status are separate facts. */}
      <div className="px-4 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={orderTone(order.status)}>{translate(locale, `order.status.${order.status}`)}</Badge>
          <Badge tone="neutral">{translate(locale, `payment.status.${order.paymentStatus}`)}</Badge>
        </div>
        <p className="t-price mt-3 text-[22px]">{money(order.grandTotal, locale)}</p>
        {order.refundedTotal.amount !== '0' && (
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
            {t('orders.refunded')}: <span className="t-num">{money(order.refundedTotal, locale)}</span>
          </p>
        )}
      </div>

      {order.status === 'AWAITING_PAYMENT' && (
        <div className="px-4 pt-4">
          <Button block loading={working} onClick={pay}>
            {t('orders.payNow')}
          </Button>
        </div>
      )}

      {/* FIT-005 */}
      {pendingFit.length > 0 && <FitFeedbackCard items={pendingFit} onDone={(id) =>
        setPendingFit((current) => current.filter((item) => item.orderItemId !== id))
      } />}

      {/* ── Parcels (ORD-004) ─────────────────────────────────────────── */}
      <Section title={order.subOrders.length > 1 ? t('orders.parcels') : t('orders.parcel')}>
        <div className="space-y-3">
          {order.subOrders.map((subOrder) => (
            <ParcelCard key={subOrder.id} subOrder={subOrder} />
          ))}
        </div>
      </Section>

      {/* ── Totals ────────────────────────────────────────────────────── */}
      <Section title={t('orders.total')}>
        <dl className="space-y-2.5 rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-4">
          <TotalRow label={t('cart.subtotal')} value={money(order.goodsTotal, locale)} />
          {order.discountTotal.amount !== '0' && (
            <TotalRow label={t('cart.discount')} value={`−${money(order.discountTotal, locale)}`} />
          )}
          <TotalRow label={t('cart.delivery')} value={money(order.deliveryTotal, locale)} />
          <div className="h-px bg-[var(--line-soft)]" />
          <TotalRow label={t('cart.total')} value={money(order.grandTotal, locale)} strong />
        </dl>
      </Section>

      {/* ── Address ───────────────────────────────────────────────────── */}
      {order.address && (
        <Section title={t('checkout.address')}>
          <div className="rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-4">
            <p className="text-[14px] font-medium">{order.address.recipientName}</p>
            <p className="mt-0.5 text-[13px] leading-snug text-[var(--fg-muted)]">
              {[
                order.address.city,
                order.address.district,
                order.address.street,
                order.address.building,
                order.address.apartment ? `кв. ${order.address.apartment}` : null,
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
            <p className="t-num mt-0.5 text-[12.5px] text-[var(--fg-faint)]">{order.address.phone}</p>
          </div>
        </Section>
      )}

      {/* ── Timeline ──────────────────────────────────────────────────── */}
      {order.timeline.length > 0 && (
        <Section title={t('orders.timeline')}>
          <ol className="relative space-y-4 pl-5">
            {/* A single rule behind the dots; cheaper and crisper than a border
                per item, and it does not break on a one-entry timeline. */}
            <span
              aria-hidden
              className="absolute left-[3.5px] top-1.5 bottom-1.5 w-px bg-[var(--line)]"
            />
            {order.timeline.map((entry, index) => (
              <li key={`${entry.status}-${entry.at}`} className="relative">
                <span
                  aria-hidden
                  className={cx(
                    'absolute -left-5 top-1.5 h-2 w-2 rounded-full',
                    index === order.timeline.length - 1 ? 'bg-[var(--accent)]' : 'bg-[var(--line)]',
                  )}
                />
                <p className="text-[13.5px] font-medium">
                  {translate(locale, `order.status.${entry.status}`)}
                </p>
                <p className="text-[12px] text-[var(--fg-faint)]">{dateTime(entry.at, locale)}</p>
                {entry.note && <p className="mt-0.5 text-[12.5px] text-[var(--fg-muted)]">{entry.note}</p>}
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* ── Policy and actions ────────────────────────────────────────── */}
      <Section title={t('pdp.returns')}>
        <div className="rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-4">
          <p className="text-[13.5px] font-medium">
            {t('pdp.returnWindow', { n: order.returnPolicy.windowDays })}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--fg-muted)]">
            {order.returnPolicy.conditions}
          </p>
          {order.returnPolicy.nonReturnableReasons.length > 0 && (
            <ul className="mt-2 space-y-1">
              {order.returnPolicy.nonReturnableReasons.map((reason) => (
                <li key={reason} className="text-[12px] text-[var(--fg-faint)]">
                  · {reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <div className="px-4 pt-2">
        <RowGroup>
          {order.canReturn && (
            <Row
              icon={<ReturnIcon size={17} />}
              title={t('orders.requestReturn')}
              onClick={() => router.push(`/orders/${order.id}/return`)}
            />
          )}
          {order.fiscalReceiptUrl && (
            <Row
              icon={<ReceiptIcon size={17} />}
              title={t('orders.receipt')}
              onClick={() => openExternal(order.fiscalReceiptUrl!)}
            />
          )}
          {order.canCancel && (
            <Row
              title={t('orders.cancel')}
              danger
              onClick={() => setCancelSheet(true)}
            />
          )}
        </RowGroup>
      </div>

      <Sheet open={cancelSheet} onClose={() => setCancelSheet(false)} title={t('orders.cancel')}>
        <div className="space-y-4 pb-2">
          <p className="text-[14px] leading-relaxed text-[var(--fg-soft)]">{t('orders.cancelConfirm')}</p>
          <Textarea
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder={t('orders.cancelReason')}
            maxLength={500}
          />
          <div className="flex gap-2.5">
            <Button variant="outline" onClick={() => setCancelSheet(false)}>
              {t('common.cancel')}
            </Button>
            <Button block variant="danger" loading={working} onClick={cancel}>
              {t('orders.cancel')}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cx(strong ? 'text-[14.5px] font-semibold' : 'text-[13px] text-[var(--fg-muted)]')}>
        {label}
      </dt>
      <dd className={cx('t-price', strong ? 'text-[16px]' : 'text-[13px]')}>{value}</dd>
    </div>
  );
}

/** FUL-004: one parcel, its seller, its status, its tracking. */
function ParcelCard({ subOrder }: { subOrder: SubOrderView }) {
  const { locale } = useApp();
  const t = useT();

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold">{subOrder.sellerName}</p>
          <p className="t-num text-[11.5px] text-[var(--fg-faint)]">{subOrder.number}</p>
        </div>
        <Badge tone={subOrderTone(subOrder.status)}>
          {translate(locale, `suborder.status.${subOrder.status}`)}
        </Badge>
      </div>

      <div className="mt-3 space-y-3">
        {subOrder.items.map((item) => (
          <ProductLine
            key={item.id}
            imageUrl={item.imageUrl}
            title={item.title}
            brandName={item.brandName}
            meta={`${item.sizeLabel} · ${item.quantity} ${t('common.pcs')}`}
            price={money(item.lineTotal, locale)}
            href={`/p/${item.productId}`}
            note={
              item.refundedQuantity > 0 ? (
                <p className="mt-0.5 text-[11.5px] text-[var(--fg-muted)]">
                  {t('orders.refunded')}: <span className="t-num">{item.refundedQuantity}</span>
                </p>
              ) : undefined
            }
          />
        ))}
      </div>

      {subOrder.estimatedDelivery && (
        <p className="mt-3 flex items-center gap-2 border-t border-[var(--line-soft)] pt-2.5 text-[12.5px] text-[var(--fg-muted)]">
          <TruckIcon size={15} />
          {subOrder.deliveryName} ·{' '}
          {deliveryRange(
            subOrder.estimatedDelivery.minDays,
            subOrder.estimatedDelivery.maxDays,
            locale,
          )}
        </p>
      )}

      {subOrder.shipment?.trackingNumber && (
        <button
          type="button"
          onClick={() => {
            haptic.tap('light');
            if (subOrder.shipment?.trackingUrl) openExternal(subOrder.shipment.trackingUrl);
            else void navigator.clipboard?.writeText(subOrder.shipment!.trackingNumber!);
          }}
          className="mt-2 flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3 py-2.5 text-left"
        >
          <span className="min-w-0">
            <span className="t-label block">
              {t('orders.trackingNumber')}
              {subOrder.shipment.carrier ? ` · ${subOrder.shipment.carrier}` : ''}
            </span>
            <span className="t-num block truncate text-[13px]">{subOrder.shipment.trackingNumber}</span>
          </span>
          <span className="shrink-0 text-[12.5px] font-semibold text-[var(--accent)]">
            {subOrder.shipment.trackingUrl ? t('orders.tracking') : t('common.copy')}
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * FIT-005: the one question worth asking after delivery. It feeds the community
 * signal the next shopper sees on the PDP, which is why it is here and not
 * buried in a review form.
 */
function FitFeedbackCard({
  items,
  onDone,
}: {
  items: Array<{ orderItemId: string; title: string; imageUrl: string | null; sizeLabel: string }>;
  onDone: (orderItemId: string) => void;
}) {
  const { locale, toast } = useApp();
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const item = items[0];
  if (!item) return null;

  const submit = async (verdict: 'runs_small' | 'true_to_size' | 'runs_large') => {
    setBusy(item.orderItemId);
    try {
      await fitApi.feedback({ orderItemId: item.orderItemId, verdict });
      track('fit_feedback_submitted', { verdict });
      haptic.success();
      toast(t('orders.fitThanks'), 'success');
      onDone(item.orderItemId);
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section>
      <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--accent-soft)] p-4">
        <p className="text-[14px] font-semibold">{t('orders.rateFit')}</p>
        <p className="mt-0.5 line-clamp-1 text-[12.5px] text-[var(--fg-muted)]">
          {item.title} · {item.sizeLabel}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(
            [
              ['runs_small', t('orders.fitRunsSmall')],
              ['true_to_size', t('orders.fitTrue')],
              ['runs_large', t('orders.fitRunsLarge')],
            ] as const
          ).map(([verdict, label]) => (
            <Button
              key={verdict}
              size="sm"
              variant="outline"
              loading={busy === item.orderItemId}
              onClick={() => void submit(verdict)}
              className="bg-[var(--bg-raised)] !px-2 text-[12px]"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
    </Section>
  );
}
