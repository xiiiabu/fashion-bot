/**
 * Delivery options and estimates — spec §9.
 *
 * FUL-001 Methods are configurable per seller and zone; checkout shows only
 *         what is actually available for the chosen address.
 * FUL-002 ETA = seller handling + cut-off + carrier SLA + zone, presented as a
 *         range. No false precision, which is why nothing here returns a
 *         single "arrives Tuesday" date.
 * FUL-005 The return policy is resolved before payment and snapshotted.
 */

import { Injectable } from '@nestjs/common';
import type { DeliveryEstimate, Locale, ReturnPolicySnapshot } from '@fashion/core';
import { pickLocalized } from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { toMoney } from '../common/money.util';

export interface AddressForDelivery {
  readonly city: string;
  readonly district?: string | null;
}

@Injectable()
export class DeliveryService {
  private readonly config = loadConfig();

  constructor(private readonly prisma: PrismaService) {}

  /** Zones whose city matches, preferring one that also lists the district. */
  async resolveZoneId(address: AddressForDelivery | null): Promise<string | null> {
    if (!address) return null;
    const zones = await this.prisma.deliveryZone.findMany({
      where: { isActive: true, city: { equals: address.city, mode: 'insensitive' } },
      orderBy: { sortOrder: 'asc' },
    });
    if (zones.length === 0) return null;
    if (address.district) {
      const specific = zones.find((zone) =>
        zone.districts.some((district) => district.toLowerCase() === address.district!.toLowerCase()),
      );
      if (specific) return specific.id;
    }
    // A zone with no district list is the city-wide fallback.
    return (zones.find((zone) => zone.districts.length === 0) ?? zones[0]!).id;
  }

  /**
   * FUL-001/FUL-002: the methods a seller can actually serve, with a range.
   * `goodsTotalMinor` is needed because a method may be free over a threshold.
   */
  async optionsForSeller(
    sellerId: string,
    options: {
      locale: Locale;
      zoneId?: string | null;
      goodsTotalMinor?: bigint;
    },
  ): Promise<DeliveryEstimate[]> {
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { handlingDays: true, cutoffLocalTime: true, currency: true },
    });
    if (!seller) return [];

    const methods = await this.prisma.sellerDeliveryMethod.findMany({
      where: {
        sellerId,
        isActive: true,
        OR: [{ zoneId: options.zoneId ?? undefined }, { zoneId: null }],
      },
      include: { zone: true },
      orderBy: [{ priceMinor: 'asc' }, { minDays: 'asc' }],
    });

    // A zone-specific method wins over the generic one with the same code.
    const byCode = new Map<string, (typeof methods)[number]>();
    for (const method of methods) {
      const existing = byCode.get(method.code);
      if (!existing || (method.zoneId && !existing.zoneId)) byCode.set(method.code, method);
    }

    const handling = seller.handlingDays;
    return [...byCode.values()].map((method) => {
      const free =
        method.freeOverMinor != null &&
        options.goodsTotalMinor != null &&
        options.goodsTotalMinor >= method.freeOverMinor;
      return {
        methodCode: method.code,
        name: pickLocalized(
          { ru: method.nameRu, uz: method.nameUz, en: method.nameEn },
          options.locale,
        ),
        price: toMoney(free ? 0n : method.priceMinor, method.currency),
        // Store pickup needs no courier leg, so handling alone drives it.
        minDays: method.kind === 'STORE_PICKUP' ? handling : handling + method.minDays,
        maxDays: method.kind === 'STORE_PICKUP' ? handling + 1 : handling + method.maxDays,
        cutoffLocalTime: seller.cutoffLocalTime,
        zoneName: method.zone
          ? pickLocalized(
              { ru: method.zone.nameRu, uz: method.zone.nameUz, en: method.zone.nameEn },
              options.locale,
            )
          : null,
      };
    });
  }

  /** The PDP estimate: the fastest option the seller offers, Tashkent default. */
  async estimateForProduct(
    sellerId: string,
    locale: Locale,
    address: AddressForDelivery | null = null,
  ): Promise<DeliveryEstimate[]> {
    const zoneId = await this.resolveZoneId(address ?? { city: 'Tashkent' });
    return this.optionsForSeller(sellerId, { locale, zoneId });
  }

  /**
   * FUL-002: a cut-off crossed today pushes the first handling day to tomorrow.
   * Returned as real dates only for an already-dispatched shipment, where the
   * carrier has committed; before that the UI shows the day range.
   */
  windowFromNow(minDays: number, maxDays: number, cutoffLocalTime: string | null): { from: Date; to: Date } {
    const now = new Date();
    let offset = 0;
    if (cutoffLocalTime) {
      const [hoursRaw, minutesRaw] = cutoffLocalTime.split(':');
      const cutoffHour = Number.parseInt(hoursRaw ?? '15', 10);
      const cutoffMinute = Number.parseInt(minutesRaw ?? '0', 10);
      // Asia/Tashkent is UTC+5 with no DST, so the offset is a constant.
      const tashkentHour = (now.getUTCHours() + 5) % 24;
      const tashkentMinute = now.getUTCMinutes();
      if (tashkentHour > cutoffHour || (tashkentHour === cutoffHour && tashkentMinute >= cutoffMinute)) {
        offset = 1;
      }
    }
    const from = new Date(now.getTime() + (minDays + offset) * 86_400_000);
    const to = new Date(now.getTime() + (maxDays + offset) * 86_400_000);
    return { from, to };
  }

  /** FUL-005: the policy that applies to a product, resolved most-specific first. */
  async returnPolicyForProduct(
    productId: string,
    locale: Locale,
  ): Promise<ReturnPolicySnapshot> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        sellerId: true,
        category: { select: { slug: true } },
        returnPolicy: true,
      },
    });

    let policy = product?.returnPolicy ?? null;
    if (!policy && product) {
      policy =
        (await this.prisma.returnPolicy.findFirst({
          where: { sellerId: product.sellerId },
          orderBy: { version: 'desc' },
        })) ??
        (await this.prisma.returnPolicy.findFirst({ where: { isDefault: true } }));
    }

    if (!policy) {
      return {
        windowDays: this.config.RETURN_WINDOW_DAYS,
        conditions: '',
        whoPaysReturn: 'BUYER',
        nonReturnableReasons: [],
      };
    }

    const categorySlug = product?.category.slug;
    const categoryExcluded =
      categorySlug != null && policy.nonReturnableCategories.includes(categorySlug);

    return {
      windowDays: categoryExcluded ? 0 : policy.windowDays,
      conditions: pickLocalized(
        { ru: policy.conditionsRu, uz: policy.conditionsUz, en: policy.conditionsEn },
        locale,
      ),
      whoPaysReturn: policy.whoPaysReturn as ReturnPolicySnapshot['whoPaysReturn'],
      nonReturnableReasons: policy.nonReturnableReasons,
    };
  }

  /** The snapshot stored on the order (ORD-004 / FUL-005). */
  async policySnapshotForOrder(
    productIds: string[],
    locale: Locale,
  ): Promise<ReturnPolicySnapshot> {
    const policies = await Promise.all(
      productIds.map((productId) => this.returnPolicyForProduct(productId, locale)),
    );
    if (policies.length === 0) {
      return {
        windowDays: this.config.RETURN_WINDOW_DAYS,
        conditions: '',
        whoPaysReturn: 'BUYER',
        nonReturnableReasons: [],
      };
    }
    // The order-level summary is the strictest window across its items; each
    // item keeps its own policy on the OrderItem for the actual eligibility check.
    const windowDays = Math.min(...policies.map((policy) => policy.windowDays));
    return {
      windowDays,
      conditions: policies[0]!.conditions,
      whoPaysReturn: policies[0]!.whoPaysReturn,
      nonReturnableReasons: [...new Set(policies.flatMap((policy) => policy.nonReturnableReasons))],
    };
  }

  async listZones(locale: Locale) {
    const zones = await this.prisma.deliveryZone.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return zones.map((zone) => ({
      id: zone.id,
      code: zone.code,
      name: pickLocalized({ ru: zone.nameRu, uz: zone.nameUz, en: zone.nameEn }, locale),
      city: zone.city,
      districts: zone.districts,
    }));
  }
}
