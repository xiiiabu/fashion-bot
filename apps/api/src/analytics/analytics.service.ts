/**
 * Analytics — spec §12 (ANL-001 … ANL-005) and the dashboard in §10.
 *
 * ANL-001 One event taxonomy, versioned, carrying the consent state.
 * ANL-002 Operational analytics, product analytics and the finance source of
 *         truth are separate: this service never computes money the ledger
 *         should compute. The dashboard reads the ledger for money and this
 *         service for behaviour.
 * ANL-004 No PII in generic analytics; ids are pseudonymised here.
 * ANL-005 AI attribution, measured without double counting.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ANALYTICS_EVENTS,
  ANALYTICS_TAXONOMY_VERSION,
  type AnalyticsEventName,
  FORBIDDEN_EVENT_PROPERTIES,
  type Money,
  add,
  isAnalyticsEvent,
  money,
  subtract,
  toBigInt,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { sha256 } from '../common/crypto';
import { toMoney } from '../common/money.util';
import { LedgerService } from '../finance/ledger.service';
import { logger } from '../common/logger';

/** ANL-001: the event names the clients are allowed to send. */
/**
 * ANL-001: the taxonomy now lives in @fashion/core, so the Mini App, the bot
 * and the admin panel type their emitters against the same list rather than
 * each keeping a copy in step by hand. Re-exported here because this service
 * is where the rest of the API reaches for it.
 */
export const EVENT_TAXONOMY = ANALYTICS_EVENTS;

export type EventName = AnalyticsEventName;

export interface TrackInput {
  readonly name: string;
  readonly properties?: Record<string, unknown>;
  readonly userId?: string | null;
  readonly anonymousId?: string | null;
  readonly sessionRef?: string | null;
  readonly source?: string;
  readonly consentState?: Record<string, boolean>;
}

/** ANL-004: property keys that must never reach analytics. */
/**
 * ANL-004. The shared list is what every client is told to avoid; these are the
 * extras only the server ever sees, so they do not belong in a browser bundle.
 * Compared case-insensitively, because a client may send either camelCase or
 * snake_case.
 */
const FORBIDDEN_PROPERTIES = new Set(
  [...FORBIDDEN_EVENT_PROPERTIES, 'cardMask', 'ipHash', 'refreshToken', 'accessToken'].map((key) =>
    key.toLowerCase(),
  ),
);

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /** ANL-001/ANL-004: validate, pseudonymise, store. */
  async track(input: TrackInput): Promise<{ accepted: boolean; reason?: string }> {
    if (!isAnalyticsEvent(input.name)) {
      // An undocumented event is dropped rather than stored: the taxonomy is
      // the contract, and silent drift is what ANL-001 exists to prevent.
      logger.debug({ name: input.name }, 'analytics event outside the taxonomy was dropped');
      return { accepted: false, reason: 'unknown_event' };
    }

    const properties = sanitizeProperties(input.properties ?? {});

    await this.prisma.analyticsEvent.create({
      data: {
        name: input.name,
        version: ANALYTICS_TAXONOMY_VERSION,
        anonymousId: input.anonymousId?.slice(0, 64) ?? null,
        // ANL-004: a stable pseudonym, not the user id.
        userRef: input.userId ? pseudonymize(input.userId) : null,
        sessionRef: input.sessionRef?.slice(0, 64) ?? null,
        consentState: (input.consentState ?? {}) as Prisma.InputJsonValue,
        properties: properties as Prisma.InputJsonValue,
        source: input.source ?? 'miniapp',
      },
    });
    return { accepted: true };
  }

  async trackMany(events: TrackInput[]): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0;
    let rejected = 0;
    for (const event of events.slice(0, 50)) {
      const result = await this.track(event);
      if (result.accepted) accepted += 1;
      else rejected += 1;
    }
    return { accepted, rejected };
  }

  // ─────────────────────────────────────────── dashboard (§10 Dashboard)

  async dashboard(options: { from?: Date; to?: Date } = {}) {
    const to = options.to ?? new Date();
    const from = options.from ?? new Date(to.getTime() - 30 * 86_400_000);

    const [orders, ledger, funnel, aiStats, operations, payments, quality] = await Promise.all([
      this.orderTotals(from, to),
      // ANL-002: money comes from the ledger, never recomputed here.
      this.ledger.platformTotals({ from, to }),
      this.conversionFunnel(from, to),
      this.aiMetrics(from, to),
      this.operationalMetrics(from, to),
      this.paymentMetrics(from, to),
      this.qualityMetrics(from, to),
    ]);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      sales: orders,
      monetization: {
        commissionAccrued: ledger.commission,
        commissionReversed: ledger.commissionReversals,
        commissionNet: ledger.netCommission,
        // The spec is explicit that refunds, promos and contractual exceptions
        // explain the gap between the 10% rate and the effective take rate.
        effectiveTakeRatePercent: Number((ledger.effectiveTakeRateBps / 100).toFixed(2)),
        nominalRatePercent: 10,
        platformDiscounts: ledger.platformDiscounts,
        sellerDiscounts: ledger.sellerDiscounts,
        pspFees: ledger.pspFees,
        payouts: ledger.payouts,
      },
      conversion: funnel,
      ai: aiStats,
      operations,
      payments,
      quality,
    };
  }

  private async orderTotals(from: Date, to: Date) {
    const where: Prisma.OrderWhereInput = {
      paidAt: { gte: from, lte: to },
      status: { notIn: ['DRAFT', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_FAILED'] },
    };
    const [aggregate, items, sellers] = await Promise.all([
      this.prisma.order.aggregate({
        where,
        _sum: { grandTotalMinor: true, goodsTotalMinor: true, refundedTotalMinor: true },
        _count: { _all: true },
        _avg: { grandTotalMinor: true },
      }),
      this.prisma.orderItem.aggregate({ where: { order: where }, _sum: { quantity: true } }),
      this.prisma.subOrder.groupBy({ by: ['sellerId'], where: { order: where }, _count: { _all: true } }),
    ]);

    const paidOrders = aggregate._count._all;
    return {
      gmv: toMoney(aggregate._sum.grandTotalMinor ?? 0n),
      goods: toMoney(aggregate._sum.goodsTotalMinor ?? 0n),
      refunded: toMoney(aggregate._sum.refundedTotalMinor ?? 0n),
      paidOrders,
      averageOrderValue: toMoney(BigInt(Math.round(aggregate._avg.grandTotalMinor ?? 0))),
      itemsPerOrder:
        paidOrders > 0 ? Number(((items._sum.quantity ?? 0) / paidOrders).toFixed(2)) : 0,
      activeSellers: sellers.length,
    };
  }

  /** ANL-002: view → PDP → cart → checkout → paid, from product events. */
  private async conversionFunnel(from: Date, to: Date) {
    const where = { occurredAt: { gte: from, lte: to } };
    const [views, pdp, cart, checkout, paid] = await Promise.all([
      this.prisma.analyticsEvent.count({ where: { ...where, name: 'product_card_click' } }),
      this.prisma.analyticsEvent.count({ where: { ...where, name: 'product_view' } }),
      this.prisma.analyticsEvent.count({ where: { ...where, name: { in: ['add_to_cart', 'add_whole_look'] } } }),
      this.prisma.analyticsEvent.count({ where: { ...where, name: 'checkout_started' } }),
      this.prisma.order.count({
        where: { paidAt: { gte: from, lte: to } },
      }),
    ]);

    const rate = (numerator: number, denominator: number) =>
      denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;

    return {
      steps: [
        { step: 'card_click', count: views },
        { step: 'pdp_view', count: pdp },
        { step: 'add_to_cart', count: cart },
        { step: 'checkout_started', count: checkout },
        { step: 'paid', count: paid },
      ],
      rates: {
        cardToPdp: rate(pdp, views),
        pdpToCart: rate(cart, pdp),
        cartToCheckout: rate(checkout, cart),
        checkoutToPaid: rate(paid, checkout),
        overall: rate(paid, views),
      },
    };
  }

  /**
   * ANL-005: AI attribution. An order is counted once, and AI GMV counts only
   * the items that actually came from a look — so a mixed cart does not
   * inflate the AI number.
   */
  private async aiMetrics(from: Date, to: Date) {
    const [sessions, withCart, replacements, aiItems, allItems, aiOrders] = await Promise.all([
      this.prisma.outfitSession.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.outfitSession.count({
        where: { createdAt: { gte: from, lte: to }, addedToCartAt: { not: null } },
      }),
      this.prisma.outfitSession.aggregate({
        where: { createdAt: { gte: from, lte: to } },
        _sum: { replacements: true },
      }),
      this.prisma.orderItem.aggregate({
        where: { addedFromAi: true, order: { paidAt: { gte: from, lte: to } } },
        _sum: { lineTotalMinor: true, quantity: true },
        _count: { _all: true },
      }),
      this.prisma.orderItem.aggregate({
        where: { order: { paidAt: { gte: from, lte: to } } },
        _sum: { lineTotalMinor: true },
      }),
      this.prisma.order.count({
        where: { aiAttributed: true, paidAt: { gte: from, lte: to } },
      }),
    ]);

    const aiGmv = toMoney(aiItems._sum.lineTotalMinor ?? 0n);
    const totalGmv = toMoney(allItems._sum.lineTotalMinor ?? 0n);

    return {
      sessions,
      addWholeLookRate: sessions > 0 ? Number(((withCart / sessions) * 100).toFixed(1)) : 0,
      purchaseRate: sessions > 0 ? Number(((aiOrders / sessions) * 100).toFixed(1)) : 0,
      replacementsPerSession:
        sessions > 0 ? Number(((replacements._sum.replacements ?? 0) / sessions).toFixed(2)) : 0,
      aiOrders,
      aiItems: aiItems._sum.quantity ?? 0,
      aiGmv,
      aiGmvSharePercent:
        toBigInt(totalGmv) > 0n
          ? Number(((Number(toBigInt(aiGmv)) / Number(toBigInt(totalGmv))) * 100).toFixed(1))
          : 0,
    };
  }

  /** Operational metrics by seller — stock cancels, confirm time, SLA. */
  private async operationalMetrics(from: Date, to: Date) {
    const [stockRejections, confirmed, overdue, shipped, delivered, returns] = await Promise.all([
      this.prisma.subOrder.count({
        where: { createdAt: { gte: from, lte: to }, status: { in: ['REJECTED', 'PARTIALLY_CANCELLED'] } },
      }),
      this.prisma.subOrder.findMany({
        where: { confirmedAt: { gte: from, lte: to } },
        select: { createdAt: true, confirmedAt: true },
        take: 2000,
      }),
      this.prisma.subOrder.count({
        where: { status: 'PENDING_CONFIRMATION', confirmDueAt: { lt: new Date() } },
      }),
      this.prisma.subOrder.count({ where: { handedOverAt: { gte: from, lte: to } } }),
      this.prisma.subOrder.findMany({
        where: { deliveredAt: { gte: from, lte: to } },
        select: { handedOverAt: true, deliveredAt: true },
        take: 2000,
      }),
      this.prisma.returnRequest.count({ where: { createdAt: { gte: from, lte: to } } }),
    ]);

    const confirmHours = confirmed
      .filter((row) => row.confirmedAt)
      .map((row) => (row.confirmedAt!.getTime() - row.createdAt.getTime()) / 3_600_000);
    const deliveryDays = delivered
      .filter((row) => row.handedOverAt && row.deliveredAt)
      .map((row) => (row.deliveredAt!.getTime() - row.handedOverAt!.getTime()) / 86_400_000);

    const totalSubOrders = await this.prisma.subOrder.count({
      where: { createdAt: { gte: from, lte: to } },
    });

    return {
      stockRejections,
      stockRejectionRatePercent:
        totalSubOrders > 0 ? Number(((stockRejections / totalSubOrders) * 100).toFixed(1)) : 0,
      medianConfirmHours: median(confirmHours),
      overdueConfirmations: overdue,
      shippedSubOrders: shipped,
      medianDeliveryDays: median(deliveryDays),
      returnRequests: returns,
    };
  }

  private async paymentMetrics(from: Date, to: Date) {
    const [byStatus, unmatched, refundLatency] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['status', 'provider'],
        where: { createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      this.prisma.reconciliationRecord.count({
        where: {
          periodDate: { gte: from, lte: to },
          status: { in: ['UNMATCHED_INTERNAL', 'UNMATCHED_PROVIDER', 'AMOUNT_MISMATCH'] },
        },
      }),
      this.prisma.refund.findMany({
        where: { processedAt: { gte: from, lte: to } },
        select: { createdAt: true, processedAt: true },
        take: 1000,
      }),
    ]);

    const byProvider = new Map<string, { total: number; captured: number }>();
    for (const group of byStatus) {
      const entry = byProvider.get(group.provider) ?? { total: 0, captured: 0 };
      entry.total += group._count._all;
      if (group.status === 'CAPTURED' || group.status === 'PARTIALLY_REFUNDED' || group.status === 'REFUNDED') {
        entry.captured += group._count._all;
      }
      byProvider.set(group.provider, entry);
    }

    return {
      providers: [...byProvider.entries()].map(([provider, stats]) => ({
        provider,
        attempts: stats.total,
        captured: stats.captured,
        successRatePercent:
          stats.total > 0 ? Number(((stats.captured / stats.total) * 100).toFixed(1)) : 0,
      })),
      unmatchedRecords: unmatched,
      medianRefundHours: median(
        refundLatency
          .filter((row) => row.processedAt)
          .map((row) => (row.processedAt!.getTime() - row.createdAt.getTime()) / 3_600_000),
      ),
    };
  }

  /** Fit/return quality — the spec's "ключевой датасет для size model". */
  private async qualityMetrics(from: Date, to: Date) {
    const [feedback, returnReasons, reviews, lowConfidence] = await Promise.all([
      this.prisma.fitFeedback.groupBy({
        by: ['overall'],
        where: { createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      this.prisma.returnItem.groupBy({
        by: ['reason'],
        where: { returnRequest: { createdAt: { gte: from, lte: to } } },
        _count: { _all: true },
      }),
      this.prisma.review.aggregate({
        where: { createdAt: { gte: from, lte: to }, status: 'APPROVED' },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.orderItem.count({
        where: { order: { paidAt: { gte: from, lte: to } }, fitConfidence: { lt: 0.55 } },
      }),
    ]);

    const feedbackTotal = feedback.reduce((acc, group) => acc + group._count._all, 0);
    const feedbackBy = (value: string) =>
      feedback.find((group) => group.overall === value)?._count._all ?? 0;

    const returnTotal = returnReasons.reduce((acc, group) => acc + group._count._all, 0);
    const sizeReturns = returnReasons
      .filter((group) => group.reason === 'SIZE_TOO_SMALL' || group.reason === 'SIZE_TOO_LARGE')
      .reduce((acc, group) => acc + group._count._all, 0);

    return {
      fitFeedback: {
        total: feedbackTotal,
        runsSmall: feedbackBy('RUNS_SMALL'),
        trueToSize: feedbackBy('TRUE_TO_SIZE'),
        runsLarge: feedbackBy('RUNS_LARGE'),
        trueToSizePercent:
          feedbackTotal > 0 ? Number(((feedbackBy('TRUE_TO_SIZE') / feedbackTotal) * 100).toFixed(1)) : 0,
      },
      returns: {
        total: returnTotal,
        sizeRelated: sizeReturns,
        sizeSharePercent:
          returnTotal > 0 ? Number(((sizeReturns / returnTotal) * 100).toFixed(1)) : 0,
        byReason: returnReasons
          .map((group) => ({ reason: group.reason, count: group._count._all }))
          .sort((a, b) => b.count - a.count),
      },
      reviews: {
        count: reviews._count._all,
        average: Number((reviews._avg.rating ?? 0).toFixed(2)),
      },
      lowConfidenceFitPurchases: lowConfidence,
    };
  }

  /** Daily GMV series for the dashboard chart. */
  async dailySeries(days = 30): Promise<Array<{ date: string; gmv: Money; orders: number; commission: Money }>> {
    const from = new Date(Date.now() - days * 86_400_000);
    const orders = await this.prisma.order.findMany({
      where: { paidAt: { gte: from } },
      select: { paidAt: true, grandTotalMinor: true, commissionTotalMinor: true, currency: true },
    });

    const byDate = new Map<string, { gmv: Money; orders: number; commission: Money }>();
    for (const order of orders) {
      if (!order.paidAt) continue;
      const key = order.paidAt.toISOString().slice(0, 10);
      const entry =
        byDate.get(key) ?? { gmv: zero('UZS'), orders: 0, commission: zero('UZS') };
      byDate.set(key, {
        gmv: add(entry.gmv, money(order.grandTotalMinor, order.currency as 'UZS')),
        orders: entry.orders + 1,
        commission: add(entry.commission, money(order.commissionTotalMinor, order.currency as 'UZS')),
      });
    }

    // Fill the gaps so the chart has no holes.
    const out: Array<{ date: string; gmv: Money; orders: number; commission: Money }> = [];
    for (let index = days - 1; index >= 0; index -= 1) {
      const date = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10);
      const entry = byDate.get(date);
      out.push({
        date,
        gmv: entry?.gmv ?? zero('UZS'),
        orders: entry?.orders ?? 0,
        commission: entry?.commission ?? zero('UZS'),
      });
    }
    return out;
  }

  /** Top sellers by net payable, for the dashboard and seller scoring. */
  async topSellers(limit = 10) {
    const groups = await this.prisma.subOrder.groupBy({
      by: ['sellerId'],
      where: { order: { status: { notIn: ['DRAFT', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_FAILED'] } } },
      _sum: { goodsTotalMinor: true, commissionTotalMinor: true },
      _count: { _all: true },
      orderBy: { _sum: { goodsTotalMinor: 'desc' } },
      take: limit,
    });

    const sellers = await this.prisma.seller.findMany({
      where: { id: { in: groups.map((group) => group.sellerId) } },
      select: { id: true, displayName: true, qualityScore: true },
    });
    const byId = new Map(sellers.map((seller) => [seller.id, seller]));

    return groups.map((group) => ({
      sellerId: group.sellerId,
      name: byId.get(group.sellerId)?.displayName ?? group.sellerId,
      qualityScore: byId.get(group.sellerId)?.qualityScore ?? null,
      subOrders: group._count._all,
      goods: toMoney(group._sum.goodsTotalMinor ?? 0n),
      commission: toMoney(group._sum.commissionTotalMinor ?? 0n),
    }));
  }

  /**
   * SEL-010: a quality score from transparent operational metrics, so the
   * seller can see the factors rather than an opaque number.
   */
  async computeSellerQuality(sellerId: string): Promise<{
    score: number;
    factors: Array<{ factor: string; value: number; weight: number; note: string }>;
  }> {
    const since = new Date(Date.now() - 90 * 86_400_000);
    const [total, rejected, confirmed, late, returns, items] = await Promise.all([
      this.prisma.subOrder.count({ where: { sellerId, createdAt: { gte: since } } }),
      this.prisma.subOrder.count({
        where: { sellerId, createdAt: { gte: since }, status: { in: ['REJECTED', 'PARTIALLY_CANCELLED'] } },
      }),
      this.prisma.subOrder.findMany({
        where: { sellerId, confirmedAt: { gte: since } },
        select: { createdAt: true, confirmedAt: true, confirmDueAt: true },
        take: 1000,
      }),
      this.prisma.subOrder.count({
        where: { sellerId, createdAt: { gte: since }, confirmedAt: null, confirmDueAt: { lt: new Date() } },
      }),
      this.prisma.returnItem.count({
        where: { orderItem: { sellerId }, returnRequest: { createdAt: { gte: since } } },
      }),
      this.prisma.orderItem.aggregate({
        where: { sellerId, order: { paidAt: { gte: since } } },
        _sum: { quantity: true },
      }),
    ]);

    const soldUnits = items._sum.quantity ?? 0;
    const fulfilmentRate = total > 0 ? 1 - rejected / total : 1;
    const slaRate =
      confirmed.length > 0
        ? confirmed.filter((row) => !row.confirmDueAt || (row.confirmedAt && row.confirmedAt <= row.confirmDueAt))
            .length / confirmed.length
        : 1;
    const overdueRate = total > 0 ? 1 - late / total : 1;
    const returnRate = soldUnits > 0 ? Math.max(0, 1 - returns / soldUnits) : 1;

    const factors = [
      {
        factor: 'fulfilment',
        value: Number((fulfilmentRate * 100).toFixed(1)),
        weight: 0.35,
        note: `${rejected} of ${total} suborders rejected or partially cancelled`,
      },
      {
        factor: 'confirmation_sla',
        value: Number((slaRate * 100).toFixed(1)),
        weight: 0.25,
        note: `${confirmed.length} confirmations measured against the agreed SLA`,
      },
      {
        factor: 'no_overdue',
        value: Number((overdueRate * 100).toFixed(1)),
        weight: 0.2,
        note: `${late} suborders still unconfirmed past their due time`,
      },
      {
        factor: 'low_returns',
        value: Number((returnRate * 100).toFixed(1)),
        weight: 0.2,
        note: `${returns} returned units against ${soldUnits} sold`,
      },
    ];

    const score = Number(
      factors.reduce((acc, factor) => acc + (factor.value / 100) * factor.weight, 0).toFixed(4),
    );

    await this.prisma.seller.update({ where: { id: sellerId }, data: { qualityScore: score } });
    return { score, factors };
  }

  /** ANL-003: experiment exposure, recorded once per user. */
  async recordExposure(experimentKey: string, userId: string, variant: string): Promise<void> {
    const experiment = await this.prisma.experiment.findUnique({ where: { key: experimentKey } });
    if (!experiment || experiment.status !== 'RUNNING') return;
    await this.prisma.experimentExposure
      .create({ data: { experimentId: experiment.id, userRef: pseudonymize(userId), variant } })
      .catch(() => undefined);
  }

  /** ANL-003: an unexposed user must not appear in the analysis. */
  async experimentResults(experimentKey: string) {
    const experiment = await this.prisma.experiment.findUnique({
      where: { key: experimentKey },
      include: { exposures: true },
    });
    if (!experiment) return null;

    const byVariant = new Map<string, number>();
    for (const exposure of experiment.exposures) {
      byVariant.set(exposure.variant, (byVariant.get(exposure.variant) ?? 0) + 1);
    }
    return {
      key: experiment.key,
      name: experiment.name,
      hypothesis: experiment.hypothesis,
      status: experiment.status,
      startedAt: experiment.startedAt?.toISOString() ?? null,
      guardrails: experiment.guardrails,
      stopCriteria: experiment.stopCriteria,
      exposures: [...byVariant.entries()].map(([variant, count]) => ({ variant, count })),
      note: 'Only exposed users are counted (ANL-003).',
    };
  }

  /** Event volume by name, so the taxonomy can be reviewed. */
  async eventSummary(days = 7) {
    const from = new Date(Date.now() - days * 86_400_000);
    const groups = await this.prisma.analyticsEvent.groupBy({
      by: ['name'],
      where: { occurredAt: { gte: from } },
      _count: { _all: true },
      orderBy: { _count: { name: 'desc' } },
    });
    return groups.map((group) => ({
      name: group.name,
      count: group._count._all,
      documented: group.name in EVENT_TAXONOMY,
    }));
  }

  moneyDelta(a: Money, b: Money): Money {
    return subtract(a, b);
  }
}

/** ANL-004: a stable pseudonym that cannot be reversed to the user id. */
function pseudonymize(userId: string): string {
  return sha256(`analytics:${userId}`).slice(0, 32);
}

function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (FORBIDDEN_PROPERTIES.has(key.toLowerCase())) continue;
    if (typeof value === 'string' && value.length > 300) {
      out[key] = value.slice(0, 300);
      continue;
    }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 20).filter((item) => ['string', 'number', 'boolean'].includes(typeof item));
    }
    // Nested objects are dropped: they are how PII sneaks into event payloads.
  }
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return Number(value.toFixed(2));
}
