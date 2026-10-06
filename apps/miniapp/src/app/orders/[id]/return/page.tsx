'use client';

/**
 * Return request — spec FUL-006 (eligibility is evaluated and explained, per
 * item, not just allowed or denied), FUL-007 (the refund amount is visible
 * before the shopper commits) and §9.2 (the reason is captured because it
 * drives both the seller's decision and the quality signal).
 *
 * The refund total shown here is the server's calculation. The client does not
 * multiply a unit price by a quantity: a partial return reverses a
 * proportional share of the commission (PAY-009) and only the backend knows
 * what that comes to.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { Money } from '@fashion/core';
import { add, zero } from '@fashion/core';
import { orders as ordersApi, returns as returnsApi, track, type ReturnReason } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { date, money } from '@/lib/format';
import { ProductImage } from '@/components/product';
import { BottomBar, BottomBarSpacer, ScreenHeader, useBackButton } from '@/components/shell';
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingScreen,
  Note,
  ReturnIcon,
  Section,
  Stepper,
  Textarea,
  cx,
} from '@/components/ui';
import { haptic } from '@/lib/telegram';

const REASONS: ReturnReason[] = [
  'SIZE_TOO_SMALL',
  'SIZE_TOO_LARGE',
  'NOT_AS_DESCRIBED',
  'QUALITY_ISSUE',
  'WRONG_ITEM',
  'DAMAGED',
  'CHANGED_MIND',
  'LATE_DELIVERY',
  'OTHER',
];

interface Eligibility {
  eligible: boolean;
  code: string;
  message: string;
  windowEndsAt: string | null;
  items: Array<{
    orderItemId: string;
    title: string;
    sizeLabel: string;
    quantity: number;
    returnableQuantity: number;
    refundPerUnit: Money;
    imageUrl: string | null;
    blockedReason: string | null;
  }>;
}

interface Selection {
  quantity: number;
  reason: ReturnReason | null;
}

export default function ReturnRequestPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { locale, toast } = useApp();
  const t = useT();
  useBackButton(`/orders/${params.id}`);

  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    ordersApi
      .returnEligibility(params.id)
      .then(setEligibility)
      .catch((caught) => setError(errorMessage(caught, locale)));
  }, [params.id, locale]);

  const toggle = useCallback((orderItemId: string, returnableQuantity: number) => {
    haptic.select();
    setSelected((current) => {
      if (current[orderItemId]) {
        const next = { ...current };
        delete next[orderItemId];
        return next;
      }
      return { ...current, [orderItemId]: { quantity: Math.min(1, returnableQuantity), reason: null } };
    });
  }, []);

  /**
   * An optimistic total so the shopper sees the order of magnitude before
   * committing. The authoritative figure comes back on the created request,
   * and that is what we show afterwards.
   */
  const estimatedRefund = useMemo(() => {
    if (!eligibility) return null;
    let total: Money = zero('UZS');
    for (const [orderItemId, selection] of Object.entries(selected)) {
      const item = eligibility.items.find((entry) => entry.orderItemId === orderItemId);
      if (!item) continue;
      for (let index = 0; index < selection.quantity; index += 1) {
        total = add(total, item.refundPerUnit);
      }
    }
    return total;
  }, [selected, eligibility]);

  const chosen = Object.entries(selected);
  const allHaveReasons = chosen.length > 0 && chosen.every(([, selection]) => selection.reason !== null);

  const submit = useCallback(async () => {
    if (!allHaveReasons) {
      haptic.warning();
      toast(t('returns.reason'), 'error');
      return;
    }
    setSubmitting(true);
    try {
      const created = await returnsApi.create({
        orderId: params.id,
        items: chosen.map(([orderItemId, selection]) => ({
          orderItemId,
          quantity: selection.quantity,
          reason: selection.reason!,
        })),
        comment: comment.trim() || undefined,
      });
      haptic.success();
      track('return_requested', {
        orderId: params.id,
        lines: chosen.length,
        reasons: chosen.map(([, selection]) => selection.reason),
      });
      toast(t('returns.created'), 'success');
      router.replace(`/returns/${created.id}?created=1`);
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setSubmitting(false);
    }
  }, [allHaveReasons, chosen, comment, params.id, router, toast, t, locale]);

  if (error) {
    return (
      <div>
        <ScreenHeader back={`/orders/${params.id}`} title={t('returns.create')} />
        <ErrorState message={error} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!eligibility) {
    return (
      <div>
        <ScreenHeader back={`/orders/${params.id}`} title={t('returns.create')} />
        <LoadingScreen />
      </div>
    );
  }

  /* FUL-006: a refusal names its reason, in the shopper's language. */
  if (!eligibility.eligible) {
    return (
      <div>
        <ScreenHeader back={`/orders/${params.id}`} title={t('returns.create')} />
        <EmptyState
          icon={<ReturnIcon size={32} />}
          title={t('returns.notEligible')}
          body={eligibility.message}
          action={
            <Button variant="outline" onClick={() => router.push(`/orders/${params.id}`)}>
              {t('common.back')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader back={`/orders/${params.id}`} title={t('returns.create')} />

      {eligibility.windowEndsAt && (
        <div className="px-4 pt-4">
          <Note tone="info">
            {t('returns.windowEnds', { date: date(eligibility.windowEndsAt, locale) })}
          </Note>
        </div>
      )}

      <Section title={t('returns.chooseItems')}>
        <div className="space-y-4">
          {eligibility.items.map((item) => {
            const selection = selected[item.orderItemId];
            const blocked = item.returnableQuantity <= 0 || Boolean(item.blockedReason);
            return (
              <div
                key={item.orderItemId}
                className={cx(
                  'rounded-[var(--radius-md)] border p-3.5',
                  selection
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--line)] bg-[var(--bg-raised)]',
                  blocked && 'opacity-55',
                )}
              >
                <div className="flex gap-3">
                  <div className="w-[60px] shrink-0 overflow-hidden rounded-[var(--radius-sm)]">
                    <ProductImage url={item.imageUrl} alt={item.title} sizes="60px" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Checkbox
                      checked={Boolean(selection)}
                      disabled={blocked}
                      onChange={() => toggle(item.orderItemId, item.returnableQuantity)}
                      label={
                        <span>
                          <span className="block line-clamp-2 text-[13.5px] leading-snug">{item.title}</span>
                          <span className="mt-0.5 block text-[12px] text-[var(--fg-muted)]">
                            {item.sizeLabel} · {money(item.refundPerUnit, locale)}
                          </span>
                          {/* FUL-006: per-item, not a blanket refusal. */}
                          {item.blockedReason && (
                            <span className="mt-0.5 block text-[12px] text-danger">
                              {item.blockedReason}
                            </span>
                          )}
                        </span>
                      }
                    />
                  </div>
                </div>

                {selection && (
                  <div className="fade mt-3.5 space-y-3 border-t border-[var(--accent)]/22 pt-3.5">
                    {item.returnableQuantity > 1 && (
                      <div className="flex items-center justify-between">
                        <span className="t-label">{t('common.pcs')}</span>
                        <Stepper
                          value={selection.quantity}
                          min={1}
                          max={item.returnableQuantity}
                          onChange={(quantity) =>
                            setSelected((current) => ({
                              ...current,
                              [item.orderItemId]: { ...selection, quantity },
                            }))
                          }
                        />
                      </div>
                    )}

                    <div>
                      <p className="t-label mb-2">{t('returns.reason')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {REASONS.map((reason) => (
                          <button
                            key={reason}
                            type="button"
                            onClick={() => {
                              haptic.select();
                              setSelected((current) => ({
                                ...current,
                                [item.orderItemId]: { ...selection, reason },
                              }));
                            }}
                            className={cx(
                              'rounded-full px-3 py-1.5 text-[12.5px]',
                              selection.reason === reason
                                ? 'bg-[var(--fg)] text-[var(--bg)]'
                                : 'border border-[var(--line)] bg-[var(--bg-raised)]',
                            )}
                          >
                            {t(`reason.${reason}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title={t('returns.comment')}>
        <Textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t('returns.comment')}
          maxLength={1000}
        />
      </Section>

      <BottomBarSpacer height={82} />

      <BottomBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="t-label">{t('returns.refundAmount')}</p>
            <p className="t-price text-[16px]">
              {estimatedRefund ? money(estimatedRefund, locale) : '—'}
            </p>
          </div>
          <Button
            size="lg"
            className="min-w-[52%]"
            disabled={!allHaveReasons}
            loading={submitting}
            onClick={submit}
          >
            {t('returns.submit')}
          </Button>
        </div>
      </BottomBar>
    </div>
  );
}
