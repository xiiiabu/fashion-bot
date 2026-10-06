'use client';

/**
 * AI stylist — spec §6.1 and AI-001…AI-010.
 *
 * The screen's whole job is to be honest about what the engine did:
 *  - AI-002: every item shown is a real, priced, in-stock SKU, and the look
 *    total is the sum of those SKUs at their current prices.
 *  - AI-003: when a look cannot be built, we say which constraint failed and
 *    what to change. We never show a partial look as if it were complete, and
 *    we never substitute a "similar" item the engine did not choose.
 *  - AI-004: each slot can be swapped without rebuilding the rest.
 *  - AI-006: the explanation talks about the garments, not about the shopper.
 *  - AI-008: the budget is the shopper's constraint, and going over it is
 *    stated rather than hidden.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Money, OutfitSlot, OutfitView, ProductCard } from '@fashion/core';
import {
  ai,
  stylistRefusal,
  track,
  type AiConfig,
  type StylistOverrides,
  type StylistRefusal,
} from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { money, moneyCompact } from '@/lib/format';
import { ProductImage } from '@/components/product';
import { BottomBar, BottomBarSpacer, ScreenHeader, useBackButton } from '@/components/shell';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  Input,
  Note,
  Section,
  Sheet,
  Spinner,
  SparkleIcon,
  SwapIcon,
  cx,
} from '@/components/ui';
import { slotLabel } from '@/lib/taxonomy-labels';
import { OutfitDisplay } from '@/components/outfit';
import { haptic } from '@/lib/telegram';

export default function StylistPage() {
  return (
    <Suspense fallback={<StylistSkeleton />}>
      <StylistScreen />
    </Suspense>
  );
}

type State =
  | { phase: 'idle' }
  | { phase: 'working' }
  | { phase: 'outfit'; outfit: OutfitView }
  /** AI-003: the engine said why it could not build a look. */
  | { phase: 'refused'; refusal: StylistRefusal }
  /** Something else went wrong — a network drop, a rate limit, a fault. */
  | { phase: 'error'; message: string };

function StylistScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const { locale, user, refreshCartCount, toast } = useApp();
  const t = useT();
  useBackButton();

  const [query, setQuery] = useState(params.get('q') ?? '');
  const [budget, setBudget] = useState<number | null>(null);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [examples, setExamples] = useState<string[]>([]);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      query: string;
      total: Money | null;
      itemCount: number;
      thumbnails: string[];
      addedToCart: boolean;
    }>
  >([]);
  const [addingAll, setAddingAll] = useState(false);
  const [swapSlot, setSwapSlot] = useState<OutfitSlot | null>(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Config and history, both optional to the main flow. */
  useEffect(() => {
    ai.config()
      .then((config: AiConfig) => {
        // The rules engine is what builds the look; the LLM only rewords it, so
        // `available` is the flag that decides whether the brief can be sent.
        setAiEnabled(config.available);
        setExamples(config.suggestions.slice(0, 6));
      })
      .catch(() => {});
    ai.history()
      .then((data) => setHistory(data.items.slice(0, 6)))
      .catch(() => {});
  }, []);

  const generate = useCallback(
    async (brief: string, overrides?: StylistOverrides) => {
      const trimmed = brief.trim();
      if (trimmed.length < 2) {
        inputRef.current?.focus();
        return;
      }
      inputRef.current?.blur();
      setState({ phase: 'working' });
      haptic.tap('medium');
      try {
        const outfit = await ai.generate(trimmed, {
          ...overrides,
          budgetMajor: budget ?? overrides?.budgetMajor ?? null,
        });
        setState({ phase: 'outfit', outfit });
        haptic.success();
        track('ai_look_generated', {
          succeeded: true,
          outfitId: outfit.id,
          items: outfit.items.length,
          withinBudget: outfit.withinBudget,
        });
      } catch (caught) {
        // AI-003: the engine refuses with a structured reason. That is a
        // result the shopper can act on, not a fault, so it gets its own
        // screen; anything without a reason really is an error.
        const refusal = stylistRefusal(caught);
        if (refusal) {
          setState({ phase: 'refused', refusal });
          haptic.warning();
          track('ai_look_generated', { succeeded: false, reason: refusal.code });
        } else {
          setState({ phase: 'error', message: errorMessage(caught, locale) });
        }
      }
    },
    [budget, locale],
  );

  /* A deep link or a tapped example runs immediately. */
  const autoQuery = params.get('q');
  useEffect(() => {
    if (autoQuery && state.phase === 'idle') void generate(autoQuery);
    // Run once per incoming query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoQuery]);

  const replaceItem = useCallback(
    async (slot: OutfitSlot, skuId: string | null) => {
      if (state.phase !== 'outfit') return;
      const id = state.outfit.id;
      setSwapSlot(null);
      setState({ phase: 'working' });
      try {
        const outfit = await ai.replaceItem(id, slot, skuId);
        setState({ phase: 'outfit', outfit });
        haptic.success();
        track('ai_item_replaced', { outfitId: id, slot });
      } catch (caught) {
        const refusal = stylistRefusal(caught);
        if (refusal) setState({ phase: 'refused', refusal });
        else setState({ phase: 'error', message: errorMessage(caught, locale) });
      }
    },
    [state, locale],
  );

  const addWholeLook = useCallback(async () => {
    if (state.phase !== 'outfit') return;
    setAddingAll(true);
    try {
      await ai.addToCart(state.outfit.id);
      await refreshCartCount();
      haptic.success();
      toast(t('ai.addedAll'), 'success');
      track('ai_look_added_to_cart', { outfitId: state.outfit.id });
      router.push('/cart');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setAddingAll(false);
    }
  }, [state, refreshCartCount, toast, t, locale, router]);

  const personalizationOff = user && !user.personalizationEnabled;

  return (
    <div>
      <ScreenHeader back title={t('ai.title')} />

      {/* ── Brief ──────────────────────────────────────────────────────── */}
      <div className="px-4 pt-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void generate(query);
          }}
        >
          <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)] p-3.5">
            <textarea
              ref={inputRef as unknown as React.RefObject<HTMLTextAreaElement>}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('ai.placeholder')}
              rows={2}
              enterKeyHint="send"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void generate(query);
                }
              }}
              className="w-full resize-none bg-transparent text-[15px] leading-relaxed placeholder:text-[var(--fg-faint)] focus:outline-none"
            />
            <div className="mt-2.5 flex items-center gap-2 border-t border-[var(--line-soft)] pt-2.5">
              <BudgetField value={budget} onChange={setBudget} />
              <div className="flex-1" />
              <Button
                size="sm"
                type="submit"
                disabled={!aiEnabled || query.trim().length < 2}
                loading={state.phase === 'working'}
                icon={<SparkleIcon size={14} />}
              >
                {t('ai.generate')}
              </Button>
            </div>
          </div>
        </form>

        {!aiEnabled && (
          <div className="mt-3">
            <Note tone="neutral">{t('err.FEATURE_DISABLED')}</Note>
          </div>
        )}

        {/* USR-004: without personalisation consent the stylist works from the
            brief alone, and we say so rather than quietly degrading. */}
        {personalizationOff && state.phase === 'idle' && (
          <div className="mt-3">
            <Note tone="info">
              {t('ai.notPersonalized')}{' '}
              <Link href="/profile/privacy" className="font-semibold underline underline-offset-2">
                {t('privacy.title')}
              </Link>
            </Note>
          </div>
        )}
      </div>

      {/* ── Examples and history, only on the empty screen ─────────────── */}
      {state.phase === 'idle' && (
        <>
          {examples.length > 0 && (
            <Section flush title={t('ai.examplesTitle')} className="pt-6">
              <div className="flex flex-col gap-2 px-4">
                {examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => {
                      setQuery(example);
                      void generate(example);
                    }}
                    className="pressable rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--bg-raised)] px-3.5 py-3 text-left text-[13.5px] leading-snug"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </Section>
          )}

          {history.length > 0 && (
            <Section flush title={t('ai.history')}>
              <div className="rail">
                {history.map((entry) => (
                  <Link
                    key={entry.id}
                    href={`/stylist/${entry.id}`}
                    onClick={() => haptic.tap('light')}
                    className="pressable w-[148px]"
                  >
                    <div className="relative">
                      <div className="grid aspect-[4/5] grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-md)] bg-[var(--line-soft)]">
                        {/* Always four cells, so a look with two items does not
                            render a lopsided tile. */}
                        {Array.from({ length: 4 }).map((_, index) => (
                          <ProductImage
                            key={index}
                            url={entry.thumbnails[index]}
                            alt=""
                            ratio="square"
                            className="h-full"
                            sizes="74px"
                          />
                        ))}
                      </div>
                      {entry.itemCount > 0 && (
                        <span className="absolute left-1.5 top-1.5">
                          <Badge tone="dark">{entry.itemCount}</Badge>
                        </span>
                      )}
                    </div>
                    <p className="mt-2 line-clamp-2 text-[12.5px] leading-snug">{entry.query}</p>
                    <p className="t-price mt-0.5 text-[12px] text-[var(--fg-muted)]">
                      {entry.total ? moneyCompact(entry.total, locale) : '—'}
                    </p>
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {/* ── Working ────────────────────────────────────────────────────── */}
      {state.phase === 'working' && <WorkingState label={t('ai.generating')} />}

      {/* ── Refusal (AI-003) ──────────────────────────────────────────── */}
      {state.phase === 'refused' && (
        <RefusalState refusal={state.refusal} onRetry={() => setState({ phase: 'idle' })} />
      )}

      {state.phase === 'error' && (
        <EmptyState
          title={t('common.error')}
          body={state.message}
          action={
            <Button variant="outline" onClick={() => void generate(query)}>
              {t('common.retry')}
            </Button>
          }
        />
      )}

      {/* ── The look ──────────────────────────────────────────────────── */}
      {state.phase === 'outfit' && (
        <>
          <OutfitDisplay
            outfit={state.outfit}
            onSwap={(slot) => {
              haptic.tap('light');
              setSwapSlot(slot);
            }}
          />
          <BottomBarSpacer height={82} />
          <BottomBar>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="t-price text-[16px]">{money(state.outfit.total, locale)}</p>
                <p className="truncate text-[11.5px] text-[var(--fg-faint)]">
                  {state.outfit.items.length} · {t('ai.sellers', { n: state.outfit.sellerCount })}
                </p>
              </div>
              <Button size="lg" className="min-w-[52%]" loading={addingAll} onClick={addWholeLook}>
                {t('ai.addAll')}
              </Button>
            </div>
          </BottomBar>
        </>
      )}

      {state.phase === 'outfit' && swapSlot && (
        <SwapSheet
          outfitId={state.outfit.id}
          slot={swapSlot}
          onClose={() => setSwapSlot(null)}
          onPick={(skuId) => void replaceItem(swapSlot, skuId)}
        />
      )}
    </div>
  );
}

/* ── Budget ──────────────────────────────────────────────────────────────── */

/**
 * AI-008: the budget is in soum, which is how a shopper states it. The API
 * converts to minor units; nothing here does money arithmetic.
 */
function BudgetField({ value, onChange }: { value: number | null; onChange: (next: number | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const presets = [1_500_000, 3_000_000, 5_000_000, 10_000_000];

  return (
    <>
      <Chip selected={value !== null} onClick={() => setOpen(true)}>
        {value === null
          ? t('ai.budget')
          : `${t('ai.budget')} ${new Intl.NumberFormat('ru-RU').format(value)}`}
      </Chip>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('ai.budget')}>
        <div className="space-y-4 pb-2">
          <div className="flex flex-wrap gap-2">
            <Chip
              selected={value === null}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              {t('ai.budgetAny')}
            </Chip>
            {presets.map((preset) => (
              <Chip
                key={preset}
                selected={value === preset}
                onClick={() => {
                  onChange(preset);
                  setOpen(false);
                }}
              >
                {new Intl.NumberFormat('ru-RU').format(preset)}
              </Chip>
            ))}
          </div>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step={100_000}
            placeholder="3 000 000"
            defaultValue={value ?? ''}
            onBlur={(event) => {
              const next = Number(event.target.value);
              onChange(Number.isFinite(next) && next > 0 ? next : null);
            }}
            aria-label={t('ai.budget')}
          />
          <Button block onClick={() => setOpen(false)}>
            {t('common.apply')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/* ── Working ─────────────────────────────────────────────────────────────── */

/**
 * The stylist takes a second or two. Rather than a blank spinner, this shows
 * the slots filling in sequence, which is literally what the engine is doing
 * (retrieve per slot, then search for a compatible combination).
 */
function WorkingState({ label }: { label: string }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setStep((value) => (value + 1) % 4), 420);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="flex flex-col items-center gap-5 px-8 py-20">
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={cx(
              'h-10 w-8 rounded-[var(--radius-sm)] transition-colors duration-300',
              index <= step ? 'bg-[var(--accent)]' : 'bg-[var(--bg-sunken)]',
            )}
          />
        ))}
      </div>
      <p className="text-[13.5px] text-[var(--fg-muted)]">{label}</p>
    </div>
  );
}

/* ── Failure ─────────────────────────────────────────────────────────────── */

function RefusalState({
  refusal,
  onRetry,
}: {
  refusal: StylistRefusal;
  onRetry: () => void;
}) {
  const { locale } = useApp();
  const t = useT();

  const headline =
    refusal.code === 'BUDGET_TOO_LOW'
      ? t('ai.failBudget')
      : refusal.code === 'EMPTY_SLOTS'
        ? t('ai.failEmptySlots')
        : refusal.code === 'NO_COMPATIBLE_COMBINATION'
          ? t('ai.failNoCombo')
          : t('ai.failNoCombo');

  return (
    <div className="px-4 py-10">
      <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)] p-5">
        <h2 className="t-section max-w-[26ch]">{headline}</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--fg-muted)]">
          {t('ai.failHint')}
        </p>

        {/* AI-003: concrete, not "try something else". The engine knows what
            the cheapest buildable combination costs, so we say it. */}
        {refusal.minimumBudget && (
          <div className="mt-4">
            <Note tone="info">
              {t('ai.nearestBudget', {
                amount: money({ amount: refusal.minimumBudget, currency: 'UZS' }, locale),
              })}
            </Note>
          </div>
        )}

        {refusal.emptySlots.length > 0 && (
          <div className="mt-4">
            <h3 className="t-eyebrow mb-2">{t('ai.slotsFound')}</h3>
            <ul className="space-y-1.5">
              {refusal.emptySlots.map((slot) => (
                <li key={slot} className="flex items-center justify-between text-[13px]">
                  <span>{slotLabel(slot, locale)}</span>
                  <span className="t-num text-danger">0</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {refusal.detail && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--fg-faint)]">{refusal.detail}</p>
        )}

        {refusal.suggestions.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {refusal.suggestions.slice(0, 4).map((suggestion) => (
              <Link
                key={suggestion}
                href={`/stylist?q=${encodeURIComponent(suggestion)}`}
                className="pressable rounded-[var(--radius-md)] border border-[var(--line)] px-3.5 py-2.5 text-[13px] leading-snug"
              >
                {suggestion}
              </Link>
            ))}
          </div>
        )}

        <Button variant="outline" block className="mt-5" onClick={onRetry}>
          {t('ai.tryAgain')}
        </Button>
      </div>
    </div>
  );
}

/* ── Outfit ──────────────────────────────────────────────────────────────── */

/* ── Swap ────────────────────────────────────────────────────────────────── */

/** AI-004: alternatives for one slot, scored by the same engine. */
function SwapSheet({
  outfitId,
  slot,
  onClose,
  onPick,
}: {
  outfitId: string;
  slot: OutfitSlot;
  onClose: () => void;
  onPick: (skuId: string | null) => void;
}) {
  const { locale } = useApp();
  const t = useT();
  const [items, setItems] = useState<
    Array<{ skuId: string; sizeLabel: string; product: ProductCard; score: number }> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    ai.alternatives(outfitId, slot)
      .then((data) => {
        if (!cancelled) setItems(data.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [outfitId, slot]);

  return (
    <Sheet open onClose={onClose} title={`${t('ai.swapItem')} · ${slotLabel(slot, locale)}`} height="tall">
      {!items && (
        <div className="flex justify-center py-10">
          <Spinner size={18} className="text-[var(--fg-faint)]" />
        </div>
      )}

      {items && items.length === 0 && (
        <EmptyState title={t('common.empty')} body={t('ai.failHint')} />
      )}

      {items && items.length > 0 && (
        <div className="space-y-3 pb-2">
          {/* Letting the engine re-pick is a distinct, honest option. */}
          <button
            type="button"
            onClick={() => onPick(null)}
            className="pressable flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--bg-raised)] p-3.5 text-left"
          >
            <SparkleIcon size={17} className="shrink-0 text-[var(--accent)]" />
            <span className="text-[13.5px] font-medium">{t('ai.tryAgain')}</span>
          </button>

          {items.map((item) => (
            <button
              key={item.skuId}
              type="button"
              onClick={() => onPick(item.skuId)}
              className="pressable flex w-full gap-3 text-left"
            >
              <div className="w-[64px] shrink-0 overflow-hidden rounded-[var(--radius-sm)]">
                <ProductImage url={item.product.media[0]?.url} alt={item.product.title} sizes="64px" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[var(--fg-muted)]">
                  {item.product.brand.name}
                </p>
                <h4 className="line-clamp-2 text-[13px] leading-snug">{item.product.title}</h4>
                <p className="mt-0.5 flex items-center gap-2 text-[12.5px]">
                  <span className="t-price">{money(item.product.price, locale)}</span>
                  <span className="text-[var(--fg-faint)]">{item.sizeLabel}</span>
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function StylistSkeleton() {
  return (
    <div className="px-4 pt-16">
      <Spinner size={18} className="mx-auto text-[var(--fg-faint)]" />
    </div>
  );
}
