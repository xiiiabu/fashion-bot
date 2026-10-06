/**
 * Size & fit recommendation — spec §6.2 (FIT-001 … FIT-008).
 *
 * Non-negotiables encoded here:
 *  - FIT-001: the brand/category/model size chart and product measurements are
 *    the base. With no data we return the chart and say so, never a guess.
 *  - FIT-003: always a recommended size + confidence + the reason, and manual
 *    selection stays available (the caller never blocks add-to-cart on this).
 *  - FIT-004: below the confidence threshold the answer is explicitly not
 *    presented as confident; we return a fallback and what data would help.
 *  - FIT-006: preferred fit changes the answer for identical body measurements.
 *  - FIT-008: nothing here reads a face, emotion, ethnicity or any unrelated
 *    attribute. The only inputs are garment geometry and body measurements the
 *    shopper volunteered.
 *
 * All lengths are integer millimetres. No floats in the data model.
 */

import type { FitPreference } from './taxonomy.js';

export const MEASUREMENT_KEYS = [
  'chest',
  'waist',
  'hips',
  'shoulder',
  'sleeve',
  'inseam',
  'length',
  'neck',
  'thigh',
  'footLength',
] as const;

export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export type Measurements = Partial<Record<MeasurementKey, number>>;

export interface SizeChartRow {
  readonly sizeLabel: string;
  /** Position in the chart, so "one size up" is well defined. */
  readonly order: number;
  /**
   * Body measurements the brand says this size is cut for ("to fit"),
   * in millimetres.
   */
  readonly body: Measurements;
  /** Flat garment measurements, if the brand publishes them. */
  readonly garment?: Measurements;
}

export interface SizeChart {
  readonly id: string;
  readonly brandId: string | null;
  readonly categorySlug: string;
  /** 'letter' (S/M/L), 'numeric' (46/48), 'eu-shoe', 'waist-inseam'. */
  readonly system: string;
  readonly rows: SizeChartRow[];
  /** Notes shown verbatim on the PDP (CAT-003 acceptance criterion). */
  readonly note?: Record<'ru' | 'uz' | 'en', string> | null;
}

export interface FitProfile {
  readonly heightMm?: number | null;
  readonly weightGrams?: number | null;
  readonly body?: Measurements;
  readonly preferredFit?: FitPreference | null;
  /** Sizes the shopper already wears, per brand: { brandId: 'M' }. */
  readonly usualSizes?: Record<string, string>;
  /** FIT-002: each signal can be switched off; the caller passes only enabled ones. */
  readonly consentPersonalizedFit: boolean;
}

/** FIT-005: post-delivery feedback, aggregated per SKU. */
export interface FitFeedbackAggregate {
  readonly runsSmall: number;
  readonly runsTrue: number;
  readonly runsLarge: number;
  readonly sampleSize: number;
}

export type FitVerdict = 'true_to_size' | 'runs_small' | 'runs_large' | 'unknown';

export interface SizeCandidate {
  readonly sizeLabel: string;
  readonly skuId?: string;
  readonly inStock: boolean;
  readonly order: number;
}

export interface FitRecommendationInput {
  readonly chart: SizeChart | null;
  readonly candidates: SizeCandidate[];
  readonly profile?: FitProfile | null;
  readonly feedback?: FitFeedbackAggregate | null;
  readonly categorySlug: string;
  readonly brandId?: string | null;
  /** Garment measurements of the specific model, when richer than the chart. */
  readonly productMeasurements?: Record<string, Measurements> | null;
  /** AI_FIT_CONFIDENCE_THRESHOLD; below it the answer is not "confident". */
  readonly confidenceThreshold?: number;
}

export type FitReasonCode =
  | 'body_measurements_match'
  | 'usual_brand_size'
  | 'height_weight_estimate'
  | 'community_feedback_adjusted'
  | 'preferred_fit_applied'
  | 'chart_only_no_profile'
  | 'no_chart_available'
  | 'between_sizes'
  | 'out_of_stock_fallback';

export interface FitRecommendation {
  /** null when we genuinely cannot say (FIT-001/FIT-004). */
  readonly recommendedSize: string | null;
  /** 0..1. Compared against the threshold by the caller and the UI. */
  readonly confidence: number;
  readonly confident: boolean;
  readonly reasonCodes: FitReasonCode[];
  /** Short, non-judgemental sentence keys for the UI to localise (AI-006). */
  readonly explanation: string;
  readonly alternatives: Array<{ sizeLabel: string; note: 'tighter' | 'looser' | 'in_stock_alternative' }>;
  /** What the shopper could add to improve the answer. Never required. */
  readonly improveWith: Array<'chest' | 'waist' | 'hips' | 'height' | 'usual_size' | 'preferred_fit'>;
  readonly verdict: FitVerdict;
  /** Set when the recommendation is only a chart reading, not personalised. */
  readonly chartOnly: boolean;
  readonly sampleSize: number;
}

/** Which measurements actually decide the size for this kind of garment. */
const CATEGORY_WEIGHTS: Record<string, Partial<Record<MeasurementKey, number>>> = {
  TOP: { chest: 0.55, shoulder: 0.25, sleeve: 0.1, length: 0.1 },
  MID_LAYER: { chest: 0.6, shoulder: 0.25, sleeve: 0.15 },
  OUTERWEAR: { chest: 0.5, shoulder: 0.25, sleeve: 0.15, length: 0.1 },
  BOTTOM: { waist: 0.5, hips: 0.3, inseam: 0.15, thigh: 0.05 },
  FULL_BODY: { chest: 0.35, waist: 0.3, hips: 0.25, length: 0.1 },
  FOOTWEAR: { footLength: 1 },
  ACCESSORY: { waist: 0.5, neck: 0.5 },
  BAG: {},
  HEADWAER: {},
};

const SLOT_BY_CATEGORY: Record<string, keyof typeof CATEGORY_WEIGHTS> = {
  shirts: 'TOP',
  blouses: 'TOP',
  't-shirts': 'TOP',
  tops: 'TOP',
  polos: 'TOP',
  knitwear: 'MID_LAYER',
  sweaters: 'MID_LAYER',
  cardigans: 'MID_LAYER',
  hoodies: 'MID_LAYER',
  vests: 'MID_LAYER',
  coats: 'OUTERWEAR',
  jackets: 'OUTERWEAR',
  blazers: 'OUTERWEAR',
  trenchcoats: 'OUTERWEAR',
  'coats-jackets': 'OUTERWEAR',
  trousers: 'BOTTOM',
  jeans: 'BOTTOM',
  skirts: 'BOTTOM',
  shorts: 'BOTTOM',
  dresses: 'FULL_BODY',
  suits: 'FULL_BODY',
  jumpsuits: 'FULL_BODY',
  shoes: 'FOOTWEAR',
  sneakers: 'FOOTWEAR',
  boots: 'FOOTWEAR',
  loafers: 'FOOTWEAR',
  heels: 'FOOTWEAR',
  belts: 'ACCESSORY',
  scarves: 'ACCESSORY',
  bags: 'BAG',
};

/**
 * FIT-006: target ease (garment minus body, in mm) per preferred fit.
 * Identical body measurements therefore yield different recommendations.
 *
 * These are flat-garment girth allowances as pattern books state them, not
 * guesses: a regular-fit shirt is cut ~11 cm wider than the chest it is for,
 * a slim one ~6 cm, an oversized one ~24 cm. Getting these wrong does not
 * merely blunt the ranking — it pushes every size out of tolerance at once
 * and the engine then has nothing to choose between.
 */
const EASE_TARGET: Record<FitPreference, Partial<Record<MeasurementKey, number>>> = {
  slim: { chest: 60, waist: 40, hips: 50, shoulder: 0, thigh: 20 },
  regular: { chest: 110, waist: 70, hips: 90, shoulder: 10, thigh: 40 },
  relaxed: { chest: 170, waist: 110, hips: 140, shoulder: 25, thigh: 70 },
  oversized: { chest: 240, waist: 160, hips: 200, shoulder: 45, thigh: 100 },
};

/** Tolerance, in mm, within which a size counts as a good match. */
const TOLERANCE: Partial<Record<MeasurementKey, number>> = {
  chest: 45,
  waist: 40,
  hips: 45,
  shoulder: 18,
  sleeve: 30,
  inseam: 35,
  length: 40,
  neck: 12,
  thigh: 25,
  footLength: 7,
};

function weightsFor(categorySlug: string): Partial<Record<MeasurementKey, number>> {
  const slot = SLOT_BY_CATEGORY[categorySlug];
  return (slot && CATEGORY_WEIGHTS[slot]) || { chest: 0.4, waist: 0.3, hips: 0.3 };
}

/**
 * Estimate chest/waist/hips from height and weight when the shopper gave only
 * those. Deliberately coarse, and it caps confidence at 0.6 so the UI can
 * never present it as a measured match (FIT-004).
 *
 * Girth is mostly mass at a given height, so these are linear in both, with
 * coefficients that reproduce the published anthropometric means: 180 cm /
 * 80 kg lands at chest 101 cm, waist 87 cm, hips 101 cm. A BMI-only form was
 * tried first and under-read the chest by ~4 cm at normal BMI, which is a
 * whole size — enough to move the recommendation.
 */
function estimateFromHeightWeight(heightMm: number, weightGrams: number): Measurements {
  const heightCm = heightMm / 10;
  const weightKg = weightGrams / 1000;
  if (heightCm < 120 || heightCm > 230 || weightKg < 30 || weightKg > 220) return {};
  const chest = Math.round((heightCm * 0.33 + weightKg * 0.55 - 2) * 10);
  const waist = Math.round((heightCm * 0.22 + weightKg * 0.72 - 10) * 10);
  const hips = Math.round((heightCm * 0.32 + weightKg * 0.52 + 2) * 10);
  return { chest, waist, hips };
}

function resolveBody(profile: FitProfile | null | undefined): {
  body: Measurements;
  estimated: boolean;
} {
  if (!profile || !profile.consentPersonalizedFit) return { body: {}, estimated: false };
  const declared = profile.body ?? {};
  const hasDeclared = MEASUREMENT_KEYS.some((key) => typeof declared[key] === 'number');
  if (hasDeclared) return { body: declared, estimated: false };
  if (profile.heightMm && profile.weightGrams) {
    return { body: estimateFromHeightWeight(profile.heightMm, profile.weightGrams), estimated: true };
  }
  return { body: {}, estimated: false };
}

function verdictFromFeedback(feedback: FitFeedbackAggregate | null | undefined): {
  verdict: FitVerdict;
  shift: number;
  strength: number;
} {
  if (!feedback || feedback.sampleSize < 5) return { verdict: 'unknown', shift: 0, strength: 0 };
  const total = feedback.runsSmall + feedback.runsTrue + feedback.runsLarge;
  if (total === 0) return { verdict: 'unknown', shift: 0, strength: 0 };
  const smallShare = feedback.runsSmall / total;
  const largeShare = feedback.runsLarge / total;
  const trueShare = feedback.runsTrue / total;
  // Confidence in the signal grows with sample size, saturating around n=40.
  const strength = Math.min(1, feedback.sampleSize / 40);
  if (smallShare >= 0.5 && smallShare > largeShare + 0.2) {
    return { verdict: 'runs_small', shift: 1, strength };
  }
  if (largeShare >= 0.5 && largeShare > smallShare + 0.2) {
    return { verdict: 'runs_large', shift: -1, strength };
  }
  if (trueShare >= 0.6) return { verdict: 'true_to_size', shift: 0, strength };
  return { verdict: 'unknown', shift: 0, strength: strength * 0.5 };
}

export function recommendSize(input: FitRecommendationInput): FitRecommendation {
  const threshold = input.confidenceThreshold ?? 0.55;
  const candidates = [...input.candidates].sort((a, b) => a.order - b.order);
  const feedbackSignal = verdictFromFeedback(input.feedback);
  const sampleSize = input.feedback?.sampleSize ?? 0;

  if (candidates.length === 0) {
    return emptyRecommendation('no_chart_available', 'fit.no_sizes', feedbackSignal.verdict, sampleSize);
  }

  // FIT-001: without a chart there is no honest answer. Return the sizes and
  // flag that this is chart-only, so the PDP shows the grid and nothing more.
  if (!input.chart || input.chart.rows.length === 0) {
    return {
      recommendedSize: null,
      confidence: 0,
      confident: false,
      reasonCodes: ['no_chart_available'],
      explanation: 'fit.no_chart',
      alternatives: candidates
        .filter((c) => c.inStock)
        .slice(0, 3)
        .map((c) => ({ sizeLabel: c.sizeLabel, note: 'in_stock_alternative' as const })),
      improveWith: [],
      verdict: feedbackSignal.verdict,
      chartOnly: true,
      sampleSize,
    };
  }

  const rowsBySize = new Map(input.chart.rows.map((row) => [normalizeSize(row.sizeLabel), row]));
  const { body, estimated } = resolveBody(input.profile);
  const preferredFit: FitPreference = input.profile?.preferredFit ?? 'regular';
  const weights = weightsFor(input.categorySlug);
  const reasonCodes: FitReasonCode[] = [];
  const improveWith: FitRecommendation['improveWith'] = [];

  // Path A — usual brand size. Cheap, strong signal, and it is what shoppers
  // actually know about themselves.
  const usualSize =
    input.brandId && input.profile?.consentPersonalizedFit
      ? input.profile.usualSizes?.[input.brandId]
      : undefined;

  const measurableKeys = (Object.keys(weights) as MeasurementKey[]).filter(
    (key) => typeof body[key] === 'number' && (weights[key] ?? 0) > 0,
  );
  const coverage =
    measurableKeys.reduce((acc, key) => acc + (weights[key] ?? 0), 0) /
    Math.max(
      (Object.keys(weights) as MeasurementKey[]).reduce((acc, key) => acc + (weights[key] ?? 0), 0),
      0.0001,
    );

  let scored: Array<{ candidate: SizeCandidate; score: number; distance: number }> = [];

  if (measurableKeys.length > 0) {
    const ease = EASE_TARGET[preferredFit];
    scored = candidates.map((candidate) => {
      const row = rowsBySize.get(normalizeSize(candidate.sizeLabel));
      if (!row) return { candidate, score: 0, distance: Number.POSITIVE_INFINITY };
      const productMeasures = input.productMeasurements?.[candidate.sizeLabel];
      let weighted = 0;
      let used = 0;
      let distance = 0;
      for (const key of measurableKeys) {
        const bodyValue = body[key]!;
        const weight = weights[key] ?? 0;
        // Prefer the model's own garment measurement, then the chart's garment
        // measurement, then the chart's "to fit" body measurement.
        const garment = productMeasures?.[key] ?? row.garment?.[key];
        let delta: number;
        if (typeof garment === 'number') {
          const target = ease[key] ?? 0;
          delta = garment - bodyValue - target;
        } else if (typeof row.body[key] === 'number') {
          // Chart body values already include the brand's intended ease, so the
          // preferred fit only nudges which row we aim at.
          const nudge = (ease[key] ?? 0) - (EASE_TARGET.regular[key] ?? 0);
          delta = row.body[key]! - bodyValue - nudge;
        } else {
          continue;
        }
        const tolerance = TOLERANCE[key] ?? 40;
        const normalized = Math.abs(delta) / tolerance;
        // Smooth decay rather than a clamped `1 - normalized`: once every size
        // sits outside tolerance the clamped form scores them all 0 and the
        // engine loses the ranking it does have. 1/(1+x) keeps the ordering at
        // any distance while still reading 1.0 on an exact match and 0.5 at the
        // tolerance edge, so the confidence number stays interpretable.
        weighted += weight * (1 / (1 + normalized));
        distance += weight * Math.abs(delta);
        used += weight;
      }
      const score = used > 0 ? weighted / used : 0;
      return { candidate, score, distance: used > 0 ? distance / used : Number.POSITIVE_INFINITY };
    });
    reasonCodes.push(estimated ? 'height_weight_estimate' : 'body_measurements_match');
    if (preferredFit !== 'regular') reasonCodes.push('preferred_fit_applied');
  } else if (usualSize) {
    const usualOrder = rowsBySize.get(normalizeSize(usualSize))?.order;
    scored = candidates.map((candidate) => {
      const row = rowsBySize.get(normalizeSize(candidate.sizeLabel));
      if (!row || usualOrder === undefined) return { candidate, score: 0, distance: 99 };
      const steps = Math.abs(row.order - usualOrder);
      return { candidate, score: Math.max(0, 1 - steps * 0.45), distance: steps };
    });
    reasonCodes.push('usual_brand_size');
  } else {
    // FIT-004: nothing personal to work from. Show the chart, ask for nothing.
    const inStock = candidates.filter((c) => c.inStock);
    const middle = inStock[Math.floor(inStock.length / 2)] ?? candidates[Math.floor(candidates.length / 2)];
    return {
      recommendedSize: null,
      confidence: 0,
      confident: false,
      reasonCodes: ['chart_only_no_profile'],
      explanation: 'fit.chart_only',
      alternatives: middle ? [{ sizeLabel: middle.sizeLabel, note: 'in_stock_alternative' }] : [],
      improveWith: ['chest', 'waist', 'height', 'usual_size', 'preferred_fit'],
      verdict: feedbackSignal.verdict,
      chartOnly: true,
      sampleSize,
    };
  }

  // FIT-005: community feedback moves the pick by at most one step, and only
  // one — the neighbour in the direction the wearers report. The boost is
  // sized against the lead the geometry gave, so a weak signal (strength near
  // the 0.4 floor) only wins when the two sizes were already close, while a
  // saturated one (n >= 40) overrides the chart. Shifting the pick rather than
  // the ease targets keeps "at most one size" true by construction.
  if (feedbackSignal.shift !== 0 && feedbackSignal.strength >= 0.4) {
    const geometryBest = [...scored].sort((a, b) => b.score - a.score || a.distance - b.distance)[0];
    const neighbourOrder = geometryBest
      ? geometryBest.candidate.order + feedbackSignal.shift
      : undefined;
    const neighbour = scored.find((entry) => entry.candidate.order === neighbourOrder);
    if (geometryBest && neighbour) {
      const lead = geometryBest.score - neighbour.score;
      const boost = (lead + 0.08) * feedbackSignal.strength;
      scored = scored.map((entry) =>
        entry.candidate.order === neighbour.candidate.order
          ? { ...entry, score: Math.min(1, entry.score + boost) }
          : entry,
      );
      reasonCodes.push('community_feedback_adjusted');
    }
  }

  const ranked = [...scored].sort((a, b) => b.score - a.score || a.distance - b.distance);
  const top = ranked[0];
  if (!top || top.score <= 0) {
    return emptyRecommendation(
      'chart_only_no_profile',
      'fit.chart_only',
      feedbackSignal.verdict,
      sampleSize,
    );
  }
  const runnerUp = ranked[1];
  const margin = runnerUp ? Math.max(0, top.score - runnerUp.score) : 0.35;

  // Confidence = how good the match is, how much data covered it, and how
  // clearly it beat the next size. Height/weight estimates are capped.
  let confidence = top.score * (0.55 + 0.3 * coverage) + Math.min(margin, 0.3) * 0.5;
  if (estimated) confidence = Math.min(confidence, 0.6);
  if (reasonCodes.includes('usual_brand_size') && measurableKeys.length === 0) {
    confidence = Math.min(confidence, 0.72);
  }
  if (feedbackSignal.verdict === 'true_to_size') confidence += 0.05 * feedbackSignal.strength;
  // We overrode the garment geometry on other people's reports, so the answer
  // cannot be presented as a measured match however large the sample is.
  if (reasonCodes.includes('community_feedback_adjusted')) {
    confidence = Math.min(confidence, 0.8);
  }
  confidence = Math.max(0, Math.min(1, confidence));

  if (runnerUp && margin < 0.06) reasonCodes.push('between_sizes');

  if (!body.chest && weights.chest) improveWith.push('chest');
  if (!body.waist && weights.waist) improveWith.push('waist');
  if (!body.hips && weights.hips) improveWith.push('hips');
  if (!input.profile?.preferredFit) improveWith.push('preferred_fit');

  // Never recommend something the shopper cannot buy; offer the nearest size
  // that is actually in stock instead and say that is what happened.
  let picked = top.candidate;
  if (!picked.inStock) {
    const nearestInStock = ranked.find((entry) => entry.candidate.inStock);
    if (nearestInStock) {
      picked = nearestInStock.candidate;
      reasonCodes.push('out_of_stock_fallback');
      confidence = Math.min(confidence, 0.5);
    }
  }

  const alternatives: FitRecommendation['alternatives'] = [];
  const tighter = candidates.find((c) => c.order === picked.order - 1 && c.inStock);
  const looser = candidates.find((c) => c.order === picked.order + 1 && c.inStock);
  if (tighter) alternatives.push({ sizeLabel: tighter.sizeLabel, note: 'tighter' });
  if (looser) alternatives.push({ sizeLabel: looser.sizeLabel, note: 'looser' });

  return {
    recommendedSize: picked.sizeLabel,
    confidence: Number(confidence.toFixed(3)),
    confident: confidence >= threshold,
    reasonCodes,
    explanation: explanationKey(reasonCodes, confidence >= threshold),
    alternatives,
    improveWith,
    verdict: feedbackSignal.verdict,
    chartOnly: false,
    sampleSize,
  };
}

function emptyRecommendation(
  reason: FitReasonCode,
  explanation: string,
  verdict: FitVerdict,
  sampleSize: number,
): FitRecommendation {
  return {
    recommendedSize: null,
    confidence: 0,
    confident: false,
    reasonCodes: [reason],
    explanation,
    alternatives: [],
    improveWith: ['chest', 'waist', 'height', 'usual_size'],
    verdict,
    chartOnly: true,
    sampleSize,
  };
}

/**
 * AI-006 / FIT-003: explanation keys are neutral statements about garment
 * geometry. No body-shaming, no "you should", no promise that it will fit.
 */
function explanationKey(reasons: FitReasonCode[], confident: boolean): string {
  if (reasons.includes('out_of_stock_fallback')) return 'fit.out_of_stock_fallback';
  if (!confident) return 'fit.low_confidence';
  if (reasons.includes('between_sizes')) return 'fit.between_sizes';
  if (reasons.includes('community_feedback_adjusted')) return 'fit.feedback_adjusted';
  if (reasons.includes('usual_brand_size')) return 'fit.usual_size';
  if (reasons.includes('height_weight_estimate')) return 'fit.estimate';
  if (reasons.includes('preferred_fit_applied')) return 'fit.preferred_fit';
  return 'fit.measurements_match';
}

export function normalizeSize(label: string): string {
  return label.trim().toUpperCase().replace(/\s+/g, '').replace(/[`'"]/g, '');
}

/** Order sizes for display: letters by convention, numbers numerically. */
const LETTER_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];

export function sizeSortKey(label: string): number {
  const normalized = normalizeSize(label);
  const letterIndex = LETTER_ORDER.indexOf(normalized);
  if (letterIndex >= 0) return letterIndex;
  const numeric = Number.parseFloat(normalized.replace(',', '.'));
  if (Number.isFinite(numeric)) return 1000 + numeric;
  return 2000;
}

export function sortSizes<T extends { sizeLabel: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => sizeSortKey(a.sizeLabel) - sizeSortKey(b.sizeLabel));
}
