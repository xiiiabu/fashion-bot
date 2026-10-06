/**
 * AI stylist — spec §6.1 (AI-001 … AI-010).
 *
 * The pipeline, in the order the spec's Schema 1 requires:
 *   brief -> structured intent (AI-001)
 *         -> retrieval over buyable SKUs only (AI-002)
 *         -> slot template (AI-003)
 *         -> hard/soft compatibility rules (AI-004)
 *         -> budget check with the exact sum (AI-005)
 *         -> fit recommendation per item (FIT-003)
 *         -> explanation, optionally reworded by an LLM (AI-006)
 *         -> persisted session + recommendation event (AI-009)
 *
 * The generative step is last and decorative. Retrieval and validation happen
 * before it, which is the whole point of the guardrail in §6.3.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type Locale as PrismaLocale } from '@prisma/client';
import {
  type AssembledOutfit,
  type Locale,
  type Money,
  type OutfitCandidate,
  type OutfitSlot,
  type OutfitTemplate,
  type OutfitView,
  type ParsedIntent,
  type ProductCard,
  type StyleIntent,
  DEFAULT_OUTFIT_TEMPLATES,
  INTENT_EXAMPLES,
  assembleOutfit,
  explainOutfit,
  outfitFactsForLlm,
  parseStyleIntent,
  replaceItem,
  slotAlternatives,
  sum,
  templateForIntent,
  toBigInt,
  translate,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { toMinor, toMoney } from '../common/money.util';
import { FitService } from '../fit/fit.service';
import { RetrievalService } from './retrieval.service';
import { LlmService } from './llm.service';
import { mapProductCard, productCardInclude } from '../catalog/product-mapper';

/** AI-009: bump when the pipeline's behaviour changes. */
export const ENGINE_VERSION = '1.0.0';
export const RULES_VERSION = '2026-09-17';

export interface StylistRequest {
  readonly query: string;
  readonly userId: string | null;
  readonly locale: Locale;
  /** Structured chips from the UI take precedence over the parsed text. */
  readonly overrides?: Partial<StyleIntent>;
  readonly templateKey?: string | null;
  readonly correlationId?: string;
}

@Injectable()
export class StylistService {
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: RetrievalService,
    private readonly fit: FitService,
    private readonly llm: LlmService,
  ) {}

  /** AI-001: the brief becomes a stored structured intent. */
  async parseIntent(request: StylistRequest): Promise<ParsedIntent> {
    const base = parseStyleIntent(request.query, {
      currency: this.config.DEFAULT_CURRENCY,
      overrides: request.overrides,
      defaultLanguage: request.locale,
    });

    // Fold in the shopper's saved preferences, unless they turned
    // personalisation off (USR-006).
    const withProfile = await this.applyProfile(base, request.userId);

    // A hard-to-parse brief gets an optional LLM assist. Its output can only
    // add taxonomy values; it can never set the budget or pick a product.
    if (withProfile.parseConfidence < 0.25 && request.query.trim().length > 12 && this.llm.enabled) {
      const hints = await this.llm.refineIntent(request.query, request.locale);
      if (hints) {
        return {
          ...withProfile,
          styles: dedupe([...withProfile.styles, ...hints.styles]).slice(0, 6),
          occasions: dedupe([...withProfile.occasions, ...hints.occasions]).slice(0, 4),
          season: withProfile.season ?? hints.season,
          preferredColors: dedupe([...withProfile.preferredColors, ...hints.colors]).slice(0, 6),
          avoidColors: dedupe([...withProfile.avoidColors, ...hints.avoidColors]).slice(0, 6),
          parseConfidence: Math.max(withProfile.parseConfidence, 0.45),
        };
      }
    }

    return withProfile;
  }

  private async applyProfile(intent: ParsedIntent, userId: string | null): Promise<ParsedIntent> {
    if (!userId) return intent;

    const [user, profile] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { personalizationEnabled: true } }),
      this.prisma.styleProfile.findUnique({ where: { userId } }),
    ]);
    if (!user?.personalizationEnabled || !profile) return intent;

    return {
      ...intent,
      // The brief always wins; the profile only fills gaps.
      styles: intent.styles.length > 0 ? intent.styles : (profile.styles as ParsedIntent['styles']),
      preferredColors:
        intent.preferredColors.length > 0
          ? intent.preferredColors
          : (profile.colors as ParsedIntent['preferredColors']),
      avoidColors: dedupe([
        ...intent.avoidColors,
        ...(profile.dislikedColors as ParsedIntent['avoidColors']),
      ]),
      preferredBrandIds:
        intent.preferredBrandIds.length > 0 ? intent.preferredBrandIds : profile.favouriteBrandIds,
      occasions:
        intent.occasions.length > 0 ? intent.occasions : (profile.occasions as ParsedIntent['occasions']),
    };
  }

  /** The main entry point: a brief in, a buyable look out. */
  async generate(request: StylistRequest): Promise<OutfitView> {
    const startedAt = Date.now();
    const intent = await this.parseIntent(request);

    const template = this.resolveTemplate(intent, request.templateKey);
    const slots = template.slots
      .filter((entry) => !intent.excludedSlots.includes(entry.slot))
      .map((entry) => entry.slot);

    // If the brief names a garment explicitly, make sure its slot is present.
    for (const slot of intent.requiredSlots) {
      if (!slots.includes(slot)) slots.push(slot);
    }

    const preferredSizes = await this.preferredSizes(request.userId);
    const candidatesBySlot = await this.retrieval.candidatesBySlot({
      intent,
      locale: request.locale,
      slots,
      preferredSizes,
    });

    const assembled = assembleOutfit({
      template,
      intent,
      candidatesBySlot,
      beamWidth: 24,
    });

    if (!assembled) {
      // AI-002: better to say no than to invent or offer an unavailable item.
      const reason = await this.diagnoseFailure(intent, slots, candidatesBySlot);
      throw new AppError('NOT_FOUND', {
        message: translate(request.locale, 'ai.no_result'),
        status: 200 as never,
        details: {
          reason,
          suggestions: INTENT_EXAMPLES[request.locale],
          intent: serializeIntent(intent),
        },
      });
    }

    return this.materialize(assembled, intent, request, template, startedAt);
  }

  /**
   * Turn the assembled look into the API view: real product cards, fit
   * recommendations, the exact total (AI-005) and a persisted session.
   */
  private async materialize(
    assembled: AssembledOutfit,
    intent: ParsedIntent,
    request: StylistRequest,
    template: OutfitTemplate,
    startedAt: number,
  ): Promise<OutfitView> {
    const productIds = assembled.items.map((item) => item.candidate.productId);

    const [products, fitMap] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
        include: productCardInclude,
      }),
      // FIT-003: a recommendation per item, with confidence.
      this.fit.recommendForMany(
        assembled.items.map((item) => ({
          productId: item.candidate.productId,
          skuId: item.candidate.skuId,
        })),
        request.userId,
      ),
    ]);

    const wishlisted = await this.wishlistedIds(request.userId);
    const cardById = new Map<string, ProductCard>(
      products.map((product) => [
        product.id,
        mapProductCard(product, {
          locale: request.locale,
          wishlistedProductIds: wishlisted,
          aiPick: true,
        }),
      ]),
    );

    const explanation = explainOutfit(assembled, intent, request.locale);

    // AI-006: the deterministic reason always exists; the LLM only rewords it.
    const narrative = await this.llm.narrate({
      locale: request.locale,
      brief: intent.rawQuery || request.query,
      items: outfitFactsForLlm(assembled),
      reasonKeys: explanation.keys,
      withinBudget: assembled.withinBudget,
    });

    const alternatives = slotAlternatives(
      assembled,
      intent,
      await this.retrieval.candidatesBySlot({
        intent,
        locale: request.locale,
        slots: assembled.items.map((item) => item.slot),
        poolPerSlot: 24,
      }),
      8,
    );

    const latencyMs = Date.now() - startedAt;

    // AI-009: the session is the audit record — intent, result, versions.
    const session = await this.prisma.outfitSession.create({
      data: {
        userId: request.userId,
        rawQuery: intent.rawQuery || request.query,
        locale: request.locale as PrismaLocale,
        intent: serializeIntent(intent) as Prisma.InputJsonValue,
        templateKey: template.key,
        result: {
          items: assembled.items.map((item) => ({
            slot: item.slot,
            skuId: item.candidate.skuId,
            productId: item.candidate.productId,
            sellerId: item.candidate.sellerId,
            priceMinor: item.candidate.price.amount,
            sizeLabel: item.candidate.sizeLabel,
            itemScore: item.itemScore,
            reasons: item.hits.map((hit) => ({ code: hit.code, delta: hit.delta, detail: hit.detail })),
          })),
          softHits: assembled.softHits,
          unfilledSlots: assembled.unfilledSlots,
          dominantColors: assembled.dominantColors,
          formalitySpread: assembled.formalitySpread,
        } as unknown as Prisma.InputJsonValue,
        totalMinor: toMinor(assembled.total),
        currency: assembled.total.currency,
        score: assembled.score,
        engineVersion: ENGINE_VERSION,
        rulesVersion: RULES_VERSION,
        llmModel: narrative.model,
        narrative: narrative.text || null,
        latencyMs,
      },
    });

    await this.prisma.recommendationEvent.create({
      data: {
        userId: request.userId,
        sessionId: session.id,
        kind: 'OUTFIT',
        intent: serializeIntent(intent) as Prisma.InputJsonValue,
        resultSkuIds: assembled.items.map((item) => item.candidate.skuId),
        outfitId: session.id,
        engineVersion: ENGINE_VERSION,
        rulesVersion: RULES_VERSION,
        llmModel: narrative.model,
        llmPromptHash: narrative.promptHash,
        score: assembled.score,
        latencyMs,
      },
    });

    logger.info(
      {
        sessionId: session.id,
        items: assembled.items.length,
        total: assembled.total.amount,
        withinBudget: assembled.withinBudget,
        latencyMs,
        narrativeSource: narrative.source,
      },
      'stylist produced a look',
    );

    return {
      id: session.id,
      title: template.title[request.locale] ?? template.title.ru,
      items: assembled.items.map((item) => {
        const card = cardById.get(item.candidate.productId);
        const recommendation = fitMap.get(item.candidate.productId) ?? null;
        return {
          slot: item.slot,
          product: card ?? fallbackCard(item.candidate),
          skuId: item.candidate.skuId,
          sizeLabel: item.candidate.sizeLabel,
          price: item.candidate.price,
          fit: recommendation,
          reasons: item.hits
            .filter((hit) => hit.delta > 0)
            .map((hit) => hit.detail ?? hit.code)
            .slice(0, 3),
          alternativesCount: alternatives.get(item.slot)?.length ?? 0,
          locked: false,
        };
      }),
      total: assembled.total,
      budget: intent.budget,
      withinBudget: assembled.withinBudget,
      score: assembled.score,
      explanation: explanation.keys.map((entry) => translate(request.locale, entry.key, entry.params)),
      narrative: narrative.text || null,
      intent: {
        styles: intent.styles,
        occasions: intent.occasions,
        season: intent.season,
        colors: intent.preferredColors,
        budget: intent.budget,
        rawQuery: intent.rawQuery,
      },
      unfilledSlots: assembled.unfilledSlots,
      sellerCount: new Set(assembled.items.map((item) => item.candidate.sellerId)).size,
      generatedAt: session.createdAt.toISOString(),
      engine: { version: ENGINE_VERSION, model: narrative.model, rulesVersion: RULES_VERSION },
    };
  }

  /**
   * AI-007: swapping one item keeps the intent and the other items, and
   * recalculates the total. The session is updated, not replaced, so the
   * audit trail shows the replacement count.
   */
  async replaceSlot(
    sessionId: string,
    slot: OutfitSlot,
    options: { userId: string | null; locale: Locale; skuId?: string | null },
  ): Promise<OutfitView> {
    const session = await this.prisma.outfitSession.findFirst({
      where: { id: sessionId, ...(options.userId ? { userId: options.userId } : {}) },
    });
    if (!session) throw AppError.notFound('OutfitSession', sessionId);

    const stored = session.result as unknown as {
      items: Array<{ slot: OutfitSlot; skuId: string; productId: string }>;
    } | null;
    if (!stored?.items) throw AppError.validation('This stylist session has no stored look');

    const intent = deserializeIntent(session.intent, options.locale);
    const template = this.resolveTemplate(intent, session.templateKey);

    // Rebuild the current look from the catalogue so prices and stock are live.
    const current = await this.rebuildAssembled(stored.items, intent, options.locale);
    if (!current) throw AppError.validation('The stored look is no longer available');

    const target = current.items.find((item) => item.slot === slot);
    if (!target) throw AppError.validation(`This look has no ${slot} to replace`);

    const pool = await this.retrieval.candidatesForSlot(
      slot,
      { intent, locale: options.locale, slots: [slot] },
      40,
    );

    const ranked = replaceItem(current, slot, {
      intent,
      candidates: pool,
      excludeSkuIds: new Set([target.candidate.skuId]),
      limit: 12,
    });

    const chosen = options.skuId
      ? ranked.find((entry) => entry.candidate.skuId === options.skuId)
      : ranked.find((entry) => entry.withinBudget) ?? ranked[0];

    if (!chosen) {
      throw new AppError('NOT_FOUND', {
        message: translate(options.locale, 'ai.slot_unfilled', { slot }),
        status: 200 as never,
        details: { slot, reason: 'no_alternative_available' },
      });
    }

    const locked = new Map<OutfitSlot, OutfitCandidate>();
    for (const item of current.items) {
      locked.set(item.slot, item.slot === slot ? chosen.candidate : item.candidate);
    }

    const candidatesBySlot = new Map<OutfitSlot, OutfitCandidate[]>();
    for (const [slotKey, candidate] of locked.entries()) {
      candidatesBySlot.set(slotKey, [candidate]);
    }

    const reassembled = assembleOutfit({
      template,
      // AI-007: the intent, including the budget, is preserved verbatim.
      intent,
      candidatesBySlot,
      locked,
      beamWidth: 4,
    });
    if (!reassembled) throw AppError.validation('The replacement does not produce a valid look');

    await this.prisma.outfitSession.update({
      where: { id: session.id },
      data: { replacements: { increment: 1 } },
    });

    const view = await this.materialize(
      reassembled,
      intent,
      { query: session.rawQuery, userId: options.userId, locale: options.locale },
      template,
      Date.now(),
    );

    return { ...view, id: view.id };
  }

  /** The swap carousel for one slot. */
  async alternativesForSlot(
    sessionId: string,
    slot: OutfitSlot,
    options: { userId: string | null; locale: Locale },
  ) {
    const session = await this.prisma.outfitSession.findFirst({
      where: { id: sessionId, ...(options.userId ? { userId: options.userId } : {}) },
    });
    if (!session) throw AppError.notFound('OutfitSession', sessionId);

    const stored = session.result as unknown as {
      items: Array<{ slot: OutfitSlot; skuId: string; productId: string }>;
    } | null;
    if (!stored?.items) return { slot, items: [] };

    const intent = deserializeIntent(session.intent, options.locale);
    const current = await this.rebuildAssembled(stored.items, intent, options.locale);
    if (!current) return { slot, items: [] };

    const pool = await this.retrieval.candidatesForSlot(
      slot,
      { intent, locale: options.locale, slots: [slot] },
      40,
    );
    const target = current.items.find((item) => item.slot === slot);

    const ranked = replaceItem(current, slot, {
      intent,
      candidates: pool,
      excludeSkuIds: target ? new Set([target.candidate.skuId]) : undefined,
      limit: 12,
    });

    const products = await this.prisma.product.findMany({
      where: { id: { in: ranked.map((entry) => entry.candidate.productId) } },
      include: productCardInclude,
    });
    const wishlisted = await this.wishlistedIds(options.userId);
    const cardById = new Map(
      products.map((product) => [
        product.id,
        mapProductCard(product, { locale: options.locale, wishlistedProductIds: wishlisted, aiPick: true }),
      ]),
    );

    return {
      slot,
      items: ranked.map((entry) => ({
        skuId: entry.candidate.skuId,
        sizeLabel: entry.candidate.sizeLabel,
        score: entry.score,
        newTotal: entry.newTotal,
        withinBudget: entry.withinBudget,
        product: cardById.get(entry.candidate.productId) ?? fallbackCard(entry.candidate),
      })),
    };
  }

  /** AI-008: the cart add re-validates stock and size one last time. */
  async prepareForCart(
    sessionId: string,
    userId: string,
  ): Promise<{
    items: Array<{ skuId: string; quantity: number; fitConfidence: number | null }>;
    exceptions: Array<{ skuId: string; reason: string; message: string }>;
    total: Money;
  }> {
    const session = await this.prisma.outfitSession.findFirst({
      where: { id: sessionId, OR: [{ userId }, { userId: null }] },
    });
    if (!session) throw AppError.notFound('OutfitSession', sessionId);

    const stored = session.result as unknown as {
      items: Array<{ skuId: string; productId: string; sizeLabel: string }>;
    } | null;
    if (!stored?.items?.length) throw AppError.validation('This stylist session has no stored look');

    const validation = await this.retrieval.revalidate(stored.items.map((item) => item.skuId));
    const fitMap = await this.fit.recommendForMany(
      stored.items.map((item) => ({ productId: item.productId, skuId: item.skuId })),
      userId,
    );

    const items: Array<{ skuId: string; quantity: number; fitConfidence: number | null }> = [];
    const exceptions: Array<{ skuId: string; reason: string; message: string }> = [];
    const prices: Money[] = [];

    for (const item of stored.items) {
      const state = validation.get(item.skuId);
      if (!state || !state.published) {
        exceptions.push({
          skuId: item.skuId,
          reason: 'NOT_PURCHASABLE',
          message: 'This item is no longer on sale',
        });
        continue;
      }
      if (state.available <= 0) {
        exceptions.push({
          skuId: item.skuId,
          reason: 'OUT_OF_STOCK',
          message: `Size ${item.sizeLabel} sold out`,
        });
        continue;
      }
      const recommendation = fitMap.get(item.productId);
      items.push({
        skuId: item.skuId,
        quantity: 1,
        fitConfidence: recommendation?.confidence ?? null,
      });
      prices.push(toMoney(state.priceMinor, session.currency));
    }

    return {
      items,
      exceptions,
      total: prices.length > 0 ? sum(prices) : zero(this.config.DEFAULT_CURRENCY),
    };
  }

  async getSession(sessionId: string, userId: string | null, locale: Locale): Promise<OutfitView | null> {
    const session = await this.prisma.outfitSession.findFirst({
      where: { id: sessionId, ...(userId ? { OR: [{ userId }, { userId: null }] } : {}) },
    });
    if (!session) return null;

    const stored = session.result as unknown as {
      items: Array<{ slot: OutfitSlot; skuId: string; productId: string }>;
    } | null;
    if (!stored?.items) return null;

    const intent = deserializeIntent(session.intent, locale);
    const current = await this.rebuildAssembled(stored.items, intent, locale);
    if (!current) return null;

    const template = this.resolveTemplate(intent, session.templateKey);
    return this.materialize(current, intent, { query: session.rawQuery, userId, locale }, template, Date.now());
  }

  /**
   * AI-005: the shopper's saved looks. Each row carries the item count and a
   * few thumbnails, read out of the stored snapshot, so the history can be
   * shown as the looks it represents rather than as a list of query strings.
   *
   * One extra query for the whole page: the snapshot holds the product ids, so
   * the images are fetched in a single batch rather than per row.
   */
  async history(userId: string, limit = 20) {
    const rows = await this.prisma.outfitSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        rawQuery: true,
        totalMinor: true,
        currency: true,
        score: true,
        createdAt: true,
        addedToCartAt: true,
        replacements: true,
        result: true,
      },
    });

    const productIdsBySession = new Map<string, string[]>();
    for (const row of rows) {
      const snapshot = row.result as { items?: Array<{ productId?: string }> } | null;
      const ids = (snapshot?.items ?? [])
        .map((item) => item.productId)
        .filter((id): id is string => typeof id === 'string');
      productIdsBySession.set(row.id, ids);
    }

    const allIds = [...new Set([...productIdsBySession.values()].flat())];
    const media =
      allIds.length === 0
        ? []
        : await this.prisma.media.findMany({
            where: { productId: { in: allIds }, kind: 'IMAGE' },
            orderBy: [{ sortOrder: 'asc' }],
            select: { productId: true, url: true },
          });

    // First image per product; sortOrder makes that the main one.
    const thumbnailByProduct = new Map<string, string>();
    for (const asset of media) {
      if (asset.productId && !thumbnailByProduct.has(asset.productId)) {
        thumbnailByProduct.set(asset.productId, asset.url);
      }
    }

    return rows.map((row) => {
      const ids = productIdsBySession.get(row.id) ?? [];
      return {
        id: row.id,
        query: row.rawQuery,
        total: row.totalMinor ? toMoney(row.totalMinor, row.currency) : null,
        score: row.score,
        createdAt: row.createdAt.toISOString(),
        addedToCart: row.addedToCartAt != null,
        replacements: row.replacements,
        itemCount: ids.length,
        thumbnails: ids
          .map((id) => thumbnailByProduct.get(id))
          .filter((url): url is string => Boolean(url))
          .slice(0, 4),
      };
    });
  }

  /** Templates come from the DB when seeded (AI-003), else from core. */
  private resolveTemplate(intent: ParsedIntent, key?: string | null): OutfitTemplate {
    if (key) {
      const found = DEFAULT_OUTFIT_TEMPLATES.find((template) => template.key === key);
      if (found) return found;
    }
    return templateForIntent(intent.styles, intent.occasions, intent.season);
  }

  private async rebuildAssembled(
    items: Array<{ slot: OutfitSlot; skuId: string; productId: string }>,
    intent: ParsedIntent,
    locale: Locale,
  ): Promise<AssembledOutfit | null> {
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: items.map((item) => item.skuId) } },
      include: {
        inventory: true,
        product: {
          include: {
            brand: { select: { id: true, name: true } },
            category: { select: { slug: true, slot: true } },
            media: { orderBy: { sortOrder: 'asc' }, take: 1 },
          },
        },
      },
    });

    const bySku = new Map(skus.map((sku) => [sku.id, sku]));
    const candidates: OutfitCandidate[] = [];

    for (const item of items) {
      const sku = bySku.get(item.skuId);
      if (!sku) continue;
      const available = Math.max(
        0,
        (sku.inventory?.onHand ?? 0) - (sku.inventory?.reserved ?? 0) - (sku.inventory?.safetyStock ?? 0),
      );
      candidates.push({
        skuId: sku.id,
        productId: sku.productId,
        sellerId: sku.product.sellerId,
        brandId: sku.product.brandId,
        brandName: sku.product.brand.name,
        title: localizedTitle(sku.product, locale),
        categorySlug: sku.product.category.slug,
        slot: item.slot,
        price: toMoney(sku.priceMinor, sku.currency),
        compareAtPrice: sku.compareAtMinor ? toMoney(sku.compareAtMinor, sku.currency) : null,
        sizeLabel: sku.sizeLabel,
        available,
        styleTags: sku.product.styleTags as never,
        colorFamily: sku.product.colorFamily as never,
        silhouette: (sku.product.silhouette as never) ?? null,
        formality: Math.max(1, Math.min(5, sku.product.formality)) as never,
        warmth: Math.max(1, Math.min(5, sku.product.warmth)) as never,
        season: sku.product.season as never,
        imageUrl: sku.product.media[0]?.url ?? null,
        popularity: 0,
        incompatibleWithSlots: sku.product.incompatibleSlots as never,
        incompatibleWithStyles: sku.product.incompatibleStyles as never,
      });
    }

    if (candidates.length === 0) return null;

    const candidatesBySlot = new Map<OutfitSlot, OutfitCandidate[]>();
    const locked = new Map<OutfitSlot, OutfitCandidate>();
    for (const candidate of candidates) {
      candidatesBySlot.set(candidate.slot, [candidate]);
      locked.set(candidate.slot, candidate);
    }

    const template = this.resolveTemplate(intent, null);
    return assembleOutfit({
      template: {
        ...template,
        // Rebuilding must not drop a slot the stored look actually used.
        slots: candidates.map((candidate) => ({
          slot: candidate.slot,
          required: true,
          budgetWeight: 1 / candidates.length,
        })),
      },
      // Budget is not re-enforced while rebuilding: the look was already
      // accepted. It is enforced again on replacement.
      intent: { ...intent, budget: null },
      candidatesBySlot,
      locked,
      beamWidth: 2,
    });
  }

  /** Honest diagnosis when nothing could be built, for the UI to explain. */
  private async diagnoseFailure(
    intent: ParsedIntent,
    slots: OutfitSlot[],
    candidatesBySlot: Map<OutfitSlot, OutfitCandidate[]>,
  ): Promise<{ code: string; detail: string; emptySlots: OutfitSlot[]; minimumBudget?: string }> {
    const emptySlots = slots.filter((slot) => (candidatesBySlot.get(slot) ?? []).length === 0);

    if (emptySlots.length > 0) {
      return {
        code: 'EMPTY_SLOTS',
        detail: `The catalogue has nothing buyable for: ${emptySlots.join(', ')}`,
        emptySlots,
      };
    }

    if (intent.budget) {
      const minimums = await this.retrieval.minimumPriceBySlot(slots);
      const floor = [...minimums.values()].reduce((acc, value) => acc + value, 0n);
      if (floor > toBigInt(intent.budget)) {
        return {
          code: 'BUDGET_TOO_LOW',
          detail: 'The cheapest available combination costs more than the stated budget',
          emptySlots: [],
          minimumBudget: floor.toString(),
        };
      }
    }

    return {
      code: 'NO_COMPATIBLE_COMBINATION',
      detail: 'Items exist but no combination satisfies the hard compatibility rules',
      emptySlots: [],
    };
  }

  private async preferredSizes(userId: string | null): Promise<Record<string, string>> {
    if (!userId) return {};
    const [profile, fitProfile] = await Promise.all([
      this.prisma.styleProfile.findUnique({ where: { userId }, select: { sizes: true } }),
      this.prisma.fitProfile.findUnique({
        where: { userId },
        select: { usualSizes: true, consentPersonalizedFit: true },
      }),
    ]);
    return {
      ...((profile?.sizes as Record<string, string>) ?? {}),
      ...(fitProfile?.consentPersonalizedFit
        ? ((fitProfile.usualSizes as Record<string, string>) ?? {})
        : {}),
    };
  }

  private async wishlistedIds(userId: string | null): Promise<Set<string>> {
    if (!userId) return new Set();
    const rows = await this.prisma.wishlistItem.findMany({
      where: { userId },
      select: { productId: true },
    });
    return new Set(rows.map((row) => row.productId));
  }

  /** Suggestion chips for the empty stylist screen. */
  suggestions(locale: Locale): string[] {
    return INTENT_EXAMPLES[locale];
  }

  templates(locale: Locale) {
    return DEFAULT_OUTFIT_TEMPLATES.map((template) => ({
      key: template.key,
      title: template.title[locale] ?? template.title.ru,
      slots: template.slots.map((entry) => entry.slot),
      styles: template.styleAffinity,
      occasions: template.occasions,
    }));
  }
}

function serializeIntent(intent: ParsedIntent): Record<string, unknown> {
  return {
    rawQuery: intent.rawQuery,
    language: intent.language,
    styles: intent.styles,
    occasions: intent.occasions,
    season: intent.season,
    budget: intent.budget,
    preferredColors: intent.preferredColors,
    avoidColors: intent.avoidColors,
    preferredBrandIds: intent.preferredBrandIds,
    excludedBrandIds: intent.excludedBrandIds,
    requiredSlots: intent.requiredSlots,
    excludedSlots: intent.excludedSlots,
    gender: intent.gender,
    parseConfidence: intent.parseConfidence,
    unmatchedTerms: intent.unmatchedTerms,
    searchTerms: intent.searchTerms,
  };
}

function deserializeIntent(stored: unknown, locale: Locale): ParsedIntent {
  const value = (stored ?? {}) as Partial<ParsedIntent>;
  return {
    rawQuery: value.rawQuery ?? '',
    language: value.language ?? locale,
    styles: value.styles ?? [],
    occasions: value.occasions ?? [],
    season: value.season ?? null,
    budget: value.budget ?? null,
    preferredColors: value.preferredColors ?? [],
    avoidColors: value.avoidColors ?? [],
    preferredBrandIds: value.preferredBrandIds ?? [],
    excludedBrandIds: value.excludedBrandIds ?? [],
    requiredSlots: value.requiredSlots ?? [],
    excludedSlots: value.excludedSlots ?? [],
    gender: value.gender ?? null,
    freeText: value.freeText ?? value.rawQuery ?? '',
    parseConfidence: value.parseConfidence ?? 0,
    unmatchedTerms: value.unmatchedTerms ?? [],
    searchTerms: value.searchTerms ?? [],
  };
}

function localizedTitle(
  product: { titleRu: string; titleUz: string; titleEn: string | null },
  locale: Locale,
): string {
  if (locale === 'uz') return product.titleUz || product.titleRu;
  if (locale === 'en') return product.titleEn || product.titleRu;
  return product.titleRu;
}

/** Only used if a product vanished between retrieval and mapping. */
function fallbackCard(candidate: OutfitCandidate): ProductCard {
  return {
    id: candidate.productId,
    slug: candidate.productId,
    title: candidate.title,
    brand: {
      id: candidate.brandId,
      slug: candidate.brandId,
      name: candidate.brandName,
      logoUrl: null,
      verified: false,
    },
    price: candidate.price,
    compareAtPrice: candidate.compareAtPrice ?? null,
    discountPercent: null,
    media: candidate.imageUrl
      ? [
          {
            id: `${candidate.productId}-main`,
            url: candidate.imageUrl,
            kind: 'IMAGE',
            role: 'MAIN',
            alt: candidate.title,
            width: null,
            height: null,
          },
        ]
      : [],
    colorFamily: candidate.colorFamily,
    colorName: candidate.colorFamily,
    availableSizes: [candidate.sizeLabel],
    inStock: candidate.available > 0,
    isWishlisted: false,
    styleTags: candidate.styleTags,
    categorySlug: candidate.categorySlug,
    badges: ['AI_PICK'],
    rating: null,
  };
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
