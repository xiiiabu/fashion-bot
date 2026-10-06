/**
 * Append-only ledger — spec PAY-006, PAY-008, PAY-009, PAY-015, PAY-017.
 *
 * Every amount in the platform traces to an OrderItem, a seller, a provider
 * transaction, a refund or a payout. Nothing is ever updated: a correction is
 * a new ADJUSTMENT entry with a reason and an approval.
 *
 * `dedupeKey` is what makes UAT-10 pass — a duplicated provider callback
 * cannot post a second set of sale entries, because the unique constraint
 * rejects the same economic event twice.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type LedgerAccountKind, type LedgerEvent } from '@prisma/client';
import {
  type CommissionRuleSnapshot,
  type Money,
  LEDGER_EVENT_META,
  add,
  buildRefundEntries,
  buildSaleEntries,
  computeItemCommission,
  computeRefundReversal,
  money,
  signedAmount,
  subtract,
  toBigInt,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { toMinor, toMoney } from '../common/money.util';
import type { AuthenticatedActor } from '../common/http';
import { AuditService } from '../common/audit.service';

type Tx = Prisma.TransactionClient;

export interface PostEntryInput {
  readonly event: LedgerEvent;
  readonly amount: Money;
  readonly sellerId?: string | null;
  readonly orderId?: string | null;
  readonly orderItemId?: string | null;
  readonly paymentId?: string | null;
  readonly refundId?: string | null;
  readonly payoutBatchId?: string | null;
  readonly adjustmentId?: string | null;
  readonly commissionRuleId?: string | null;
  readonly memo?: string | null;
  readonly correlationId?: string | null;
  /** Unique per economic event; a repeat is silently ignored. */
  readonly dedupeKey?: string | null;
}

export interface SellerBalance {
  readonly sellerId: string;
  readonly currency: string;
  readonly salesGross: Money;
  readonly commission: Money;
  readonly discountsSellerFunded: Money;
  readonly refunds: Money;
  readonly commissionReversals: Money;
  readonly adjustments: Money;
  readonly paidOut: Money;
  /** What the platform owes the seller right now. */
  readonly payableBalance: Money;
  readonly hold: Money;
  readonly reserve: Money;
  readonly availableForPayout: Money;
}

@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Accounts are created lazily; the unique index keeps them singular. */
  async ensureAccount(
    kind: LedgerAccountKind,
    sellerId: string | null,
    currency: string,
    tx?: Tx,
  ): Promise<string> {
    const client = tx ?? this.prisma;
    const existing = await client.ledgerAccount.findFirst({ where: { kind, sellerId, currency } });
    if (existing) return existing.id;
    const created = await client.ledgerAccount.create({ data: { kind, sellerId, currency } });
    return created.id;
  }

  /**
   * PAY-008: the single write path. The cached account balance is advanced in
   * the same transaction, but the authority remains the entry stream — see
   * `recomputeAccountBalances`.
   */
  async post(input: PostEntryInput, tx?: Tx): Promise<string | null> {
    const client = tx ?? this.prisma;
    const meta = LEDGER_EVENT_META[input.event];
    const currency = input.amount.currency;
    const magnitude = toBigInt(input.amount);
    if (magnitude === 0n) return null;

    const accountSellerId = meta.account === 'SELLER_PAYABLE' ? (input.sellerId ?? null) : null;
    const accountId = await this.ensureAccount(meta.account, accountSellerId, currency, client);
    const signed = signedAmount(input.event, input.amount);

    try {
      const entry = await client.ledgerEntry.create({
        data: {
          accountId,
          event: input.event,
          amountMinor: magnitude < 0n ? -magnitude : magnitude,
          signedAmountMinor: toMinor(signed),
          currency,
          sellerId: input.sellerId ?? null,
          orderId: input.orderId ?? null,
          orderItemId: input.orderItemId ?? null,
          paymentId: input.paymentId ?? null,
          refundId: input.refundId ?? null,
          payoutBatchId: input.payoutBatchId ?? null,
          adjustmentId: input.adjustmentId ?? null,
          commissionRuleId: input.commissionRuleId ?? null,
          memo: input.memo ?? null,
          correlationId: input.correlationId ?? null,
          dedupeKey: input.dedupeKey ?? null,
        },
      });

      await client.ledgerAccount.update({
        where: { id: accountId },
        data: { balanceMinor: { increment: toMinor(signed) } },
      });

      return entry.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // UAT-10: a replayed callback lands here and changes nothing.
        logger.info({ dedupeKey: input.dedupeKey, event: input.event }, 'ledger entry already posted');
        return null;
      }
      throw error;
    }
  }

  /**
   * PAY-006: posted once per OrderItem when a payment is captured, so the sum
   * of item commissions equals the order commission by construction.
   */
  async postSaleForOrder(
    orderId: string,
    options: { paymentId: string; pspFeeMinor?: bigint; correlationId?: string | null },
    tx?: Tx,
  ): Promise<{ entries: number; commissionTotal: Money; payableTotal: Money }> {
    const client = tx ?? this.prisma;
    const order = await client.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw AppError.notFound('Order', orderId);

    const currency = order.currency as Money['currency'];
    let commissionTotal = zero(currency);
    let payableTotal = zero(currency);
    let count = 0;

    // PAY-015: the provider fee is its own entry, allocated across items by
    // value — it is never folded into the 10%.
    const totalGoods = order.items.reduce((acc, item) => acc + item.lineTotalMinor, 0n);
    const pspFee = options.pspFeeMinor ?? 0n;

    for (const item of order.items) {
      const buyerPaid = money(
        item.lineTotalMinor - item.sellerDiscountMinor - item.platformDiscountMinor,
        currency,
      );
      const itemPspFee =
        pspFee > 0n && totalGoods > 0n
          ? money((pspFee * item.lineTotalMinor) / totalGoods, currency)
          : zero(currency);

      const entries = buildSaleEntries({
        orderId: order.id,
        orderItemId: item.id,
        sellerId: item.sellerId,
        commissionRuleId: item.commissionRuleId ?? 'config-default',
        buyerPaidForGoods: buyerPaid,
        commission: money(item.commissionMinor, currency),
        sellerPayable: money(item.sellerPayableMinor, currency),
        sellerFundedDiscount: money(item.sellerDiscountMinor, currency),
        platformFundedDiscount: money(item.platformDiscountMinor, currency),
        pspFee: itemPspFee,
      });

      for (const entry of entries) {
        const posted = await this.post(
          {
            ...entry,
            paymentId: options.paymentId,
            commissionRuleId: item.commissionRuleId,
            correlationId: options.correlationId,
            // One key per (event, item, payment): idempotent by construction.
            dedupeKey: `sale:${options.paymentId}:${item.id}:${entry.event}`,
            memo: `${entry.event} for ${item.productTitle} (${item.sizeLabel})`,
          },
          client,
        );
        if (posted) count += 1;
      }

      commissionTotal = add(commissionTotal, money(item.commissionMinor, currency));
      payableTotal = add(payableTotal, money(item.sellerPayableMinor, currency));
    }

    logger.info(
      { orderId, entries: count, commission: commissionTotal.amount },
      'posted sale ledger entries',
    );
    return { entries: count, commissionTotal, payableTotal };
  }

  /**
   * PAY-009 / UAT-14: reverse exactly the refunded share of commission and
   * seller payable — no more, no less.
   */
  async postRefundEntries(
    refundId: string,
    options: { correlationId?: string | null } = {},
    tx?: Tx,
  ): Promise<{ entries: number; commissionReversal: Money }> {
    const client = tx ?? this.prisma;
    const refund = await client.refund.findUnique({
      where: { id: refundId },
      include: { items: { include: { orderItem: true } }, order: true },
    });
    if (!refund) throw AppError.notFound('Refund', refundId);

    const currency = refund.currency as Money['currency'];
    let commissionReversal = zero(currency);
    let count = 0;

    for (const line of refund.items) {
      const item = line.orderItem;
      const entries = buildRefundEntries({
        orderId: refund.orderId,
        orderItemId: item.id,
        sellerId: item.sellerId,
        refundId: refund.id,
        commissionRuleId: item.commissionRuleId ?? 'config-default',
        refundGross: money(line.grossMinor, currency),
        commissionReversal: money(line.commissionReversalMinor, currency),
        sellerPayableReversal: money(line.sellerPayableReversalMinor, currency),
      });

      for (const entry of entries) {
        const posted = await this.post(
          {
            ...entry,
            paymentId: refund.paymentId,
            commissionRuleId: item.commissionRuleId,
            correlationId: options.correlationId,
            dedupeKey: `refund:${refund.id}:${item.id}:${entry.event}`,
            memo: `${entry.event} for refund ${refund.number}`,
          },
          client,
        );
        if (posted) count += 1;
      }
      commissionReversal = add(commissionReversal, money(line.commissionReversalMinor, currency));
    }

    return { entries: count, commissionReversal };
  }

  /**
   * Compute the per-item reversal for a proposed refund without posting it.
   * The refund service uses this to build RefundItem rows, and the admin UI to
   * preview what the 10% reversal will be.
   */
  async previewRefund(
    lines: Array<{ orderItemId: string; quantity: number; grossOverrideMinor?: bigint | null }>,
  ): Promise<{
    lines: Array<{
      orderItemId: string;
      quantity: number;
      gross: Money;
      commissionReversal: Money;
      sellerPayableReversal: Money;
      sellerId: string;
      proportionBps: number;
    }>;
    totalGross: Money;
    totalCommissionReversal: Money;
  }> {
    const items = await this.prisma.orderItem.findMany({
      where: { id: { in: lines.map((line) => line.orderItemId) } },
    });
    const byId = new Map(items.map((item) => [item.id, item]));

    const out: Awaited<ReturnType<LedgerService['previewRefund']>>['lines'] = [];
    let totalGross = zero('UZS');
    let totalCommission = zero('UZS');

    for (const line of lines) {
      const item = byId.get(line.orderItemId);
      if (!item) throw AppError.notFound('OrderItem', line.orderItemId);

      const alreadyRefunded = item.refundedQuantity;
      const refundable = item.quantity - alreadyRefunded - item.cancelledQuantity;
      if (line.quantity > refundable) {
        throw AppError.validation('Refund quantity exceeds what remains on this item', {
          orderItemId: item.id,
          requested: line.quantity,
          refundable,
        });
      }

      const currency = item.currency as Money['currency'];
      const snapshot = (item.commissionRuleSnapshot as unknown as CommissionRuleSnapshot | null) ?? undefined;

      // Rebuild the original commission result from the snapshot, so the
      // reversal uses the rate that was actually charged (PAY-007).
      const original = computeItemCommission({
        unitPrice: money(item.unitPriceMinor, currency),
        quantity: item.quantity,
        sellerFundedDiscount: money(item.sellerDiscountMinor, currency),
        platformFundedDiscount: money(item.platformDiscountMinor, currency),
        deliveryAmount: money(item.deliveryAllocatedMinor, currency),
        rule: snapshot,
      });

      const reversal = computeRefundReversal({
        original,
        refundQuantity: line.quantity,
        originalQuantity: item.quantity,
        refundGrossOverride:
          line.grossOverrideMinor != null ? money(line.grossOverrideMinor, currency) : undefined,
      });

      out.push({
        orderItemId: item.id,
        quantity: line.quantity,
        gross: reversal.refundGross,
        commissionReversal: reversal.commissionReversal,
        sellerPayableReversal: reversal.sellerPayableReversal,
        sellerId: item.sellerId,
        proportionBps: reversal.proportionBps,
      });
      totalGross = add(totalGross, reversal.refundGross);
      totalCommission = add(totalCommission, reversal.commissionReversal);
    }

    return { lines: out, totalGross, totalCommissionReversal: totalCommission };
  }

  /**
   * PAY-008: the seller statement. Derived from entries so the number in the
   * cabinet and the number in the payout batch cannot diverge.
   */
  async sellerBalance(sellerId: string, currency = 'UZS'): Promise<SellerBalance> {
    const groups = await this.prisma.ledgerEntry.groupBy({
      by: ['event'],
      where: { sellerId, currency },
      _sum: { signedAmountMinor: true, amountMinor: true },
    });

    const byEvent = new Map(groups.map((group) => [group.event, group._sum]));
    const magnitude = (event: LedgerEvent): Money =>
      money(byEvent.get(event)?.amountMinor ?? 0n, currency as Money['currency']);

    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      select: { payoutHoldMinor: true, returnReserveBps: true },
    });

    const payableEntries = await this.prisma.ledgerEntry.aggregate({
      where: {
        sellerId,
        currency,
        event: {
          in: ['SELLER_PAYABLE', 'SELLER_PAYABLE_REVERSAL', 'DISCOUNT_SELLER', 'PAYOUT', 'ADJUSTMENT'],
        },
      },
      _sum: { signedAmountMinor: true },
    });

    const payableBalance = money(
      payableEntries._sum.signedAmountMinor ?? 0n,
      currency as Money['currency'],
    );
    const hold = money(seller?.payoutHoldMinor ?? 0n, currency as Money['currency']);

    // PAY-012: a return reserve withholds a share of the balance against
    // returns that have not been opened yet.
    const reserveBps = seller?.returnReserveBps ?? 0;
    const reserve =
      reserveBps > 0 && toBigInt(payableBalance) > 0n
        ? money((toBigInt(payableBalance) * BigInt(reserveBps)) / 10_000n, currency as Money['currency'])
        : zero(currency as Money['currency']);

    const available = subtract(subtract(payableBalance, hold), reserve);

    return {
      sellerId,
      currency,
      salesGross: magnitude('SALE_GROSS'),
      commission: magnitude('PLATFORM_COMMISSION'),
      discountsSellerFunded: magnitude('DISCOUNT_SELLER'),
      refunds: magnitude('REFUND_GROSS'),
      commissionReversals: magnitude('COMMISSION_REVERSAL'),
      adjustments: magnitude('ADJUSTMENT'),
      paidOut: magnitude('PAYOUT'),
      payableBalance,
      hold,
      reserve,
      availableForPayout: toBigInt(available) > 0n ? available : zero(currency as Money['currency']),
    };
  }

  /** Platform-side P&L view for the admin dashboard. */
  async platformTotals(options: { from?: Date; to?: Date } = {}) {
    const where: Prisma.LedgerEntryWhereInput = {
      ...(options.from || options.to
        ? {
            createdAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            },
          }
        : {}),
    };

    const groups = await this.prisma.ledgerEntry.groupBy({
      by: ['event'],
      where,
      _sum: { amountMinor: true },
      _count: { _all: true },
    });
    const byEvent = new Map(groups.map((group) => [group.event, group]));
    const magnitude = (event: LedgerEvent): Money => toMoney(byEvent.get(event)?._sum.amountMinor ?? 0n);

    const commission = magnitude('PLATFORM_COMMISSION');
    const reversals = magnitude('COMMISSION_REVERSAL');
    const netCommission = subtract(commission, reversals);
    const salesGross = magnitude('SALE_GROSS');
    const refunds = magnitude('REFUND_GROSS');
    const netSales = subtract(salesGross, refunds);

    return {
      salesGross,
      refunds,
      netSales,
      commission,
      commissionReversals: reversals,
      netCommission,
      platformDiscounts: magnitude('DISCOUNT_PLATFORM'),
      sellerDiscounts: magnitude('DISCOUNT_SELLER'),
      pspFees: magnitude('PSP_FEE'),
      payouts: magnitude('PAYOUT'),
      adjustments: magnitude('ADJUSTMENT'),
      /** The spec's "effective take rate", derived and clearly labelled. */
      effectiveTakeRateBps:
        toBigInt(netSales) === 0n
          ? 0
          : Number((toBigInt(netCommission) * 10_000n) / toBigInt(netSales)),
      entryCount: groups.reduce((acc, group) => acc + group._count._all, 0),
    };
  }

  /** PAY-017: a manual correction. Requires approval before it posts. */
  async createAdjustment(
    input: {
      sellerId: string;
      amount: Money;
      reason: string;
      category?: string;
      orderId?: string | null;
    },
    actor: AuthenticatedActor,
  ): Promise<{ id: string; number: string; status: string }> {
    if (!actor.adminUserId) throw AppError.forbidden('Only an admin may create an adjustment');
    if (input.reason.trim().length < 8) {
      throw AppError.validation('An adjustment needs a reason of at least 8 characters');
    }

    const count = await this.prisma.adjustment.count();
    const number = `ADJ-${new Date().getUTCFullYear()}-${String(count + 1).padStart(5, '0')}`;

    const adjustment = await this.prisma.adjustment.create({
      data: {
        number,
        sellerId: input.sellerId,
        amountMinor: toMinor(input.amount),
        currency: input.amount.currency,
        reason: input.reason,
        category: input.category ?? 'OTHER',
        orderId: input.orderId ?? null,
        status: 'PENDING',
        requestedByAdminId: actor.adminUserId,
      },
    });

    await this.audit.record(actor, {
      action: 'adjustment.create',
      objectType: 'Adjustment',
      objectId: adjustment.id,
      after: { amount: input.amount, reason: input.reason, sellerId: input.sellerId },
      reason: input.reason,
      severity: 'WARNING',
    });

    return { id: adjustment.id, number, status: adjustment.status };
  }

  /**
   * ADM-005 / UAT-18: a second approver is required, and the maker may not be
   * the checker.
   */
  async approveAdjustment(
    adjustmentId: string,
    actor: AuthenticatedActor,
    decision: { approve: boolean; note?: string },
  ): Promise<{ status: string; ledgerEntryId: string | null }> {
    if (!actor.adminUserId) throw AppError.forbidden('Only an admin may approve an adjustment');

    const adjustment = await this.prisma.adjustment.findUnique({ where: { id: adjustmentId } });
    if (!adjustment) throw AppError.notFound('Adjustment', adjustmentId);
    if (adjustment.status !== 'PENDING') {
      throw AppError.conflict('CONFLICT', 'This adjustment was already decided', {
        status: adjustment.status,
      });
    }
    if (adjustment.requestedByAdminId === actor.adminUserId) {
      throw AppError.forbidden('The maker of an adjustment cannot approve it (ADM-005)', {
        rule: 'maker_checker',
      });
    }

    if (!decision.approve) {
      await this.prisma.adjustment.update({
        where: { id: adjustmentId },
        data: {
          status: 'REJECTED',
          approvedByAdminId: actor.adminUserId,
          approvedAt: new Date(),
          rejectedReason: decision.note ?? null,
        },
      });
      await this.audit.record(actor, {
        action: 'adjustment.reject',
        objectType: 'Adjustment',
        objectId: adjustmentId,
        reason: decision.note,
        severity: 'WARNING',
      });
      return { status: 'REJECTED', ledgerEntryId: null };
    }

    const entryId = await this.prisma.$transaction(async (tx) => {
      await tx.adjustment.update({
        where: { id: adjustmentId },
        data: { status: 'APPROVED', approvedByAdminId: actor.adminUserId, approvedAt: new Date() },
      });
      return this.post(
        {
          event: 'ADJUSTMENT',
          amount: money(adjustment.amountMinor, adjustment.currency as Money['currency']),
          sellerId: adjustment.sellerId,
          orderId: adjustment.orderId,
          adjustmentId: adjustment.id,
          memo: `${adjustment.number}: ${adjustment.reason}`,
          dedupeKey: `adjustment:${adjustment.id}`,
        },
        tx,
      );
    });

    await this.audit.record(actor, {
      action: 'adjustment.approve',
      objectType: 'Adjustment',
      objectId: adjustmentId,
      after: { ledgerEntryId: entryId },
      severity: 'WARNING',
    });

    return { status: 'APPROVED', ledgerEntryId: entryId };
  }

  /** Drill-down to the OrderItem, which SEL-006 requires. */
  async entries(options: {
    sellerId?: string;
    orderId?: string;
    event?: LedgerEvent[];
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: Prisma.LedgerEntryWhereInput = {
      ...(options.sellerId ? { sellerId: options.sellerId } : {}),
      ...(options.orderId ? { orderId: options.orderId } : {}),
      ...(options.event ? { event: { in: options.event } } : {}),
      ...(options.from || options.to
        ? {
            createdAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.ledgerEntry.count({ where }),
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: { sequence: 'desc' },
        take: Math.min(options.limit ?? 50, 500),
        skip: options.offset ?? 0,
        include: {
          order: { select: { number: true } },
          orderItem: { select: { productTitle: true, sizeLabel: true, brandName: true } },
          seller: { select: { displayName: true } },
          commissionRule: { select: { code: true, version: true, rateBps: true } },
        },
      }),
    ]);

    return { total, rows };
  }

  /**
   * PAY-008 acceptance criterion: prove the balance is recoverable from the
   * entries. Run as a scheduled integrity check and from the admin panel.
   */
  async recomputeAccountBalances(): Promise<{
    checked: number;
    corrected: number;
    drifts: Array<{ accountId: string; cached: string; computed: string }>;
  }> {
    const accounts = await this.prisma.ledgerAccount.findMany();
    const drifts: Array<{ accountId: string; cached: string; computed: string }> = [];
    let corrected = 0;

    for (const account of accounts) {
      const aggregate = await this.prisma.ledgerEntry.aggregate({
        where: { accountId: account.id },
        _sum: { signedAmountMinor: true },
      });
      const computed = aggregate._sum.signedAmountMinor ?? 0n;
      if (computed !== account.balanceMinor) {
        drifts.push({
          accountId: account.id,
          cached: account.balanceMinor.toString(),
          computed: computed.toString(),
        });
        await this.prisma.ledgerAccount.update({
          where: { id: account.id },
          data: { balanceMinor: computed },
        });
        corrected += 1;
        logger.error(
          { accountId: account.id, cached: account.balanceMinor.toString(), computed: computed.toString() },
          'ledger account balance drifted from entry sum — corrected from entries',
        );
      }
    }

    return { checked: accounts.length, corrected, drifts };
  }

  /** ADM-012: an export with immutable ids and control totals. */
  async exportRows(options: { sellerId?: string; from: Date; to: Date }) {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        ...(options.sellerId ? { sellerId: options.sellerId } : {}),
        createdAt: { gte: options.from, lte: options.to },
      },
      orderBy: { sequence: 'asc' },
      include: {
        order: { select: { number: true } },
        orderItem: { select: { productTitle: true, sizeLabel: true } },
        seller: { select: { displayName: true, legalName: true } },
      },
    });

    const controlTotals = rows.reduce<Record<string, bigint>>((acc, row) => {
      acc[row.event] = (acc[row.event] ?? 0n) + row.amountMinor;
      return acc;
    }, {});

    return {
      rows: rows.map((row) => ({
        id: row.id,
        sequence: row.sequence.toString(),
        createdAt: row.createdAt.toISOString(),
        event: row.event,
        amountMinor: row.amountMinor.toString(),
        signedAmountMinor: row.signedAmountMinor.toString(),
        currency: row.currency,
        sellerId: row.sellerId,
        sellerName: row.seller?.displayName ?? null,
        orderNumber: row.order?.number ?? null,
        orderItemId: row.orderItemId,
        itemTitle: row.orderItem?.productTitle ?? null,
        itemSize: row.orderItem?.sizeLabel ?? null,
        memo: row.memo,
      })),
      controlTotals: Object.fromEntries(
        Object.entries(controlTotals).map(([event, amount]) => [event, amount.toString()]),
      ),
      rowCount: rows.length,
    };
  }
}
