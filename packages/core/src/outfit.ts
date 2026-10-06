/**
 * Outfit compatibility and assembly — spec §6.1 (AI-002 … AI-010).
 *
 * The critical guardrail from the spec (§6.3): an LLM never produces a SKU id,
 * a price, a size or stock. This module receives candidates that the commerce
 * backend has already filtered to published, priced, in-stock SKUs and selects
 * among them with deterministic rules. The LLM, if configured at all, only
 * rewords the explanation afterwards.
 *
 * Hard rules reject a combination outright; soft rules move a score (AI-004).
 */

import { type Money, add, compare, money, sum, toBigInt, zero } from './money.js';
import {
  type ColorFamily,
  type FormalityLevel,
  type Occasion,
  type OutfitSlot,
  type OutfitTemplate,
  type Season,
  type Silhouette,
  type StyleTag,
  type WarmthLevel,
  SEASON_WARMTH,
  STYLE_FORMALITY,
  colorsAffine,
  colorsClash,
  isNeutral,
  stylesConflict,
} from './taxonomy.js';

/** A candidate the commerce layer has already validated as buyable. */
export interface OutfitCandidate {
  readonly skuId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly brandId: string;
  readonly brandName: string;
  readonly title: string;
  readonly categorySlug: string;
  readonly slot: OutfitSlot;
  readonly price: Money;
  readonly compareAtPrice?: Money | null;
  readonly sizeLabel: string;
  readonly available: number;
  readonly styleTags: StyleTag[];
  readonly colorFamily: ColorFamily;
  readonly silhouette: Silhouette | null;
  readonly formality: FormalityLevel;
  readonly warmth: WarmthLevel;
  readonly season: Season;
  readonly imageUrl: string | null;
  /** AI-010: an editor-curated look this item belongs to acts as a prior. */
  readonly curatedLookIds?: string[];
  /** Popularity in [0,1], used only as a tie-break. */
  readonly popularity?: number;
  /** Hard constraints declared on the product (§5.1 "compatibility constraints"). */
  readonly incompatibleWithSlots?: OutfitSlot[];
  readonly incompatibleWithStyles?: StyleTag[];
}

export interface StyleIntent {
  readonly styles: StyleTag[];
  readonly occasions: Occasion[];
  readonly season: Season | null;
  /** Total budget for the whole look; null means unconstrained. */
  readonly budget: Money | null;
  readonly preferredColors: ColorFamily[];
  readonly avoidColors: ColorFamily[];
  readonly preferredBrandIds: string[];
  readonly excludedBrandIds: string[];
  readonly requiredSlots: OutfitSlot[];
  readonly excludedSlots: OutfitSlot[];
  readonly gender?: 'women' | 'men' | 'unisex' | null;
  readonly freeText?: string;
}

export const HARD_RULE_CODES = [
  'budget_exceeded',
  'style_conflict',
  'formality_spread',
  'season_mismatch',
  'color_clash',
  'excluded_brand',
  'excluded_slot',
  'out_of_stock',
  'declared_incompatibility',
  'duplicate_product',
] as const;

export type HardRuleCode = (typeof HARD_RULE_CODES)[number];

export const SOFT_RULE_CODES = [
  'style_match',
  'occasion_match',
  'color_harmony',
  'color_preference',
  'formality_coherence',
  'season_fit',
  'budget_utilisation',
  'price_balance',
  'brand_preference',
  'curated_prior',
  'silhouette_balance',
  'popularity',
] as const;

export type SoftRuleCode = (typeof SOFT_RULE_CODES)[number];

export interface RuleHit {
  readonly code: SoftRuleCode;
  readonly delta: number;
  readonly detail?: string;
}

export interface OutfitItem {
  readonly slot: OutfitSlot;
  readonly candidate: OutfitCandidate;
  readonly itemScore: number;
  readonly hits: RuleHit[];
}

export interface AssembledOutfit {
  readonly items: OutfitItem[];
  readonly total: Money;
  readonly score: number;
  readonly softHits: RuleHit[];
  /** Slots the template wanted but the catalogue could not fill honestly. */
  readonly unfilledSlots: Array<{ slot: OutfitSlot; required: boolean; reason: string }>;
  readonly templateKey: string;
  readonly withinBudget: boolean;
  readonly dominantColors: ColorFamily[];
  readonly formalitySpread: number;
}

export interface AssembleOptions {
  readonly template: OutfitTemplate;
  readonly intent: StyleIntent;
  readonly candidatesBySlot: Map<OutfitSlot, OutfitCandidate[]>;
  /** Items the shopper pinned; they are kept whatever the score says (AI-007). */
  readonly locked?: Map<OutfitSlot, OutfitCandidate>;
  /** SKUs to avoid, e.g. the one being replaced (AI-007). */
  readonly excludeSkuIds?: Set<string>;
  readonly beamWidth?: number;
  readonly maxAlternativesPerSlot?: number;
}

/** Score a single candidate against the intent, before combination effects. */
export function scoreCandidate(candidate: OutfitCandidate, intent: StyleIntent): { score: number; hits: RuleHit[] } {
  const hits: RuleHit[] = [];
  let score = 0.5;

  if (intent.styles.length > 0) {
    const overlap = candidate.styleTags.filter((tag) => intent.styles.includes(tag)).length;
    if (overlap > 0) {
      const delta = Math.min(0.3, overlap * 0.15);
      score += delta;
      hits.push({ code: 'style_match', delta, detail: `${overlap} matching style tag(s)` });
    } else {
      // Not a conflict, just no evidence it is on-brief.
      const targetFormality = averageFormality(intent.styles);
      const gap = Math.abs(candidate.formality - targetFormality);
      const delta = -Math.min(0.2, gap * 0.07);
      score += delta;
      if (delta < -0.01) {
        hits.push({ code: 'style_match', delta, detail: 'no shared style tag' });
      }
    }
  }

  if (intent.preferredColors.length > 0) {
    if (intent.preferredColors.includes(candidate.colorFamily)) {
      score += 0.12;
      hits.push({ code: 'color_preference', delta: 0.12, detail: candidate.colorFamily });
    } else if (isNeutral(candidate.colorFamily)) {
      score += 0.04;
      hits.push({ code: 'color_preference', delta: 0.04, detail: 'neutral' });
    }
  }

  if (intent.preferredBrandIds.includes(candidate.brandId)) {
    score += 0.1;
    hits.push({ code: 'brand_preference', delta: 0.1, detail: candidate.brandName });
  }

  if (intent.season) {
    const range = SEASON_WARMTH[intent.season];
    if (candidate.warmth >= range.min && candidate.warmth <= range.max) {
      score += 0.08;
      hits.push({ code: 'season_fit', delta: 0.08, detail: intent.season });
    }
  }

  if (candidate.curatedLookIds && candidate.curatedLookIds.length > 0) {
    const delta = Math.min(0.08, candidate.curatedLookIds.length * 0.04);
    score += delta;
    hits.push({ code: 'curated_prior', delta, detail: 'appears in a curated look' });
  }

  if (typeof candidate.popularity === 'number') {
    const delta = candidate.popularity * 0.05;
    score += delta;
    hits.push({ code: 'popularity', delta });
  }

  return { score: clamp01(score), hits };
}

/** Hard rules on a single candidate, independent of the rest of the look. */
export function checkCandidateHardRules(
  candidate: OutfitCandidate,
  intent: StyleIntent,
): HardRuleCode | null {
  if (candidate.available <= 0) return 'out_of_stock';
  if (intent.excludedBrandIds.includes(candidate.brandId)) return 'excluded_brand';
  if (intent.excludedSlots.includes(candidate.slot)) return 'excluded_slot';
  if (intent.avoidColors.includes(candidate.colorFamily)) return 'color_clash';
  if (intent.season) {
    const range = SEASON_WARMTH[intent.season];
    // One level of slack: a transitional coat is fine in winter, a linen shirt is not.
    if (candidate.warmth < range.min - 1 || candidate.warmth > range.max + 1) return 'season_mismatch';
  }
  if (intent.styles.length > 0 && candidate.incompatibleWithStyles) {
    if (candidate.incompatibleWithStyles.some((style) => intent.styles.includes(style))) {
      return 'declared_incompatibility';
    }
  }
  return null;
}

/** Hard rules between two items in the same look. */
export function checkPairHardRules(a: OutfitCandidate, b: OutfitCandidate): HardRuleCode | null {
  if (a.productId === b.productId) return 'duplicate_product';
  for (const styleA of a.styleTags) {
    for (const styleB of b.styleTags) {
      if (stylesConflict(styleA, styleB)) return 'style_conflict';
    }
  }
  if (Math.abs(a.formality - b.formality) > 2) return 'formality_spread';
  if (!isNeutral(a.colorFamily) && !isNeutral(b.colorFamily) && colorsClash(a.colorFamily, b.colorFamily)) {
    return 'color_clash';
  }
  if (a.incompatibleWithSlots?.includes(b.slot) || b.incompatibleWithSlots?.includes(a.slot)) {
    return 'declared_incompatibility';
  }
  return null;
}

/** Soft harmony between two items. */
export function scorePair(a: OutfitCandidate, b: OutfitCandidate): RuleHit[] {
  const hits: RuleHit[] = [];

  if (colorsAffine(a.colorFamily, b.colorFamily)) {
    hits.push({ code: 'color_harmony', delta: 0.1, detail: `${a.colorFamily} + ${b.colorFamily}` });
  } else if (isNeutral(a.colorFamily) && isNeutral(b.colorFamily)) {
    hits.push({ code: 'color_harmony', delta: 0.07, detail: 'neutral palette' });
  } else if (isNeutral(a.colorFamily) || isNeutral(b.colorFamily)) {
    hits.push({ code: 'color_harmony', delta: 0.04, detail: 'one neutral anchor' });
  } else if (a.colorFamily === b.colorFamily) {
    hits.push({ code: 'color_harmony', delta: 0.05, detail: 'tonal' });
  } else {
    hits.push({ code: 'color_harmony', delta: -0.04, detail: 'two statement colours' });
  }

  const formalityGap = Math.abs(a.formality - b.formality);
  hits.push({
    code: 'formality_coherence',
    delta: formalityGap === 0 ? 0.06 : formalityGap === 1 ? 0.03 : -0.05,
    detail: `formality gap ${formalityGap}`,
  });

  const sharedStyles = a.styleTags.filter((tag) => b.styleTags.includes(tag));
  if (sharedStyles.length > 0) {
    hits.push({
      code: 'style_match',
      delta: Math.min(0.08, sharedStyles.length * 0.04),
      detail: sharedStyles.join(', '),
    });
  }

  // A fitted piece next to a voluminous one reads intentional; two oversized
  // pieces in adjacent slots usually do not.
  if (a.silhouette && b.silhouette) {
    const volumeA = silhouetteVolume(a.silhouette);
    const volumeB = silhouetteVolume(b.silhouette);
    const isTopBottom =
      (isUpper(a.slot) && isLower(b.slot)) || (isLower(a.slot) && isUpper(b.slot));
    if (isTopBottom) {
      if (volumeA !== volumeB) {
        hits.push({ code: 'silhouette_balance', delta: 0.07, detail: 'balanced proportions' });
      } else if (volumeA === 2) {
        hits.push({ code: 'silhouette_balance', delta: -0.06, detail: 'volume on volume' });
      }
    }
  }

  if (a.brandId === b.brandId) {
    hits.push({ code: 'brand_preference', delta: 0.02, detail: 'same brand' });
  }

  const sharedLooks = (a.curatedLookIds ?? []).filter((id) => (b.curatedLookIds ?? []).includes(id));
  if (sharedLooks.length > 0) {
    hits.push({ code: 'curated_prior', delta: 0.12, detail: 'styled together by an editor' });
  }

  return hits;
}

interface PartialOutfit {
  items: OutfitItem[];
  total: Money;
  score: number;
  softHits: RuleHit[];
}

/**
 * Beam search over the template's slots. Exhaustive search is exponential and
 * greedy search blows the budget on the first slot, so we keep the best
 * `beamWidth` partial looks and extend them slot by slot.
 */
export function assembleOutfit(options: AssembleOptions): AssembledOutfit | null {
  const { template, intent } = options;
  const beamWidth = options.beamWidth ?? 24;
  const excluded = options.excludeSkuIds ?? new Set<string>();
  const currency = intent.budget?.currency ?? 'UZS';
  const locked = options.locked ?? new Map<OutfitSlot, OutfitCandidate>();

  const slots = template.slots.filter((entry) => !intent.excludedSlots.includes(entry.slot));
  const requiredSlots = new Set<OutfitSlot>([
    ...slots.filter((s) => s.required).map((s) => s.slot),
    ...intent.requiredSlots,
  ]);

  const unfilledSlots: AssembledOutfit['unfilledSlots'] = [];
  let beam: PartialOutfit[] = [{ items: [], total: zero(currency), score: 0, softHits: [] }];

  // Fill the costliest slots first: once the expensive anchor is chosen, the
  // remaining budget is known and cheap slots can always be satisfied.
  const orderedSlots = [...slots].sort((a, b) => b.budgetWeight - a.budgetWeight);

  for (const slotSpec of orderedSlots) {
    const lockedCandidate = locked.get(slotSpec.slot);
    const pool = (options.candidatesBySlot.get(slotSpec.slot) ?? [])
      .filter((candidate) => !excluded.has(candidate.skuId))
      .filter((candidate) => checkCandidateHardRules(candidate, intent) === null);

    const effectivePool = lockedCandidate ? [lockedCandidate] : pool;

    if (effectivePool.length === 0) {
      const isRequired = requiredSlots.has(slotSpec.slot);
      unfilledSlots.push({
        slot: slotSpec.slot,
        required: isRequired,
        reason: (options.candidatesBySlot.get(slotSpec.slot) ?? []).length === 0
          ? 'no_catalogue_match'
          : 'all_candidates_rejected',
      });
      if (isRequired) {
        // AI-002: better to return nothing than to invent an item.
        return null;
      }
      continue;
    }

    const nextBeam: PartialOutfit[] = [];
    for (const partial of beam) {
      let extended = 0;
      for (const candidate of effectivePool) {
        if (partial.items.some((item) => checkPairHardRules(item.candidate, candidate) !== null)) continue;

        const newTotal = add(partial.total, candidate.price);
        if (intent.budget && compare(newTotal, intent.budget) > 0) continue;

        const { score: baseScore, hits: baseHits } = scoreCandidate(candidate, intent);
        const pairHits = partial.items.flatMap((item) => scorePair(item.candidate, candidate));
        const pairDelta = pairHits.reduce((acc, hit) => acc + hit.delta, 0);

        // Price balance: how close this item sits to its slot's budget share.
        const priceHits: RuleHit[] = [];
        if (intent.budget) {
          const target = toBigInt(intent.budget) * BigInt(Math.round(slotSpec.budgetWeight * 1000));
          const actual = toBigInt(candidate.price) * 1000n;
          const targetNum = Number(target);
          const ratio = targetNum === 0 ? 1 : Number(actual) / targetNum;
          const delta = ratio > 1.6 ? -0.12 : ratio < 0.25 ? -0.05 : 0.08;
          priceHits.push({
            code: 'price_balance',
            delta,
            detail: `${Math.round(ratio * 100)}% of slot budget`,
          });
        }
        const priceDelta = priceHits.reduce((acc, hit) => acc + hit.delta, 0);

        const itemScore = baseScore + pairDelta + priceDelta;
        nextBeam.push({
          items: [
            ...partial.items,
            { slot: slotSpec.slot, candidate, itemScore, hits: [...baseHits, ...priceHits] },
          ],
          total: newTotal,
          score: partial.score + itemScore,
          softHits: [...partial.softHits, ...pairHits],
        });
        extended += 1;
        if (extended >= beamWidth) break;
      }

      // An optional slot that nothing fits is simply skipped — the look is
      // still a look, and the shopper is told which slots stayed empty.
      if (!requiredSlots.has(slotSpec.slot)) nextBeam.push(partial);
    }

    if (nextBeam.length === 0) {
      if (requiredSlots.has(slotSpec.slot)) return null;
      continue;
    }

    beam = nextBeam
      .sort((a, b) => b.score / Math.max(1, b.items.length) - a.score / Math.max(1, a.items.length))
      .slice(0, beamWidth);
  }

  const complete = beam.filter((partial) =>
    [...requiredSlots].every((slot) => partial.items.some((item) => item.slot === slot)),
  );
  const pool = complete.length > 0 ? complete : beam.filter((p) => p.items.length > 0);
  if (pool.length === 0) return null;

  // Final ranking adds budget utilisation: a 4M UZS brief answered with a
  // 900K look is technically within budget but not what was asked for.
  const ranked = pool
    .map((partial) => {
      let score = partial.score / Math.max(1, partial.items.length);
      const extraHits: RuleHit[] = [];
      if (intent.budget && toBigInt(intent.budget) > 0n) {
        const utilisation = Number(toBigInt(partial.total)) / Number(toBigInt(intent.budget));
        const delta =
          utilisation >= 0.6 && utilisation <= 1
            ? 0.12
            : utilisation >= 0.4
              ? 0.04
              : utilisation < 0.25
                ? -0.1
                : 0;
        score += delta;
        extraHits.push({
          code: 'budget_utilisation',
          delta,
          detail: `${Math.round(utilisation * 100)}% of budget`,
        });
      }
      const occasionOverlap = intent.occasions.filter((o) => template.occasions.includes(o)).length;
      if (occasionOverlap > 0) {
        const delta = Math.min(0.1, occasionOverlap * 0.05);
        score += delta;
        extraHits.push({ code: 'occasion_match', delta, detail: intent.occasions.join(', ') });
      }
      return { partial, score, extraHits };
    })
    .sort((a, b) => b.score - a.score);

  const winner = ranked[0]!;
  const items = winner.partial.items;
  const formalities = items.map((item) => item.candidate.formality);
  const colorCounts = new Map<ColorFamily, number>();
  for (const item of items) {
    colorCounts.set(item.candidate.colorFamily, (colorCounts.get(item.candidate.colorFamily) ?? 0) + 1);
  }

  return {
    items: sortItemsForDisplay(items),
    total: winner.partial.total,
    score: Number(clamp01(winner.score).toFixed(4)),
    softHits: [...winner.partial.softHits, ...winner.extraHits],
    unfilledSlots,
    templateKey: template.key,
    withinBudget: !intent.budget || compare(winner.partial.total, intent.budget) <= 0,
    dominantColors: [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).map(([color]) => color),
    formalitySpread: formalities.length > 0 ? Math.max(...formalities) - Math.min(...formalities) : 0,
  };
}

/**
 * AI-007: replacing one item keeps the intent and the rest of the look, and
 * re-checks budget against what the other items already consume.
 */
export function replaceItem(
  outfit: AssembledOutfit,
  slot: OutfitSlot,
  options: {
    readonly intent: StyleIntent;
    readonly candidates: OutfitCandidate[];
    readonly excludeSkuIds?: Set<string>;
    readonly limit?: number;
  },
): Array<{ candidate: OutfitCandidate; score: number; hits: RuleHit[]; newTotal: Money; withinBudget: boolean }> {
  const kept = outfit.items.filter((item) => item.slot !== slot);
  const keptTotal = sum(
    kept.map((item) => item.candidate.price),
    outfit.total.currency,
  );
  const exclude = options.excludeSkuIds ?? new Set<string>();

  const results = options.candidates
    .filter((candidate) => !exclude.has(candidate.skuId))
    .filter((candidate) => checkCandidateHardRules(candidate, options.intent) === null)
    .filter((candidate) => kept.every((item) => checkPairHardRules(item.candidate, candidate) === null))
    .map((candidate) => {
      const { score: baseScore, hits } = scoreCandidate(candidate, options.intent);
      const pairHits = kept.flatMap((item) => scorePair(item.candidate, candidate));
      const newTotal = add(keptTotal, candidate.price);
      const withinBudget = !options.intent.budget || compare(newTotal, options.intent.budget) <= 0;
      const budgetPenalty = withinBudget ? 0 : -0.5;
      return {
        candidate,
        score: Number(
          (baseScore + pairHits.reduce((acc, h) => acc + h.delta, 0) + budgetPenalty).toFixed(4),
        ),
        hits: [...hits, ...pairHits],
        newTotal,
        withinBudget,
      };
    })
    .sort((a, b) => b.score - a.score);

  return results.slice(0, options.limit ?? 12);
}

/** Alternatives per slot, so the Mini App can offer a swap carousel. */
export function slotAlternatives(
  outfit: AssembledOutfit,
  intent: StyleIntent,
  candidatesBySlot: Map<OutfitSlot, OutfitCandidate[]>,
  limit = 8,
): Map<OutfitSlot, Array<{ candidate: OutfitCandidate; score: number; newTotal: Money; withinBudget: boolean }>> {
  const out = new Map<
    OutfitSlot,
    Array<{ candidate: OutfitCandidate; score: number; newTotal: Money; withinBudget: boolean }>
  >();
  for (const item of outfit.items) {
    const candidates = candidatesBySlot.get(item.slot) ?? [];
    const alternatives = replaceItem(outfit, item.slot, {
      intent,
      candidates,
      excludeSkuIds: new Set([item.candidate.skuId]),
      limit,
    });
    out.set(
      item.slot,
      alternatives.map(({ candidate, score, newTotal, withinBudget }) => ({
        candidate,
        score,
        newTotal,
        withinBudget,
      })),
    );
  }
  return out;
}

const DISPLAY_ORDER: OutfitSlot[] = [
  'HEADWEAR',
  'OUTERWEAR',
  'MID_LAYER',
  'TOP',
  'FULL_BODY',
  'BOTTOM',
  'FOOTWEAR',
  'BAG',
  'ACCESSORY',
];

function sortItemsForDisplay(items: OutfitItem[]): OutfitItem[] {
  return [...items].sort(
    (a, b) => DISPLAY_ORDER.indexOf(a.slot) - DISPLAY_ORDER.indexOf(b.slot),
  );
}

function silhouetteVolume(silhouette: Silhouette): 0 | 1 | 2 {
  switch (silhouette) {
    case 'fitted':
    case 'slim':
    case 'tapered':
      return 0;
    case 'straight':
    case 'cropped':
    case 'a_line':
      return 1;
    default:
      return 2;
  }
}

function isUpper(slot: OutfitSlot): boolean {
  return slot === 'TOP' || slot === 'MID_LAYER' || slot === 'OUTERWEAR';
}

function isLower(slot: OutfitSlot): boolean {
  return slot === 'BOTTOM';
}

function averageFormality(styles: StyleTag[]): number {
  if (styles.length === 0) return 3;
  return styles.reduce((acc, style) => acc + STYLE_FORMALITY[style], 0) / styles.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Deterministic, localisable explanation of why this look holds together.
 * AI-006: describes the clothes, never the shopper's body.
 */
export function explainOutfit(
  outfit: AssembledOutfit,
  intent: StyleIntent,
): { keys: Array<{ key: string; params?: Record<string, string> }>; topReasons: SoftRuleCode[] } {
  const byCode = new Map<SoftRuleCode, number>();
  for (const hit of [...outfit.softHits, ...outfit.items.flatMap((item) => item.hits)]) {
    byCode.set(hit.code, (byCode.get(hit.code) ?? 0) + hit.delta);
  }
  const topReasons = [...byCode.entries()]
    .filter(([, delta]) => delta > 0.02)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code]) => code);

  const keys: Array<{ key: string; params?: Record<string, string> }> = [];
  if (intent.styles.length > 0) {
    keys.push({ key: 'ai.explain.style', params: { styles: intent.styles.join(', ') } });
  }
  if (outfit.dominantColors.length > 0) {
    keys.push({ key: 'ai.explain.palette', params: { colors: outfit.dominantColors.slice(0, 2).join(' + ') } });
  }
  if (outfit.formalitySpread <= 1) keys.push({ key: 'ai.explain.coherent_formality' });
  if (intent.budget) {
    keys.push({ key: outfit.withinBudget ? 'ai.explain.within_budget' : 'ai.explain.over_budget' });
  }
  if (topReasons.includes('curated_prior')) keys.push({ key: 'ai.explain.curated' });
  if (topReasons.includes('silhouette_balance')) keys.push({ key: 'ai.explain.proportions' });

  const sellerCount = new Set(outfit.items.map((item) => item.candidate.sellerId)).size;
  if (sellerCount > 1) {
    keys.push({ key: 'ai.explain.multibrand', params: { count: String(sellerCount) } });
  }
  return { keys, topReasons };
}

/** Facts handed to the optional LLM. Prices and ids stay server-side. */
export function outfitFactsForLlm(outfit: AssembledOutfit): Array<Record<string, string>> {
  return outfit.items.map((item) => ({
    slot: item.slot,
    title: item.candidate.title,
    brand: item.candidate.brandName,
    color: item.candidate.colorFamily,
    silhouette: item.candidate.silhouette ?? 'unspecified',
    styles: item.candidate.styleTags.join(', '),
    formality: String(item.candidate.formality),
  }));
}

export function outfitTotal(items: OutfitCandidate[], currency: Money['currency'] = 'UZS'): Money {
  return items.reduce((acc, item) => add(acc, item.price), money(0, currency));
}
