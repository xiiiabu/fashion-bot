/**
 * Commission rule resolution — spec PAY-007.
 *
 * "CommissionRule versioned: default 10%, overrides по seller/category/period.
 *  История хранит rate и rule ID."
 *
 * The resolved rule is snapshotted onto the OrderItem at order time, so a
 * later rate change never rewrites history (ORD-004), and a refund reverses
 * the rate that was actually applied.
 */

import { Injectable } from '@nestjs/common';
import {
  type CommissionRuleSnapshot,
  DEFAULT_COMMISSION_RULE,
  type RoundingMode,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { logger } from '../common/logger';

export interface RuleLookup {
  readonly sellerId: string;
  readonly categoryId: string;
  readonly at?: Date;
}

interface ResolvedRule {
  readonly ruleId: string;
  readonly snapshot: CommissionRuleSnapshot;
}

@Injectable()
export class CommissionRuleService {
  private readonly config = loadConfig();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Specificity order, most specific first:
   *   seller + category -> seller -> category -> platform default.
   * Only rules in force at `at` are considered, so a scheduled rate change
   * applies from its own effective date and not retroactively.
   */
  async resolve(lookup: RuleLookup): Promise<ResolvedRule> {
    const at = lookup.at ?? new Date();

    const candidates = await this.prisma.commissionRule.findMany({
      where: {
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
        AND: [
          {
            OR: [
              { sellerId: lookup.sellerId, categoryId: lookup.categoryId },
              { sellerId: lookup.sellerId, categoryId: null },
              { sellerId: null, categoryId: lookup.categoryId },
              { sellerId: null, categoryId: null, isDefault: true },
            ],
          },
        ],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });

    const pick =
      candidates.find((rule) => rule.sellerId === lookup.sellerId && rule.categoryId === lookup.categoryId) ??
      candidates.find((rule) => rule.sellerId === lookup.sellerId && rule.categoryId === null) ??
      candidates.find((rule) => rule.sellerId === null && rule.categoryId === lookup.categoryId) ??
      candidates.find((rule) => rule.isDefault);

    if (!pick) {
      // A deployment with no seeded rule still charges the contractual 10%
      // rather than zero, and says so loudly.
      logger.warn({ lookup }, 'no CommissionRule matched — falling back to configured default');
      return {
        ruleId: 'config-default',
        snapshot: {
          ...DEFAULT_COMMISSION_RULE,
          rateBps: this.config.DEFAULT_COMMISSION_BPS,
          includesDelivery: this.config.COMMISSION_INCLUDES_DELIVERY,
        },
      };
    }

    return {
      ruleId: pick.id,
      snapshot: {
        ruleId: pick.id,
        version: pick.version,
        rateBps: pick.rateBps,
        includesDelivery: pick.includesDelivery,
        sellerDiscountReducesBase: pick.sellerDiscountReducesBase,
        platformDiscountReducesBase: pick.platformDiscountReducesBase,
        rounding: pick.rounding as RoundingMode,
        minFeeMinor: pick.minFeeMinor?.toString() ?? null,
        maxFeeMinor: pick.maxFeeMinor?.toString() ?? null,
      },
    };
  }

  /** Batch resolve for a multi-seller cart, one query per distinct pair. */
  async resolveMany(lookups: RuleLookup[]): Promise<Map<string, ResolvedRule>> {
    const out = new Map<string, ResolvedRule>();
    const seen = new Set<string>();
    for (const lookup of lookups) {
      const key = `${lookup.sellerId}:${lookup.categoryId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.set(key, await this.resolve(lookup));
    }
    return out;
  }

  static key(sellerId: string, categoryId: string): string {
    return `${sellerId}:${categoryId}`;
  }

  /** The platform default, for the admin dashboard and the seller statement. */
  async defaultRule(): Promise<ResolvedRule> {
    return this.resolve({ sellerId: '00000000-0000-0000-0000-000000000000', categoryId: '00000000-0000-0000-0000-000000000000' });
  }

  /**
   * PAY-007: changing a rate creates a new version and closes the old one.
   * Never an in-place edit, so a past order stays explainable.
   */
  async createVersion(
    input: {
      code: string;
      sellerId?: string | null;
      categoryId?: string | null;
      rateBps: number;
      includesDelivery?: boolean;
      sellerDiscountReducesBase?: boolean;
      platformDiscountReducesBase?: boolean;
      rounding?: RoundingMode;
      minFeeMinor?: bigint | null;
      maxFeeMinor?: bigint | null;
      effectiveFrom?: Date;
      note?: string;
      isDefault?: boolean;
    },
    adminUserId: string,
  ) {
    const latest = await this.prisma.commissionRule.findFirst({
      where: { code: input.code },
      orderBy: { version: 'desc' },
    });
    const version = (latest?.version ?? 0) + 1;
    const effectiveFrom = input.effectiveFrom ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      if (latest && !latest.effectiveTo) {
        await tx.commissionRule.update({
          where: { id: latest.id },
          data: { effectiveTo: effectiveFrom },
        });
      }
      return tx.commissionRule.create({
        data: {
          code: input.code,
          version,
          sellerId: input.sellerId ?? null,
          categoryId: input.categoryId ?? null,
          rateBps: input.rateBps,
          includesDelivery: input.includesDelivery ?? false,
          sellerDiscountReducesBase: input.sellerDiscountReducesBase ?? true,
          platformDiscountReducesBase: input.platformDiscountReducesBase ?? false,
          rounding: input.rounding ?? 'HALF_UP',
          minFeeMinor: input.minFeeMinor ?? null,
          maxFeeMinor: input.maxFeeMinor ?? null,
          effectiveFrom,
          isDefault: input.isDefault ?? false,
          note: input.note ?? null,
          createdByAdminId: adminUserId,
        },
      });
    });
  }

  async history(code?: string) {
    return this.prisma.commissionRule.findMany({
      where: code ? { code } : undefined,
      orderBy: [{ code: 'asc' }, { version: 'desc' }],
      include: {
        seller: { select: { displayName: true } },
        category: { select: { slug: true, nameRu: true } },
      },
    });
  }
}
