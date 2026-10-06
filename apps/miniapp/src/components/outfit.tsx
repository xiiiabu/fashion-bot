'use client';

/**
 * The outfit view — spec AI-002/AI-003/AI-006/AI-009.
 *
 * Shared by the stylist screen and the saved-look screen, because a look must
 * read identically whether it was just generated or opened from history. Every
 * row is a real SKU: its brand, its title, the size the fit engine chose and
 * its current price. Nothing here is a placeholder or an "approximately".
 */

import Link from 'next/link';
import type { OutfitSlot, OutfitView } from '@fashion/core';
import { useApp, useT } from '@/lib/app-context';
import { money, moneyCompact } from '@/lib/format';
import { ProductImage } from '@/components/product';
import { Badge, Note, Section, SwapIcon, cx } from '@/components/ui';
import { slotLabel, styleLabel } from '@/lib/taxonomy-labels';
import { haptic } from '@/lib/telegram';

export function OutfitDisplay({
  outfit,
  onSwap,
}: {
  outfit: OutfitView;
  onSwap?: (slot: OutfitSlot) => void;
}) {
  const { locale } = useApp();
  const t = useT();

  return (
    <div className="rise">
      <div className="px-4 pt-6">
        <div className="flex items-start justify-between gap-3">
          <h2 className="t-title min-w-0 flex-1">{outfit.title}</h2>
          <Badge tone={outfit.withinBudget ? 'success' : 'warn'}>
            {outfit.budget
              ? outfit.withinBudget
                ? t('ai.withinBudget')
                : t('ai.overBudget')
              : t('ai.total')}
          </Badge>
        </div>

        {/* AI-006: the narrative, when an LLM produced one, is prose about the
            garments. The deterministic explanation list is always present. */}
        {outfit.narrative && (
          <p className="mt-2.5 text-[14px] leading-relaxed text-[var(--fg-soft)]">{outfit.narrative}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
          {outfit.intent.styles.map((style) => (
            <span
              key={style}
              className="rounded-full bg-[var(--bg-sunken)] px-2.5 py-1 text-[11.5px] text-[var(--fg-muted)]"
            >
              {styleLabel(style, locale)}
            </span>
          ))}
          {outfit.budget && (
            <span className="t-num rounded-full bg-[var(--bg-sunken)] px-2.5 py-1 text-[11.5px] text-[var(--fg-muted)]">
              ≤ {moneyCompact(outfit.budget, locale)}
            </span>
          )}
        </div>
      </div>

      {/* The items. Each row is a real SKU with its size and price. */}
      <div className="mt-5 space-y-px bg-[var(--line-soft)]">
        {outfit.items.map((item) => (
          <div key={`${item.slot}-${item.skuId}`} className="bg-[var(--bg)] px-4 py-3.5">
            <div className="flex gap-3">
              <Link
                href={`/p/${item.product.slug}`}
                onClick={() => haptic.tap('light')}
                className="pressable w-[76px] shrink-0 overflow-hidden rounded-[var(--radius-sm)]"
              >
                <ProductImage
                  url={item.product.media[0]?.url}
                  alt={item.product.title}
                  placeholder={item.product.media[0]?.placeholder}
                  sizes="76px"
                />
              </Link>

              <div className="min-w-0 flex-1">
                <p className="t-eyebrow">{slotLabel(item.slot, locale)}</p>
                <Link href={`/p/${item.product.slug}`} onClick={() => haptic.tap('light')}>
                  <p className="mt-0.5 truncate text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--fg-muted)]">
                    {item.product.brand.name}
                  </p>
                  <h3 className="line-clamp-2 text-[13.5px] leading-snug">{item.product.title}</h3>
                </Link>
                <p className="mt-1 flex items-center gap-2 text-[12.5px]">
                  <span className="t-price">{money(item.price, locale)}</span>
                  <span className="text-[var(--fg-faint)]">
                    {t('pdp.size')} {item.sizeLabel}
                  </span>
                </p>
                {/* FIT-003 inside the look: the size came from the fit engine,
                    and a low-confidence pick says so here too. */}
                {item.fit && !item.fit.confident && (
                  <p className="mt-0.5 text-[11.5px] text-warn">{t('fit.low_confidence')}</p>
                )}
                {item.reasons.length > 0 && (
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-[var(--fg-faint)]">
                    {item.reasons.join(' · ')}
                  </p>
                )}
              </div>

              {onSwap && item.alternativesCount > 0 && (
                <button
                  type="button"
                  onClick={() => onSwap(item.slot)}
                  aria-label={t('ai.swap')}
                  className="pressable flex h-9 shrink-0 items-center gap-1 self-start rounded-full border border-[var(--line)] px-2.5 text-[11.5px] font-medium"
                >
                  <SwapIcon size={13} />
                  <span className="t-num">{item.alternativesCount}</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* AI-003: a slot the engine could not fill is named, not hidden. */}
      {outfit.unfilledSlots.length > 0 && (
        <div className="px-4 pt-4">
          <Note tone="warn">
            {outfit.unfilledSlots
              .map((slot) => `${slotLabel(slot.slot, locale)}: ${slot.reason}`)
              .join(' · ')}
          </Note>
        </div>
      )}

      {outfit.explanation.length > 0 && (
        <Section title={t('ai.why')}>
          <ul className="space-y-2">
            {outfit.explanation.map((line, index) => (
              <li key={index} className="flex gap-2.5 text-[13.5px] leading-relaxed text-[var(--fg-soft)]">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
                {line}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="px-4 pb-2">
        <p className="text-[11.5px] leading-relaxed text-[var(--fg-faint)]">
          {t('ai.disclaimer')}
          {/* AI-009: the engine version is on the record for every look. */}
          <span className="ml-1 opacity-70">
            {outfit.engine.version}
            {outfit.engine.model ? ` · ${outfit.engine.model}` : ''}
          </span>
        </p>
      </div>
    </div>
  );
}
