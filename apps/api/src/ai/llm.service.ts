/**
 * Optional LLM layer — spec §6.3 and the critical guardrail.
 *
 * "LLM не генерирует SKU ID, цену, размер или наличие. Коммерческие факты
 *  подставляются commerce backend после retrieval и ещё раз проверяются перед
 *  корзиной."
 *
 * So the model does exactly two things, both optional:
 *   1. help map a free-text brief onto the controlled taxonomy, and
 *   2. reword an explanation whose content was already decided by rules.
 *
 * With AI_PROVIDER=local (the default) there is no network call at all and the
 * product is fully functional — which is also what NFR-006 demands: an AI
 * outage must not block catalogue, cart or checkout.
 *
 * SEC-012: prompts are built from a fixed template plus enum values and
 * product titles. No PII, no measurements, no addresses are ever sent.
 */

import { Injectable } from '@nestjs/common';
import {
  type ColorFamily,
  type Locale,
  type Occasion,
  type Season,
  type StyleTag,
  COLOR_FAMILIES,
  OCCASIONS,
  SEASONS,
  STYLE_TAGS,
  translate,
} from '@fashion/core';
import { loadConfig } from '../common/config';
import { logger } from '../common/logger';
import { sha256 } from '../common/crypto';

export interface LlmIntentHints {
  readonly styles: StyleTag[];
  readonly occasions: Occasion[];
  readonly season: Season | null;
  readonly colors: ColorFamily[];
  readonly avoidColors: ColorFamily[];
  readonly notes: string | null;
}

export interface NarrativeRequest {
  readonly locale: Locale;
  readonly brief: string;
  /** Facts only — titles, brands, colours. No ids, no prices. */
  readonly items: Array<Record<string, string>>;
  readonly reasonKeys: string[];
  readonly withinBudget: boolean;
}

export interface NarrativeResult {
  readonly text: string;
  readonly model: string | null;
  readonly promptHash: string | null;
  readonly source: 'llm' | 'rules';
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

@Injectable()
export class LlmService {
  private readonly config = loadConfig();
  private failureCount = 0;
  private circuitOpenUntil = 0;

  get enabled(): boolean {
    return this.config.AI_PROVIDER === 'anthropic' && this.config.ANTHROPIC_API_KEY.trim() !== '';
  }

  get model(): string | null {
    return this.enabled ? this.config.AI_LLM_MODEL : null;
  }

  /**
   * Optional second opinion on a brief the deterministic parser found hard.
   * The result is *merged into* the parsed intent, never substituted for it:
   * budget, brand exclusions and the final SKU choice stay with the rules.
   */
  async refineIntent(brief: string, locale: Locale): Promise<LlmIntentHints | null> {
    if (!this.enabled || this.circuitOpen()) return null;

    const system = [
      'You map a shopper brief onto a fixed fashion taxonomy for an Uzbek marketplace.',
      'Reply with JSON only, no prose.',
      'Use ONLY values from the given enums. Omit a field rather than inventing a value.',
      'Never output product names, prices, sizes, stock or ids.',
    ].join(' ');

    const prompt = [
      `Brief (language: ${locale}): ${brief.slice(0, 500)}`,
      '',
      `styles: ${STYLE_TAGS.join(', ')}`,
      `occasions: ${OCCASIONS.join(', ')}`,
      `seasons: ${SEASONS.join(', ')}`,
      `colors: ${COLOR_FAMILIES.join(', ')}`,
      '',
      'JSON shape: {"styles":[],"occasions":[],"season":null,"colors":[],"avoidColors":[],"notes":null}',
    ].join('\n');

    try {
      const text = await this.call(system, prompt, 400);
      const parsed = JSON.parse(extractJson(text)) as Partial<LlmIntentHints>;
      return {
        styles: filterEnum(parsed.styles, STYLE_TAGS),
        occasions: filterEnum(parsed.occasions, OCCASIONS),
        season: parsed.season && SEASONS.includes(parsed.season) ? parsed.season : null,
        colors: filterEnum(parsed.colors, COLOR_FAMILIES),
        avoidColors: filterEnum(parsed.avoidColors, COLOR_FAMILIES),
        notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 300) : null,
      };
    } catch (error) {
      this.recordFailure(error);
      return null;
    }
  }

  /**
   * Reword the explanation. The deterministic sentence is always computed
   * first and returned on any failure, so the shopper always gets a reason
   * (AI-006) even when the model is unreachable.
   */
  async narrate(request: NarrativeRequest): Promise<NarrativeResult> {
    const fallback = this.rulesNarrative(request);
    if (!this.enabled || this.circuitOpen()) return fallback;

    const system = [
      'You are a fashion stylist writing one short paragraph for a shopper.',
      'You are given the exact garments that were already selected, as facts.',
      'Describe why they work together. 2-3 sentences, warm but factual.',
      'Rules: never mention prices, sizes, stock, ids or availability.',
      'Never comment on the shopper\'s body, weight, shape or appearance.',
      'Never promise a perfect fit. Do not invent garments that are not listed.',
      `Write in ${request.locale === 'uz' ? 'Uzbek (Latin script)' : request.locale === 'en' ? 'English' : 'Russian'}.`,
    ].join(' ');

    const prompt = [
      `Shopper brief: ${request.brief.slice(0, 300)}`,
      '',
      'Selected garments:',
      ...request.items.map(
        (item, index) =>
          `${index + 1}. ${item.slot}: ${item.title} by ${item.brand}, ${item.color}, ${item.silhouette}, styles: ${item.styles}`,
      ),
      '',
      `Why the rules picked them: ${request.reasonKeys.join(', ')}`,
      request.withinBudget ? 'The set is within the stated budget.' : 'The set is over budget.',
    ].join('\n');

    try {
      const text = await this.call(system, prompt, 500);
      const cleaned = sanitizeNarrative(text);
      if (!cleaned) return fallback;
      this.failureCount = 0;
      return {
        text: cleaned,
        model: this.config.AI_LLM_MODEL,
        promptHash: sha256(`${system}\n${prompt}`).slice(0, 32),
        source: 'llm',
      };
    } catch (error) {
      this.recordFailure(error);
      return fallback;
    }
  }

  /** The deterministic explanation. This is the product's real baseline. */
  rulesNarrative(request: NarrativeRequest): NarrativeResult {
    const sentences = request.reasonKeys
      .map((key) => translate(request.locale, key))
      .filter((sentence) => sentence && !sentence.startsWith('ai.'));
    return {
      text: sentences.join(' '),
      model: null,
      promptHash: null,
      source: 'rules',
    };
  }

  private async call(system: string, prompt: string, maxTokens: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.AI_EXPLANATION_TIMEOUT_MS);
    try {
      const response = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.AI_LLM_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LLM responded ${response.status}`);
      }
      const payload = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      return (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * NFR-006: after three consecutive failures the circuit opens for a minute.
   * The stylist keeps working from rules in the meantime.
   */
  private circuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  private recordFailure(error: unknown): void {
    this.failureCount += 1;
    if (this.failureCount >= 3) {
      this.circuitOpenUntil = Date.now() + 60_000;
      this.failureCount = 0;
      logger.warn('LLM circuit opened for 60s — stylist continues on rules only');
    }
    logger.warn(
      { err: error instanceof Error ? error.message : error },
      'LLM call failed; using deterministic explanation',
    );
  }
}

function filterEnum<T extends string>(values: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is T => typeof value === 'string' && allowed.includes(value as T));
}

function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON in LLM response');
  return text.slice(start, end + 1);
}

/**
 * AI-006 safety net: strip anything that reads like a price, a size or a body
 * comment, in case the model ignored its instructions. Covered by tests.
 */
const BANNED_PATTERNS: RegExp[] = [
  /\b\d[\d\s.,]{3,}\s*(?:сум|so'm|so‘m|som|uzs|₽|\$|€)/giu,
  /\b(?:размер|o['‘]lcham|size)\s*[:=]?\s*(?:xs|s|m|l|xl|xxl|\d{2})\b/giu,
  /\b(?:похуд|fat|slim down|стройн|толст|semiz|ozg['‘]in)\w*/giu,
  /\b(?:в наличии|in stock|mavjud emas|out of stock)\b/giu,
];

export function sanitizeNarrative(text: string): string | null {
  let cleaned = text.replace(/```[a-z]*|```/g, '').trim();
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(cleaned)) {
      logger.warn({ pattern: pattern.source }, 'LLM narrative violated a safety rule and was dropped');
      return null;
    }
  }
  // Keep it to a paragraph; a runaway response is a signal, not content.
  if (cleaned.length > 900) cleaned = `${cleaned.slice(0, 880).trimEnd()}…`;
  return cleaned.length >= 10 ? cleaned : null;
}
