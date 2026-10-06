/**
 * Size & fit service — spec §6.2.
 *
 * The decision logic is a pure function in @fashion/core (`recommendSize`);
 * this service's job is to assemble its inputs honestly:
 *  - the brand/category/model size chart and the SKU's own measurements (FIT-001)
 *  - the shopper's fit profile, but only when consent is live (FIT-002, UAT-19)
 *  - the aggregated community feedback for the SKU (FIT-005)
 * and to persist feedback and the recommendation event.
 */

import { Injectable } from '@nestjs/common';
import {
  type FitFeedbackAggregate,
  type FitProfile,
  type FitRecommendation,
  type SizeCandidate,
  type SizeChart,
  recommendSize,
  sizeSortKey,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { AppError } from '../common/errors';
import { availableUnits, mapSizeChart } from '../catalog/product-mapper';

export interface FitRequest {
  readonly productId: string;
  readonly userId?: string | null;
  /** When set, the recommendation is scoped to this single size. */
  readonly skuId?: string | null;
}

@Injectable()
export class FitService {
  private readonly config = loadConfig();

  constructor(private readonly prisma: PrismaService) {}

  async recommendForProduct(request: FitRequest): Promise<FitRecommendation | null> {
    const product = await this.prisma.product.findUnique({
      where: { id: request.productId },
      include: {
        category: true,
        sizeChart: true,
        brand: { select: { id: true, sizeCharts: { take: 5 } } },
        skus: { where: { isActive: true }, include: { inventory: true }, orderBy: { sizeOrder: 'asc' } },
      },
    });
    if (!product) return null;

    const chart = await this.resolveChart(product);
    const candidates: SizeCandidate[] = product.skus
      .slice()
      .sort((a, b) => sizeSortKey(a.sizeLabel) - sizeSortKey(b.sizeLabel))
      .map((sku, index) => ({
        sizeLabel: sku.sizeLabel,
        skuId: sku.id,
        inStock: availableUnits(sku.inventory) > 0,
        order: sku.sizeOrder || index,
      }));

    if (candidates.length === 0) return null;

    const profile = await this.loadProfile(request.userId);
    const feedback = await this.aggregateFeedback(product.skus.map((sku) => sku.id));

    // Prefer the model's own flat measurements when the catalogue has them
    // (§5.1 "product measurements"), since they beat a brand-wide chart.
    const productMeasurements: Record<string, Record<string, number>> = {};
    for (const sku of product.skus) {
      const measurements = sku.measurements as Record<string, number> | null;
      if (measurements && Object.keys(measurements).length > 0) {
        productMeasurements[sku.sizeLabel] = measurements;
      }
    }

    return recommendSize({
      chart,
      candidates,
      profile,
      feedback,
      categorySlug: product.category.slug,
      brandId: product.brandId,
      productMeasurements: Object.keys(productMeasurements).length > 0 ? productMeasurements : null,
      confidenceThreshold: this.config.AI_FIT_CONFIDENCE_THRESHOLD,
    });
  }

  /**
   * Batch variant for the stylist: one query per product would make a
   * five-item look five round trips per candidate.
   */
  async recommendForMany(
    entries: Array<{ productId: string; skuId?: string }>,
    userId: string | null | undefined,
  ): Promise<Map<string, FitRecommendation>> {
    const out = new Map<string, FitRecommendation>();
    const profile = await this.loadProfile(userId);

    const products = await this.prisma.product.findMany({
      where: { id: { in: entries.map((entry) => entry.productId) } },
      include: {
        category: true,
        sizeChart: true,
        skus: { where: { isActive: true }, include: { inventory: true }, orderBy: { sizeOrder: 'asc' } },
      },
    });

    const allSkuIds = products.flatMap((product) => product.skus.map((sku) => sku.id));
    const feedbackBySku = await this.aggregateFeedbackPerSku(allSkuIds);

    for (const product of products) {
      const chart = await this.resolveChart(product);
      const candidates: SizeCandidate[] = product.skus
        .slice()
        .sort((a, b) => sizeSortKey(a.sizeLabel) - sizeSortKey(b.sizeLabel))
        .map((sku, index) => ({
          sizeLabel: sku.sizeLabel,
          skuId: sku.id,
          inStock: availableUnits(sku.inventory) > 0,
          order: sku.sizeOrder || index,
        }));
      if (candidates.length === 0) continue;

      const aggregate = mergeAggregates(
        product.skus.map((sku) => feedbackBySku.get(sku.id)).filter(Boolean) as FitFeedbackAggregate[],
      );

      const productMeasurements: Record<string, Record<string, number>> = {};
      for (const sku of product.skus) {
        const measurements = sku.measurements as Record<string, number> | null;
        if (measurements && Object.keys(measurements).length > 0) {
          productMeasurements[sku.sizeLabel] = measurements;
        }
      }

      out.set(
        product.id,
        recommendSize({
          chart,
          candidates,
          profile,
          feedback: aggregate,
          categorySlug: product.category.slug,
          brandId: product.brandId,
          productMeasurements: Object.keys(productMeasurements).length > 0 ? productMeasurements : null,
          confidenceThreshold: this.config.AI_FIT_CONFIDENCE_THRESHOLD,
        }),
      );
    }
    return out;
  }

  /**
   * FIT-002 / UAT-19: the profile is used only while the consent row is live.
   * Withdrawing consent stops new personalised uses immediately because this
   * read, not a cached flag, decides.
   */
  private async loadProfile(userId: string | null | undefined): Promise<FitProfile | null> {
    if (!userId) return null;

    const [user, fitProfile, styleProfile, consent] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { personalizationEnabled: true },
      }),
      this.prisma.fitProfile.findUnique({ where: { userId } }),
      this.prisma.styleProfile.findUnique({ where: { userId }, select: { preferredFit: true, sizes: true } }),
      this.prisma.consent.findFirst({
        where: { userId, scope: 'FIT_PROFILE', granted: true, revokedAt: null },
        orderBy: { grantedAt: 'desc' },
        select: { id: true },
      }),
    ]);

    if (!fitProfile) {
      // The quiz's "sizes" answers are still usable as a usual-size signal,
      // provided personalisation is on at all (USR-006).
      if (!styleProfile || user?.personalizationEnabled === false) return null;
      return {
        preferredFit: (styleProfile.preferredFit as FitProfile['preferredFit']) ?? null,
        usualSizes: (styleProfile.sizes as Record<string, string>) ?? {},
        consentPersonalizedFit: Boolean(consent),
      };
    }

    const consentLive =
      Boolean(consent) && fitProfile.consentPersonalizedFit && user?.personalizationEnabled !== false;

    return {
      heightMm: fitProfile.heightMm,
      weightGrams: fitProfile.weightGrams,
      body: (fitProfile.measurements as FitProfile['body']) ?? {},
      preferredFit:
        (fitProfile.preferredFit as FitProfile['preferredFit']) ??
        (styleProfile?.preferredFit as FitProfile['preferredFit']) ??
        null,
      usualSizes: {
        ...((styleProfile?.sizes as Record<string, string>) ?? {}),
        ...((fitProfile.usualSizes as Record<string, string>) ?? {}),
      },
      consentPersonalizedFit: consentLive,
    };
  }

  /**
   * FIT-001: resolve the most specific chart available — the model's own,
   * then brand+category, then category, then brand.
   */
  private async resolveChart(product: {
    sizeChart: Parameters<typeof mapSizeChart>[0];
    brandId: string;
    categoryId: string;
    category: { slug: string };
  }): Promise<SizeChart | null> {
    if (product.sizeChart) return mapSizeChart(product.sizeChart, product.category.slug);

    const chart = await this.prisma.sizeChart.findFirst({
      where: {
        OR: [
          { brandId: product.brandId, categoryId: product.categoryId },
          { brandId: null, categoryId: product.categoryId },
          { brandId: product.brandId, categoryId: null },
        ],
      },
      orderBy: [{ brandId: 'desc' }, { categoryId: 'desc' }],
    });
    return mapSizeChart(chart, product.category.slug);
  }

  private async aggregateFeedback(skuIds: string[]): Promise<FitFeedbackAggregate | null> {
    const perSku = await this.aggregateFeedbackPerSku(skuIds);
    const merged = mergeAggregates([...perSku.values()]);
    return merged;
  }

  private async aggregateFeedbackPerSku(skuIds: string[]): Promise<Map<string, FitFeedbackAggregate>> {
    const out = new Map<string, FitFeedbackAggregate>();
    if (skuIds.length === 0) return out;

    const rows = await this.prisma.fitFeedback.groupBy({
      by: ['skuId', 'overall'],
      where: { skuId: { in: skuIds } },
      _count: { _all: true },
    });

    for (const row of rows) {
      const current =
        out.get(row.skuId) ?? { runsSmall: 0, runsTrue: 0, runsLarge: 0, sampleSize: 0 };
      const next: FitFeedbackAggregate = {
        runsSmall: current.runsSmall + (row.overall === 'RUNS_SMALL' ? row._count._all : 0),
        runsTrue: current.runsTrue + (row.overall === 'TRUE_TO_SIZE' ? row._count._all : 0),
        runsLarge: current.runsLarge + (row.overall === 'RUNS_LARGE' ? row._count._all : 0),
        sampleSize: current.sampleSize + row._count._all,
      };
      out.set(row.skuId, next);
    }
    return out;
  }

  /** FIT-005: feedback is tied to the SKU and to a real delivered order item. */
  async submitFeedback(
    userId: string,
    input: {
      skuId: string;
      orderItemId?: string | null;
      overall: 'RUNS_SMALL' | 'TRUE_TO_SIZE' | 'RUNS_LARGE';
      length?: 'RUNS_SMALL' | 'TRUE_TO_SIZE' | 'RUNS_LARGE' | null;
      width?: 'RUNS_SMALL' | 'TRUE_TO_SIZE' | 'RUNS_LARGE' | null;
      comfort?: number | null;
      comment?: string | null;
    },
  ): Promise<{ id: string; verifiedPurchase: boolean }> {
    const sku = await this.prisma.sku.findUnique({ where: { id: input.skuId }, select: { id: true } });
    if (!sku) throw AppError.notFound('Sku', input.skuId);

    // The quality check: feedback only counts as verified when it comes from a
    // delivered order item belonging to this shopper.
    let verifiedPurchase = false;
    if (input.orderItemId) {
      const orderItem = await this.prisma.orderItem.findFirst({
        where: {
          id: input.orderItemId,
          skuId: input.skuId,
          order: { userId },
          subOrder: { status: { in: ['DELIVERED', 'COMPLETED'] } },
        },
        select: { id: true },
      });
      verifiedPurchase = Boolean(orderItem);
      if (!orderItem) {
        throw AppError.validation('This order item is not eligible for fit feedback yet');
      }
    }

    const record = await this.prisma.fitFeedback.upsert({
      where: {
        userId_skuId_orderItemId: {
          userId,
          skuId: input.skuId,
          orderItemId: input.orderItemId ?? '',
        },
      },
      create: {
        userId,
        skuId: input.skuId,
        orderItemId: input.orderItemId ?? null,
        overall: input.overall,
        length: input.length ?? null,
        width: input.width ?? null,
        comfort: clampComfort(input.comfort),
        comment: input.comment?.slice(0, 1000) ?? null,
        verifiedPurchase,
      },
      update: {
        overall: input.overall,
        length: input.length ?? null,
        width: input.width ?? null,
        comfort: clampComfort(input.comfort),
        comment: input.comment?.slice(0, 1000) ?? null,
        verifiedPurchase,
      },
    });

    return { id: record.id, verifiedPurchase };
  }

  /** Fit signal shown on the PDP ("runs small, say shoppers"). */
  async publicFitSignal(productId: string): Promise<{
    verdict: 'runs_small' | 'true_to_size' | 'runs_large' | 'unknown';
    sampleSize: number;
    shares: { small: number; true: number; large: number };
  }> {
    const skus = await this.prisma.sku.findMany({ where: { productId }, select: { id: true } });
    const aggregate = await this.aggregateFeedback(skus.map((sku) => sku.id));
    if (!aggregate || aggregate.sampleSize < 5) {
      return { verdict: 'unknown', sampleSize: aggregate?.sampleSize ?? 0, shares: { small: 0, true: 0, large: 0 } };
    }
    const total = aggregate.runsSmall + aggregate.runsTrue + aggregate.runsLarge;
    const shares = {
      small: Math.round((aggregate.runsSmall / total) * 100),
      true: Math.round((aggregate.runsTrue / total) * 100),
      large: Math.round((aggregate.runsLarge / total) * 100),
    };
    const verdict =
      shares.small >= 50 ? 'runs_small' : shares.large >= 50 ? 'runs_large' : shares.true >= 60 ? 'true_to_size' : 'unknown';
    return { verdict, sampleSize: aggregate.sampleSize, shares };
  }
}

function mergeAggregates(items: FitFeedbackAggregate[]): FitFeedbackAggregate | null {
  if (items.length === 0) return null;
  return items.reduce(
    (acc, item) => ({
      runsSmall: acc.runsSmall + item.runsSmall,
      runsTrue: acc.runsTrue + item.runsTrue,
      runsLarge: acc.runsLarge + item.runsLarge,
      sampleSize: acc.sampleSize + item.sampleSize,
    }),
    { runsSmall: 0, runsTrue: 0, runsLarge: 0, sampleSize: 0 },
  );
}

function clampComfort(value: number | null | undefined): number | null {
  if (value == null) return null;
  return Math.max(1, Math.min(5, Math.round(value)));
}
