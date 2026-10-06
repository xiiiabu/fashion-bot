'use client';

/**
 * Checkout — spec ORD-002 (the backend quotes), ORD-004 (one master order split
 * per seller), ORD-006 (idempotent confirmation), CAT-008 (the stock hold has a
 * TTL and the shopper is told) and §8.4 (payments are not live in this release).
 *
 * Three things this screen is careful about:
 *  1. The reservation countdown is real. When it lapses the quote is re-fetched
 *     rather than left stale, because confirming a stale quote is exactly how a
 *     shopper ends up charged a price they never saw.
 *  2. Confirmation carries an idempotency key, so a double tap or a flaky
 *     network cannot produce two orders.
 *  3. Payment is clearly labelled as a sandbox. Nothing here implies money
 *     moved when it did not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AddressView, CheckoutQuote, DeliveryEstimate } from '@fashion/core';
import { ApiRequestError } from '@/lib/api';
import {
  addresses as addressApi,
  cart as cartApi,
  checkout as checkoutApi,
  payments as paymentsApi,
  track,
  type PaymentProvider,
} from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { deliveryRange, minutesLeft, money, time } from '@/lib/format';
import { BottomBar, BottomBarSpacer, ScreenHeader, useBackButton } from '@/components/shell';
import {
  Button,
  ClockIcon,
  ErrorState,
  LoadingScreen,
  LockIcon,
  Note,
  Radio,
  Section,
  Sheet,
  Spinner,
  Textarea,
  cx,
} from '@/components/ui';
import { AddressForm } from '@/components/address-form';
import { haptic, openExternal, setClosingConfirmation } from '@/lib/telegram';

export default function CheckoutPage() {
  const router = useRouter();
  const { locale, refreshCartCount, toast, config } = useApp();
  const t = useT();
  useBackButton('/cart');

  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [addressList, setAddressList] = useState<AddressView[] | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [deliveryChoices, setDeliveryChoices] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [providers, setProviders] = useState<PaymentProvider[] | null>(null);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [addressSheet, setAddressSheet] = useState(false);
  const [deliverySheet, setDeliverySheet] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const requestedRef = useRef(false);

  /* ── Quote ─────────────────────────────────────────────────────────────── */

  const requestQuote = useCallback(
    async (nextAddressId: string | null, choices: Record<string, string>) => {
      setQuoting(true);
      setError(null);
      try {
        const next = await checkoutApi.quote({
          addressId: nextAddressId,
          deliveryChoices: Object.keys(choices).length > 0 ? choices : undefined,
        });
        setQuote(next);
        // Keep whatever the server actually chose, so the UI never shows a
        // delivery method the quote did not price.
        setDeliveryChoices(
          Object.fromEntries(next.groups.map((group) => [group.sellerId, group.deliveryMethodCode])),
        );
        if (next.addressId) setAddressId(next.addressId);
        return next;
      } catch (caught) {
        setError(errorMessage(caught, locale));
        return null;
      } finally {
        setQuoting(false);
      }
    },
    [locale],
  );

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void (async () => {
      const list = await addressApi.list().then((data) => data.items).catch(() => []);
      setAddressList(list);
      const preferred = list.find((address) => address.isDefault) ?? list[0] ?? null;
      setAddressId(preferred?.id ?? null);
      await requestQuote(preferred?.id ?? null, {});
      track('checkout_started');
    })();
  }, [requestQuote]);

  /* Payment providers. §8.4: none is live in this release, but the contract
     the sandbox runs is the real one, right down to the PSP fee. */
  useEffect(() => {
    paymentsApi
      .methods()
      .then((data) => {
        setProviders(data.providers);
        setPaymentNotice(data.notice);
        setProvider(data.providers.find((entry) => entry.enabled)?.code ?? null);
      })
      .catch(() => setProviders([]));
  }, []);

  /* ── Reservation countdown (CAT-008) ──────────────────────────────────── */

  useEffect(() => {
    if (!quote) return;
    const tick = () => setCountdown(minutesLeft(quote.reservationExpiresAt));
    tick();
    const timer = window.setInterval(tick, 20_000);
    return () => window.clearInterval(timer);
  }, [quote]);

  /** When the hold lapses the quote is worthless; get a fresh one at once. */
  useEffect(() => {
    if (!quote || countdown !== null) return;
    toast(t('checkout.holdExpired'), 'error');
    void requestQuote(addressId, deliveryChoices);
    // Only react to the countdown reaching zero.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  /* Warn before closing mid-checkout; this is the one place it is worth it. */
  useEffect(() => {
    setClosingConfirmation(true);
    return () => setClosingConfirmation(false);
  }, []);

  /* ── Confirm ───────────────────────────────────────────────────────────── */

  const place = useCallback(async () => {
    if (!quote) return;
    if (!addressId) {
      toast(t('checkout.chooseAddress'), 'error');
      setAddressSheet(true);
      return;
    }
    setPlacing(true);
    try {
      const order = await checkoutApi.confirm({
        quoteId: quote.id,
        addressId,
        customerNote: note.trim() || null,
      });
      await refreshCartCount();
      haptic.success();
      track('payment_initiated', { orderId: order.id, provider });
      setClosingConfirmation(false);

      // The order exists and is awaiting payment. Initialising the payment
      // session is a separate step so a payment failure never loses the order.
      if (provider) {
        try {
          const session = await paymentsApi.init({
            orderId: order.id,
            provider,
            returnUrl: `${window.location.origin}/orders/${order.id}`,
          });
          if (session.redirectUrl) {
            // The sandbox page lives on the API, outside the Mini App, so it
            // opens externally and the shopper returns to the order.
            openExternal(session.redirectUrl);
          }
        } catch (caught) {
          toast(errorMessage(caught, locale), 'error');
        }
      }

      router.replace(`/orders/${order.id}?placed=1`);
    } catch (caught) {
      // QUOTE_EXPIRED and OUT_OF_STOCK are the two the shopper can act on, so
      // they re-quote instead of showing a dead end.
      if (
        caught instanceof ApiRequestError &&
        (caught.code === 'QUOTE_EXPIRED' || caught.code === 'RESERVATION_EXPIRED')
      ) {
        toast(t('checkout.quoteExpired'), 'error');
        await requestQuote(addressId, deliveryChoices);
      } else {
        toast(errorMessage(caught, locale), 'error');
      }
    } finally {
      setPlacing(false);
    }
  }, [
    quote,
    addressId,
    note,
    provider,
    refreshCartCount,
    router,
    toast,
    t,
    locale,
    requestQuote,
    deliveryChoices,
  ]);

  const selectedAddress = useMemo(
    () => addressList?.find((address) => address.id === addressId) ?? null,
    [addressList, addressId],
  );

  if (error && !quote) {
    return (
      <div>
        <ScreenHeader back="/cart" title={t('checkout.title')} />
        <ErrorState
          message={error}
          onRetry={() => void requestQuote(addressId, deliveryChoices)}
          retryLabel={t('common.retry')}
        />
      </div>
    );
  }

  if (!quote) {
    return (
      <div>
        <ScreenHeader back="/cart" title={t('checkout.title')} />
        <LoadingScreen />
      </div>
    );
  }

  const paymentsLive = config?.paymentsLive ?? false;

  return (
    <div>
      <ScreenHeader back="/cart" title={t('checkout.title')} />

      {/* CAT-008: the hold is finite and the shopper can see how long is left. */}
      {countdown !== null && (
        <div className="flex items-center gap-2 bg-[var(--accent-soft)] px-4 py-2.5 text-[12.5px] text-[var(--accent-deep)]">
          <ClockIcon size={14} />
          {t('checkout.holdExpires', { time: time(quote.reservationExpiresAt, locale) })}
          <span className="t-num ml-auto font-semibold">{countdown} min</span>
        </div>
      )}

      {/* ── Address ───────────────────────────────────────────────────── */}
      <Section title={t('checkout.address')}>
        {selectedAddress ? (
          <button
            type="button"
            onClick={() => {
              haptic.tap('light');
              setAddressSheet(true);
            }}
            className="pressable w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--bg-raised)] p-3.5 text-left"
          >
            <p className="text-[14px] font-medium">{selectedAddress.recipientName}</p>
            <p className="mt-0.5 text-[13px] leading-snug text-[var(--fg-muted)]">
              {[
                selectedAddress.city,
                selectedAddress.district,
                selectedAddress.street,
                selectedAddress.building,
                selectedAddress.apartment ? `кв. ${selectedAddress.apartment}` : null,
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
            <p className="t-num mt-0.5 text-[12.5px] text-[var(--fg-faint)]">{selectedAddress.phone}</p>
            <span className="mt-2 inline-block text-[12.5px] font-semibold text-[var(--accent)]">
              {t('common.edit')}
            </span>
          </button>
        ) : (
          <Button variant="outline" block onClick={() => setAddressSheet(true)}>
            {t('checkout.addAddress')}
          </Button>
        )}
      </Section>

      {/* ── Per-seller groups (ORD-004) ───────────────────────────────── */}
      <Section title={t('checkout.summary')}>
        {quote.groups.length > 1 && (
          <p className="mb-3 text-[12.5px] text-[var(--fg-muted)]">
            {t('checkout.sellersNote', { n: quote.groups.length })}
          </p>
        )}
        <div className="space-y-3">
          {quote.groups.map((group) => {
            const lines = quote.lines.filter((line) => line.sellerId === group.sellerId);
            return (
              <div
                key={group.sellerId}
                className="rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--bg-raised)] p-3.5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="min-w-0 truncate text-[14px] font-semibold">{group.sellerName}</h3>
                  <span className="t-price shrink-0 text-[13.5px]">{money(group.goodsTotal, locale)}</span>
                </div>

                <ul className="mt-2.5 space-y-1.5">
                  {lines.map((line) => (
                    <li key={line.cartItemId} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                      <span className="min-w-0 truncate text-[var(--fg-muted)]">
                        {line.title}
                        {line.quantity > 1 && <span className="t-num"> × {line.quantity}</span>}
                      </span>
                      <span className="t-num shrink-0">{money(line.lineTotal, locale)}</span>
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  onClick={() => {
                    haptic.tap('light');
                    setDeliverySheet(group.sellerId);
                  }}
                  className="mt-3 flex w-full items-center justify-between gap-3 border-t border-[var(--line-soft)] pt-2.5 text-left"
                >
                  <span className="min-w-0">
                    <span className="t-label block">{t('checkout.deliveryMethod')}</span>
                    <span className="block truncate text-[13px]">
                      {group.deliveryName} ·{' '}
                      {deliveryRange(group.minDays, group.maxDays, locale)}
                    </span>
                  </span>
                  <span className="t-price shrink-0 text-[13px]">{money(group.deliveryPrice, locale)}</span>
                </button>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ── Payment (§8.4) ───────────────────────────────────────────── */}
      <Section title={t('checkout.payment')}>
        {!paymentsLive && (
          <div className="mb-3">
            <Note tone="warn" title={t('checkout.paymentsNotLive')} icon={<LockIcon size={15} />}>
              {paymentNotice ?? t('checkout.paymentsNotLiveBody')}
            </Note>
          </div>
        )}

        {providers === null ? (
          <div className="flex justify-center py-5">
            <Spinner size={16} className="text-[var(--fg-faint)]" />
          </div>
        ) : providers.length === 0 ? (
          <Note tone="neutral">{t('err.FEATURE_DISABLED')}</Note>
        ) : (
          <div className="space-y-2">
            {providers.map((entry) => (
              <Radio
                key={entry.code}
                checked={provider === entry.code}
                disabled={!entry.enabled}
                onChange={() => setProvider(entry.code)}
                label={entry.name}
                // The instruments the provider accepts are the honest hint:
                // "Humo, Uzcard" tells the shopper more than a tagline.
                hint={
                  entry.methods.length > 0
                    ? entry.methods.join(' · ')
                    : entry.enabled
                      ? undefined
                      : t('err.FEATURE_DISABLED')
                }
                trailing={
                  !entry.live ? (
                    <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-warn">
                      {t('checkout.sandboxPay')}
                    </span>
                  ) : undefined
                }
              />
            ))}
          </div>
        )}
      </Section>

      {/* ── Note ──────────────────────────────────────────────────────── */}
      <Section title={t('checkout.note')}>
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t('checkout.notePlaceholder')}
          maxLength={500}
        />
      </Section>

      {/* ── Totals (ORD-002: the server's figures) ────────────────────── */}
      <section className="border-t border-[var(--line)] px-4 py-5">
        <dl className="space-y-2.5">
          <Total label={t('cart.subtotal')} value={money(quote.goodsTotal, locale)} />
          {quote.discountTotal.amount !== '0' && (
            <Total label={t('cart.discount')} value={`−${money(quote.discountTotal, locale)}`} />
          )}
          <Total label={t('cart.delivery')} value={money(quote.deliveryTotal, locale)} />
          <div className="h-px bg-[var(--line)]" />
          <Total label={t('cart.total')} value={money(quote.grandTotal, locale)} strong />
        </dl>

        {quote.warnings.length > 0 && (
          <div className="mt-4 space-y-2">
            {quote.warnings.map((warning) => (
              <Note key={`${warning.code}-${warning.skuId ?? ''}`} tone="warn">
                {warning.message}
              </Note>
            ))}
          </div>
        )}

        {quote.fiscal?.receiptRequired && (
          <p className="mt-3 text-[11.5px] text-[var(--fg-faint)]">{t('checkout.fiscalNote')}</p>
        )}
      </section>

      <BottomBarSpacer height={82} />

      <BottomBar>
        <Button
          size="lg"
          block
          loading={placing || quoting}
          disabled={!addressId || quoting}
          onClick={place}
        >
          {placing
            ? t('checkout.placing')
            : t('checkout.pay', { amount: money(quote.grandTotal, locale) })}
        </Button>
      </BottomBar>

      {/* ── Sheets ────────────────────────────────────────────────────── */}
      <Sheet
        open={addressSheet}
        onClose={() => setAddressSheet(false)}
        title={t('checkout.chooseAddress')}
        height="tall"
      >
        <div className="space-y-2 pb-2">
          {(addressList ?? []).map((address) => (
            <Radio
              key={address.id}
              checked={address.id === addressId}
              onChange={() => {
                setAddressId(address.id);
                setAddressSheet(false);
                void requestQuote(address.id, deliveryChoices);
              }}
              label={address.label || address.recipientName}
              hint={[address.city, address.street, address.building].filter(Boolean).join(', ')}
            />
          ))}

          <div className="pt-3">
            <AddressForm
              onSaved={(created) => {
                setAddressList((current) => [...(current ?? []), created]);
                setAddressId(created.id);
                setAddressSheet(false);
                void requestQuote(created.id, deliveryChoices);
              }}
            />
          </div>
        </div>
      </Sheet>

      <DeliverySheet
        sellerId={deliverySheet}
        quote={quote}
        onClose={() => setDeliverySheet(null)}
        onPick={(sellerId, methodCode) => {
          const next = { ...deliveryChoices, [sellerId]: methodCode };
          setDeliveryChoices(next);
          setDeliverySheet(null);
          void requestQuote(addressId, next);
        }}
      />
    </div>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cx(strong ? 'text-[15px] font-semibold' : 'text-[13.5px] text-[var(--fg-muted)]')}>
        {label}
      </dt>
      <dd className={cx('t-price', strong ? 'text-[18px]' : 'text-[13.5px]')}>{value}</dd>
    </div>
  );
}

/**
 * The delivery options for one seller. They come from the cart read rather than
 * the quote, because the quote only carries the chosen method — asking the cart
 * keeps the list and its prices server-authoritative.
 */
function DeliverySheet({
  sellerId,
  quote,
  onClose,
  onPick,
}: {
  sellerId: string | null;
  quote: CheckoutQuote;
  onClose: () => void;
  onPick: (sellerId: string, methodCode: string) => void;
}) {
  const { locale } = useApp();
  const t = useT();
  const [options, setOptions] = useState<DeliveryEstimate[] | null>(null);

  useEffect(() => {
    if (!sellerId) {
      setOptions(null);
      return;
    }
    let cancelled = false;
    cartApi
      .get()
      .then((data) => {
        if (cancelled) return;
        const group = data.groups.find((entry) => entry.sellerId === sellerId);
        setOptions(group?.deliveryOptions ?? []);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sellerId]);

  if (!sellerId) return null;
  const current = quote.groups.find((group) => group.sellerId === sellerId);

  return (
    <Sheet open onClose={onClose} title={t('checkout.deliveryMethod')}>
      {!options && (
        <div className="flex justify-center py-8">
          <Spinner size={16} className="text-[var(--fg-faint)]" />
        </div>
      )}
      {options && (
        <div className="space-y-2 pb-2">
          {options.map((option) => (
            <Radio
              key={option.methodCode}
              checked={current?.deliveryMethodCode === option.methodCode}
              onChange={() => onPick(sellerId, option.methodCode)}
              label={option.name}
              hint={deliveryRange(option.minDays, option.maxDays, locale)}
              trailing={money(option.price, locale)}
            />
          ))}
        </div>
      )}
    </Sheet>
  );
}
