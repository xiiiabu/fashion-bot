/**
 * Candidate retrieval for the stylist — spec AI-002.
 *
 * "Retrieval только по published, priced, in-stock SKU.
 *  Критерий: нет вымышленных/out-of-stock товаров."
 *
 * This is the guardrail from §6.3 made concrete: the LLM never names a product.
 * Everything the stylist can choose from comes out of this file, straight from
 * the catalogue, already filtered to things a shopper can actually buy today.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type ColorFamily,
  type FormalityLevel,
  type Locale,
  type OutfitCandidate,
  type OutfitSlot,
  type Season,
  type Silhouette,
  type StyleTag,
  type WarmthLevel,
  pickLocalized,
  sizeSortKey,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { toMoney } from '../common/money.util';
import { availableUnits } from '../catalog/product-mapper';
import type { ParsedIntent } from '@fashion/core';

/** How many products per slot to pull before scoring. */
const POOL_PER_SLOT = 40;

export interface RetrievalOptions {
  readonly intent: ParsedIntent;
  readonly locale: Locale;
  readonly slots: OutfitSlot[];
  /** Restrict to one shopper's preferred size when we know it. */
  readonly preferredSizes?: Record<string, string>;
  readonly excludeProductIds?: Set<string>;
  readonly poolPerSlot?: number;
}

@Injectable()
export class RetrievalService {
  constructor(private readonly prisma: PrismaService) {}

  async candidatesBySlot(options: RetrievalOptions): Promise<Map<OutfitSlot, OutfitCandidate[]>> {
    const out = new Map<OutfitSlot, OutfitCandidate[]>();
    const pool = options.poolPerSlot ?? POOL_PER_SLOT;

    for (const slot of options.slots) {
      const candidates = await this.candidatesForSlot(slot, options, pool);
      out.set(slot, candidates);
    }
    return out;
  }

  async candidatesForSlot(
    slot: OutfitSlot,
    options: RetrievalOptions,
    limit = POOL_PER_SLOT,
  ): Promise<OutfitCandidate[]> {
    const { intent } = options;

    const where: Prisma.ProductWhereInput = {
      // AI-002: published, with a live seller.
      lifecycle: 'PUBLISHED',
      archivedAt: null,
      seller: { onboardingStatus: 'ACTIVE', suspendedAt: null },
      category: { slot },
      // AI-002: priced and in stock. `onHand > 0` is the coarse filter; the
      // precise available-units check happens after the join below, because
      // reserved units are what make "last item" cases correct.
      skus: { some: { isActive: true, priceMinor: { gt: 0 }, inventory: { onHand: { gt: 0 } } } },
      ...(intent.excludedBrandIds.length > 0 ? { brandId: { notIn: intent.excludedBrandIds } } : {}),
      ...(intent.avoidColors.length > 0 ? { colorFamily: { notIn: intent.avoidColors } } : {}),
      ...(options.excludeProductIds && options.excludeProductIds.size > 0
        ? { id: { notIn: [...options.excludeProductIds] } }
        : {}),
      ...(intent.gender
        ? { gender: { in: [intent.gender.toUpperCase() as 'WOMEN' | 'MEN' | 'UNISEX', 'UNISEX'] } }
        : {}),
      ...(intent.season && intent.season !== 'ALL_SEASON'
        ? { OR: [{ season: intent.season }, { season: 'ALL_SEASON' }, { season: 'TRANSITIONAL' }] }
        : {}),
    };

    // Prefer products that already match the brief: the style tags first, then
    // popularity. Over-fetching and scoring in memory keeps the SQL simple and
    // lets the compatibility engine see enough variety to balance a budget.
    const [onBrief, fallback] = await Promise.all([
      intent.styles.length > 0
        ? this.prisma.product.findMany({
            where: { ...where, styleTags: { hasSome: intent.styles } },
            include: PRODUCT_INCLUDE,
            orderBy: [{ popularityScore: 'desc' }, { publishedAt: 'desc' }],
            take: limit,
          })
        : Promise.resolve([]),
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy: [{ popularityScore: 'desc' }, { publishedAt: 'desc' }],
        take: limit,
      }),
    ]);

    const seen = new Set<string>();
    const merged = [...onBrief, ...fallback].filter((product) => {
      if (seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    });

    const curatedLookIds = await this.curatedLookIdsFor(merged.map((product) => product.id));

    const candidates: OutfitCandidate[] = [];
    for (const product of merged) {
      // Pick the SKU to offer: the shopper's usual size when it is available,
      // otherwise the mid size that is in stock. Never an unavailable one.
      const buyable = product.skus
        .filter((sku) => availableUnits(sku.inventory) > 0 && sku.priceMinor > 0n)
        .sort((a, b) => sizeSortKey(a.sizeLabel) - sizeSortKey(b.sizeLabel));
      if (buyable.length === 0) continue;

      const preferred = options.preferredSizes?.[product.brandId];
      const chosen =
        (preferred
          ? buyable.find((sku) => sku.sizeLabel.toUpperCase() === preferred.toUpperCase())
          : undefined) ?? buyable[Math.floor(buyable.length / 2)]!;

      candidates.push({
        skuId: chosen.id,
        productId: product.id,
        sellerId: product.sellerId,
        brandId: product.brandId,
        brandName: product.brand.name,
        title: pickLocalized(
          { ru: product.titleRu, uz: product.titleUz, en: product.titleEn },
          options.locale,
        ),
        categorySlug: product.category.slug,
        slot,
        price: toMoney(chosen.priceMinor, chosen.currency),
        compareAtPrice: chosen.compareAtMinor ? toMoney(chosen.compareAtMinor, chosen.currency) : null,
        sizeLabel: chosen.sizeLabel,
        available: availableUnits(chosen.inventory),
        styleTags: product.styleTags as StyleTag[],
        colorFamily: product.colorFamily as ColorFamily,
        silhouette: (product.silhouette as Silhouette) ?? null,
        formality: clampLevel(product.formality) as FormalityLevel,
        warmth: clampLevel(product.warmth) as WarmthLevel,
        season: product.season as Season,
        imageUrl: product.media[0]?.url ?? null,
        curatedLookIds: curatedLookIds.get(product.id) ?? [],
        popularity: normalizePopularity(product.popularityScore),
        incompatibleWithSlots: product.incompatibleSlots as OutfitSlot[],
        incompatibleWithStyles: product.incompatibleStyles as StyleTag[],
      });
    }

    return candidates;
  }

  /** AI-010: curated looks act as a prior, so editorial pairings surface. */
  private async curatedLookIdsFor(productIds: string[]): Promise<Map<string, string[]>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.prisma.curatedOutfitItem.findMany({
      where: { productId: { in: productIds }, outfit: { isActive: true } },
      select: { productId: true, outfitId: true },
    });
    const out = new Map<string, string[]>();
    for (const row of rows) {
      const list = out.get(row.productId) ?? [];
      list.push(row.outfitId);
      out.set(row.productId, list);
    }
    return out;
  }

  /**
   * Re-validate a candidate immediately before it enters the cart (AI-008:
   * "add whole look ... повторно валидирует размер/stock").
   */
  async revalidate(
    skuIds: string[],
  ): Promise<Map<string, { available: number; priceMinor: bigint; published: boolean }>> {
    const rows = await this.prisma.sku.findMany({
      where: { id: { in: skuIds } },
      include: {
        inventory: true,
        product: { select: { lifecycle: true, archivedAt: true, seller: { select: { onboardingStatus: true } } } },
      },
    });
    const out = new Map<string, { available: number; priceMinor: bigint; published: boolean }>();
    for (const row of rows) {
      out.set(row.id, {
        available: availableUnits(row.inventory),
        priceMinor: row.priceMinor,
        published:
          row.isActive &&
          row.product.lifecycle === 'PUBLISHED' &&
          row.product.archivedAt == null &&
          row.product.seller.onboardingStatus === 'ACTIVE',
      });
    }
    return out;
  }

  /** The slots the catalogue can actually fill right now, for the UI. */
  async availableSlots(): Promise<OutfitSlot[]> {
    const rows = await this.prisma.product.findMany({
      where: {
        lifecycle: 'PUBLISHED',
        archivedAt: null,
        skus: { some: { isActive: true, inventory: { onHand: { gt: 0 } } } },
      },
      select: { category: { select: { slot: true } } },
      distinct: ['categoryId'],
    });
    const slots = new Set<OutfitSlot>();
    for (const row of rows) {
      if (row.category.slot) slots.add(row.category.slot as OutfitSlot);
    }
    return [...slots];
  }

  /** Cheapest buyable price per slot, used to sanity-check a budget. */
  async minimumPriceBySlot(slots: OutfitSlot[]): Promise<Map<OutfitSlot, bigint>> {
    const out = new Map<OutfitSlot, bigint>();
    for (const slot of slots) {
      const aggregate = await this.prisma.sku.aggregate({
        where: {
          isActive: true,
          priceMinor: { gt: 0 },
          inventory: { onHand: { gt: 0 } },
          product: {
            lifecycle: 'PUBLISHED',
            archivedAt: null,
            category: { slot },
          },
        },
        _min: { priceMinor: true },
      });
      if (aggregate._min.priceMinor != null) out.set(slot, aggregate._min.priceMinor);
    }
    return out;
  }
}

const PRODUCT_INCLUDE = {
  brand: { select: { id: true, name: true } },
  category: { select: { slug: true, slot: true } },
  media: { orderBy: { sortOrder: 'asc' as const }, take: 1 },
  skus: { where: { isActive: true }, include: { inventory: true } },
} as const;

function clampLevel(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function normalizePopularity(score: number): number {
  // Scores are unbounded counters; squash into [0,1] so the tie-break weight
  // in the compatibility engine stays small whatever the catalogue size.
  return score <= 0 ? 0 : Math.min(1, Math.log10(1 + score) / 3);
}
