/**
 * Returns — spec §9 (FUL-005 … FUL-008) and the J-05 journey.
 *
 * FUL-005 The policy shown before payment is snapshotted on the order and is
 *         the one applied later, even if the seller changes it since.
 * FUL-006 A request is per item and quantity with a reason, and eligibility is
 *         explained rather than silently refused.
 * FUL-007 requested -> approved/rejected -> handed over -> received ->
 *         inspected -> refunded, consistent for buyer, seller, support and
 *         finance (UAT-21).
 * FUL-008 Quality-issue evidence has retention and access control.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type ReturnStatus } from '@prisma/client';
import {
  type Locale,
  type Money,
  type ReturnPolicySnapshot,
  type ReturnRequestView,
  add,
  assertTransition,
  money,
  returnableStatus,
  translate,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { toMinor, toMoney } from '../common/money.util';
import { AuditService } from '../common/audit.service';
import type { AuthenticatedActor } from '../common/http';
import { InventoryService } from '../inventory/inventory.service';
import { OrdersService } from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../finance/ledger.service';

export type ReturnReason =
  | 'SIZE_TOO_SMALL'
  | 'SIZE_TOO_LARGE'
  | 'NOT_AS_DESCRIBED'
  | 'QUALITY_ISSUE'
  | 'WRONG_ITEM'
  | 'DAMAGED'
  | 'CHANGED_MIND'
  | 'LATE_DELIVERY'
  | 'OTHER';

/** Reasons that put the cost on the seller rather than the buyer. */
const SELLER_FAULT_REASONS: ReturnReason[] = [
  'NOT_AS_DESCRIBED',
  'QUALITY_ISSUE',
  'WRONG_ITEM',
  'DAMAGED',
];

/** FIT-005: size reasons are the dataset the fit model is built on. */
const SIZE_REASONS: ReturnReason[] = ['SIZE_TOO_SMALL', 'SIZE_TOO_LARGE'];

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly reasonCode:
    | 'OK'
    | 'ORDER_NOT_DELIVERED'
    | 'WINDOW_EXPIRED'
    | 'NON_RETURNABLE_CATEGORY'
    | 'ALREADY_RETURNED'
    | 'OPEN_REQUEST_EXISTS';
  readonly message: string;
  readonly windowDays: number;
  readonly policy: ReturnPolicySnapshot;
  readonly items: Array<{
    orderItemId: string;
    title: string;
    brandName: string;
    sizeLabel: string;
    imageUrl: string | null;
    maxQuantity: number;
    unitPrice: Money;
    returnableUntil: string | null;
    eligible: boolean;
    blockedReason: string | null;
  }>;
  readonly escalationHint: string | null;
}

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /** FUL-006: eligibility with an explanation, per item. */
  async eligibility(userId: string, orderId: string, locale: Locale): Promise<EligibilityResult> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { number: orderId }], userId },
      include: {
        items: true,
        returnRequests: { where: { status: { notIn: ['CANCELLED', 'REJECTED'] } }, include: { items: true } },
      },
    });
    if (!order) throw AppError.notFound('Order', orderId);

    const policy =
      (order.returnPolicySnapshot as unknown as ReturnPolicySnapshot) ??
      ({ windowDays: 0, conditions: '', whoPaysReturn: 'BUYER', nonReturnableReasons: [] } as ReturnPolicySnapshot);

    const alreadyRequested = new Map<string, number>();
    for (const request of order.returnRequests) {
      for (const item of request.items) {
        alreadyRequested.set(
          item.orderItemId,
          (alreadyRequested.get(item.orderItemId) ?? 0) + item.quantity,
        );
      }
    }

    const items = order.items.map((item) => {
      const requested = alreadyRequested.get(item.id) ?? 0;
      const maxQuantity = Math.max(
        0,
        item.quantity - item.refundedQuantity - item.cancelledQuantity - requested,
      );
      const windowOpen = item.returnableUntil != null && item.returnableUntil.getTime() > Date.now();
      const blocked = !windowOpen
        ? item.returnableUntil == null
          ? 'non_returnable'
          : 'window_expired'
        : maxQuantity <= 0
          ? 'already_returned'
          : null;

      return {
        orderItemId: item.id,
        title: item.productTitle,
        brandName: item.brandName,
        sizeLabel: item.sizeLabel,
        imageUrl: item.imageUrl,
        maxQuantity,
        unitPrice: toMoney(item.unitPriceMinor, item.currency),
        returnableUntil: item.returnableUntil?.toISOString() ?? null,
        eligible: blocked === null,
        blockedReason: blocked,
      };
    });

    const anyEligible = items.some((item) => item.eligible);

    if (!returnableStatus(order.status)) {
      return {
        eligible: false,
        reasonCode: 'ORDER_NOT_DELIVERED',
        message: RETURN_MESSAGES[locale].notDelivered,
        windowDays: policy.windowDays,
        policy,
        items,
        escalationHint: RETURN_MESSAGES[locale].escalation,
      };
    }
    if (!anyEligible) {
      const expired = items.every((item) => item.blockedReason === 'window_expired');
      return {
        eligible: false,
        reasonCode: expired ? 'WINDOW_EXPIRED' : 'ALREADY_RETURNED',
        message: expired ? RETURN_MESSAGES[locale].expired : RETURN_MESSAGES[locale].already,
        windowDays: policy.windowDays,
        policy,
        items,
        escalationHint: RETURN_MESSAGES[locale].escalation,
      };
    }

    return {
      eligible: true,
      reasonCode: 'OK',
      message: RETURN_MESSAGES[locale].ok,
      windowDays: policy.windowDays,
      policy,
      items,
      escalationHint: null,
    };
  }

  async create(
    userId: string,
    input: {
      orderId: string;
      items: Array<{ orderItemId: string; quantity: number; reason: ReturnReason }>;
      comment?: string;
    },
    locale: Locale,
  ): Promise<ReturnRequestView> {
    const eligibility = await this.eligibility(userId, input.orderId, locale);
    if (!eligibility.eligible) {
      throw AppError.conflict('CONFLICT', eligibility.message, {
        reasonCode: eligibility.reasonCode,
        escalation: eligibility.escalationHint,
      });
    }

    const byId = new Map(eligibility.items.map((item) => [item.orderItemId, item]));
    for (const line of input.items) {
      const candidate = byId.get(line.orderItemId);
      if (!candidate) throw AppError.notFound('OrderItem', line.orderItemId);
      if (!candidate.eligible) {
        throw AppError.conflict('CONFLICT', 'One of the items is not returnable', {
          orderItemId: line.orderItemId,
          blockedReason: candidate.blockedReason,
        });
      }
      if (line.quantity > candidate.maxQuantity) {
        throw AppError.validation('Return quantity exceeds what remains on this item', {
          orderItemId: line.orderItemId,
          max: candidate.maxQuantity,
        });
      }
    }

    const order = await this.prisma.order.findFirstOrThrow({
      where: { OR: [{ id: input.orderId }, { number: input.orderId }], userId },
      select: { id: true, number: true, currency: true, locale: true, subOrders: { select: { id: true } } },
    });

    // The refund preview gives the exact amounts, including the 10% reversal,
    // so the buyer sees the real figure at request time (not an estimate).
    const preview = await this.ledger.previewRefund(
      input.items.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
    );
    const byItem = new Map(preview.lines.map((line) => [line.orderItemId, line]));

    const count = await this.prisma.returnRequest.count();
    const number = `RT-${new Date().getUTCFullYear()}-${String(count + 1).padStart(5, '0')}`;

    const policy = eligibility.policy;
    const sellerFault = input.items.some((line) => SELLER_FAULT_REASONS.includes(line.reason));

    const created = await this.prisma.$transaction(async (tx) => {
      const request = await tx.returnRequest.create({
        data: {
          number,
          orderId: order.id,
          userId,
          subOrderId: order.subOrders.length === 1 ? order.subOrders[0]!.id : null,
          status: 'REQUESTED',
          reason: input.items[0]!.reason,
          comment: input.comment?.slice(0, 1000) ?? null,
          refundTotalMinor: toMinor(preview.totalGross),
          currency: order.currency,
          // FUL-005: the historical terms travel with the request.
          policySnapshot: policy as unknown as Prisma.InputJsonValue,
          dropOffInstructions:
            sellerFault || policy.whoPaysReturn !== 'BUYER'
              ? RETURN_MESSAGES[locale].pickupArranged
              : RETURN_MESSAGES[locale].dropOff,
        },
      });

      for (const line of input.items) {
        const amounts = byItem.get(line.orderItemId);
        await tx.returnItem.create({
          data: {
            returnRequestId: request.id,
            orderItemId: line.orderItemId,
            quantity: line.quantity,
            reason: line.reason,
            refundAmountMinor: amounts ? toMinor(amounts.gross) : 0n,
            currency: order.currency,
          },
        });
      }

      await tx.returnStatusHistory.create({
        data: {
          returnRequestId: request.id,
          fromStatus: null,
          toStatus: 'REQUESTED',
          actorType: 'USER',
          actorId: userId,
          note: input.comment?.slice(0, 200) ?? null,
        },
      });

      // The buyer-facing order status reflects that a return is in flight.
      for (const subOrder of order.subOrders) {
        await this.orders
          .transitionSubOrder(
            subOrder.id,
            'RETURN_IN_PROGRESS',
            { actorType: 'USER', actorId: userId, note: number },
            tx,
          )
          .catch(() => undefined);
      }

      return request;
    });

    logger.info({ returnId: created.id, number, orderNumber: order.number }, 'return requested');

    return this.getForUser(userId, created.id, locale);
  }

  async listForUser(userId: string, locale: Locale): Promise<ReturnRequestView[]> {
    const rows = await this.prisma.returnRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        order: { select: { number: true } },
        items: { include: { orderItem: true } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
    return rows.map((row) => this.mapView(row, locale));
  }

  async getForUser(userId: string, id: string, locale: Locale): Promise<ReturnRequestView> {
    const row = await this.prisma.returnRequest.findFirst({
      where: { OR: [{ id }, { number: id }], userId },
      include: {
        order: { select: { number: true } },
        items: { include: { orderItem: true } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!row) throw AppError.notFound('ReturnRequest', id);
    return this.mapView(row, locale);
  }

  private mapView(
    row: {
      id: string;
      number: string;
      orderId: string;
      status: ReturnStatus;
      createdAt: Date;
      refundTotalMinor: bigint;
      currency: string;
      dropOffInstructions: string | null;
      order: { number: string };
      items: Array<{
        orderItemId: string;
        quantity: number;
        reason: string;
        refundAmountMinor: bigint;
        currency: string;
        orderItem: { productTitle: string; sizeLabel: string; imageUrl: string | null };
      }>;
      statusHistory: Array<{ toStatus: string; createdAt: Date; note: string | null }>;
    },
    locale: Locale,
  ): ReturnRequestView {
    return {
      id: row.id,
      number: row.number,
      orderId: row.orderId,
      orderNumber: row.order.number,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      items: row.items.map((item) => ({
        orderItemId: item.orderItemId,
        title: item.orderItem.productTitle,
        sizeLabel: item.orderItem.sizeLabel,
        quantity: item.quantity,
        reason: item.reason,
        refundAmount: toMoney(item.refundAmountMinor, item.currency),
        imageUrl: item.orderItem.imageUrl,
      })),
      refundTotal: toMoney(row.refundTotalMinor, row.currency),
      timeline: row.statusHistory.map((entry) => ({
        status: entry.toStatus,
        at: entry.createdAt.toISOString(),
        note: entry.note ?? translate(locale, `return.status.${entry.toStatus}`),
      })),
      dropOffInstructions: row.dropOffInstructions,
    };
  }

  /** FUL-007: the one transition path, shared by buyer, seller and admin. */
  async transition(
    returnRequestId: string,
    to: ReturnStatus,
    context: {
      actorType: 'USER' | 'SELLER' | 'ADMIN' | 'SYSTEM';
      actorId?: string | null;
      note?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<ReturnStatus> {
    const client = tx ?? this.prisma;
    const request = await client.returnRequest.findUnique({
      where: { id: returnRequestId },
      select: { id: true, status: true },
    });
    if (!request) throw AppError.notFound('ReturnRequest', returnRequestId);
    if (request.status === to) return to;

    assertTransition('return', request.status, to);

    await client.returnRequest.update({
      where: { id: returnRequestId },
      data: {
        status: to,
        ...(to === 'APPROVED' ? { approvedAt: new Date() } : {}),
        ...(to === 'REJECTED' ? { rejectedReason: context.note ?? null } : {}),
        ...(to === 'HANDED_OVER' ? { handedOverAt: new Date() } : {}),
        ...(to === 'RECEIVED' ? { receivedAt: new Date() } : {}),
      },
    });

    await client.returnStatusHistory.create({
      data: {
        returnRequestId,
        fromStatus: request.status,
        toStatus: to,
        actorType: context.actorType,
        actorId: context.actorId ?? null,
        note: context.note ?? null,
      },
    });

    return to;
  }

  async markHandedOver(userId: string, id: string): Promise<{ status: ReturnStatus }> {
    const request = await this.prisma.returnRequest.findFirst({
      where: { OR: [{ id }, { number: id }], userId },
      select: { id: true, status: true },
    });
    if (!request) throw AppError.notFound('ReturnRequest', id);
    const status = await this.transition(request.id, 'HANDED_OVER', {
      actorType: 'USER',
      actorId: userId,
    });
    return { status };
  }

  async cancelByBuyer(userId: string, id: string): Promise<{ status: ReturnStatus }> {
    const request = await this.prisma.returnRequest.findFirst({
      where: { OR: [{ id }, { number: id }], userId },
      select: { id: true, status: true, orderId: true },
    });
    if (!request) throw AppError.notFound('ReturnRequest', id);
    const status = await this.transition(request.id, 'CANCELLED', {
      actorType: 'USER',
      actorId: userId,
      note: 'Cancelled by the buyer',
    });

    // The order goes back to delivered if nothing else is in flight.
    const openCount = await this.prisma.returnRequest.count({
      where: { orderId: request.orderId, status: { notIn: ['CANCELLED', 'REJECTED', 'REFUNDED'] } },
    });
    if (openCount === 0) {
      const subOrders = await this.prisma.subOrder.findMany({
        where: { orderId: request.orderId, status: 'RETURN_IN_PROGRESS' },
        select: { id: true },
      });
      for (const subOrder of subOrders) {
        await this.orders
          .transitionSubOrder(subOrder.id, 'DELIVERED', {
            actorType: 'SYSTEM',
            note: 'return cancelled',
          })
          .catch(() => undefined);
      }
    }
    return { status };
  }

  // ───────────────────────────────────────── seller / admin operations

  async queue(options: {
    sellerId?: string;
    status?: ReturnStatus[];
    limit?: number;
    offset?: number;
  }) {
    const where: Prisma.ReturnRequestWhereInput = {
      ...(options.sellerId ? { items: { some: { orderItem: { sellerId: options.sellerId } } } } : {}),
      ...(options.status ? { status: { in: options.status } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.returnRequest.count({ where }),
      this.prisma.returnRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(options.limit ?? 25, 100),
        skip: options.offset ?? 0,
        include: {
          order: { select: { number: true, placedAt: true } },
          items: { include: { orderItem: true } },
          inspections: { orderBy: { createdAt: 'desc' }, take: 1 },
          evidence: { select: { id: true, url: true, kind: true, scanStatus: true } },
        },
      }),
    ]);

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        number: row.number,
        orderNumber: row.order.number,
        status: row.status,
        reason: row.reason,
        comment: row.comment,
        refundTotal: toMoney(row.refundTotalMinor, row.currency),
        createdAt: row.createdAt.toISOString(),
        items: row.items.map((item) => ({
          orderItemId: item.orderItemId,
          title: item.orderItem.productTitle,
          brandName: item.orderItem.brandName,
          sizeLabel: item.orderItem.sizeLabel,
          quantity: item.quantity,
          reason: item.reason,
          refundAmount: toMoney(item.refundAmountMinor, item.currency),
          imageUrl: item.orderItem.imageUrl,
          skuId: item.orderItem.skuId,
          inspectionResult: item.inspectionResult,
          restocked: item.restocked,
        })),
        lastInspection: row.inspections[0]
          ? {
              outcome: row.inspections[0].outcome,
              classification: row.inspections[0].classification,
              note: row.inspections[0].note,
            }
          : null,
        // FUL-008: evidence is listed, but the URL is signed on access.
        evidenceCount: row.evidence.length,
      })),
    };
  }

  async decide(
    returnRequestId: string,
    decision: { approve: boolean; note?: string },
    actor: AuthenticatedActor,
  ): Promise<{ status: ReturnStatus }> {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id: returnRequestId },
      include: { order: { select: { id: true, number: true, userId: true, locale: true } } },
    });
    if (!request) throw AppError.notFound('ReturnRequest', returnRequestId);

    const status = await this.transition(returnRequestId, decision.approve ? 'APPROVED' : 'REJECTED', {
      actorType: actor.kind === 'seller' ? 'SELLER' : 'ADMIN',
      actorId: actor.sellerUserId ?? actor.adminUserId ?? null,
      note: decision.note ?? null,
    });

    await this.audit.record(actor, {
      action: decision.approve ? 'return.approve' : 'return.reject',
      objectType: 'ReturnRequest',
      objectId: returnRequestId,
      after: { note: decision.note },
      severity: 'NOTICE',
    });

    if (decision.approve) {
      await this.notifications
        .sendOrderNotification(request.order.userId, 'notify.return_approved', {
          orderNumber: request.order.number,
          orderId: request.order.id,
          locale: request.order.locale as Locale,
        })
        .catch(() => undefined);
    }

    return { status };
  }

  async markReceived(returnRequestId: string, actor: AuthenticatedActor): Promise<{ status: ReturnStatus }> {
    const status = await this.transition(returnRequestId, 'RECEIVED', {
      actorType: actor.kind === 'seller' ? 'SELLER' : 'ADMIN',
      actorId: actor.sellerUserId ?? actor.adminUserId ?? null,
    });
    return { status };
  }

  /**
   * FUL-007: inspection classifies the goods and decides restocking.
   * The refund itself is a separate finance action (PAY-009), so an inspection
   * can never move money on its own.
   */
  async inspect(
    returnRequestId: string,
    input: {
      items: Array<{ returnItemId: string; outcome: 'ACCEPTED' | 'REJECTED' | 'PARTIAL'; restock: boolean; note?: string }>;
      classification?: string;
      note?: string;
    },
    actor: AuthenticatedActor,
  ): Promise<{ status: ReturnStatus; refundableTotal: Money; restocked: number }> {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id: returnRequestId },
      include: { items: { include: { orderItem: true } } },
    });
    if (!request) throw AppError.notFound('ReturnRequest', returnRequestId);

    const currency = request.currency as Money['currency'];
    let refundable = zero(currency);
    let restocked = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const decision of input.items) {
        const item = request.items.find((candidate) => candidate.id === decision.returnItemId);
        if (!item) continue;

        await tx.returnItem.update({
          where: { id: item.id },
          data: { inspectionResult: decision.outcome, restocked: decision.restock },
        });

        if (decision.outcome !== 'REJECTED') {
          refundable = add(refundable, money(item.refundAmountMinor, currency));
        }
        if (decision.restock && decision.outcome === 'ACCEPTED') {
          await this.inventory.restockFromReturn(
            item.orderItem.skuId,
            item.quantity,
            request.number,
            tx,
          );
          restocked += item.quantity;
        }
      }

      await tx.inspection.create({
        data: {
          returnRequestId,
          inspectedBySellerUserId: actor.sellerUserId ?? null,
          inspectedByAdminId: actor.adminUserId ?? null,
          outcome: input.items.every((item) => item.outcome === 'ACCEPTED')
            ? 'ACCEPTED'
            : input.items.every((item) => item.outcome === 'REJECTED')
              ? 'REJECTED'
              : 'PARTIAL',
          classification: input.classification ?? null,
          note: input.note ?? null,
          restockDecision: restocked > 0 ? 'RESTOCKED' : 'NOT_RESTOCKED',
        },
      });

      await this.transition(
        returnRequestId,
        'INSPECTED',
        {
          actorType: actor.kind === 'seller' ? 'SELLER' : 'ADMIN',
          actorId: actor.sellerUserId ?? actor.adminUserId ?? null,
          note: input.note ?? null,
        },
        tx,
      );
    });

    await this.audit.record(actor, {
      action: 'return.inspect',
      objectType: 'ReturnRequest',
      objectId: returnRequestId,
      after: { refundable: refundable.amount, restocked, classification: input.classification },
      severity: 'NOTICE',
    });

    return { status: 'INSPECTED', refundableTotal: refundable, restocked };
  }

  /** Moves the request into the refund queue; finance does the money. */
  async markRefundPending(returnRequestId: string, actor: AuthenticatedActor) {
    const status = await this.transition(returnRequestId, 'REFUND_PENDING', {
      actorType: 'ADMIN',
      actorId: actor.adminUserId ?? null,
    });
    return { status };
  }

  /** FUL-008: evidence with a retention date and a scan status. */
  async attachEvidence(
    returnRequestId: string,
    userId: string,
    input: { url: string; kind?: 'IMAGE' | 'VIDEO'; bytes?: number },
  ): Promise<{ id: string; retentionUntil: string }> {
    const request = await this.prisma.returnRequest.findFirst({
      where: { id: returnRequestId, userId },
      select: { id: true },
    });
    if (!request) throw AppError.notFound('ReturnRequest', returnRequestId);

    const count = await this.prisma.returnEvidence.count({ where: { returnRequestId } });
    if (count >= 8) throw AppError.validation('At most 8 evidence files per return');

    // 180 days balances dispute windows against §15.2 retention limits; the
    // retention job deletes on this date.
    const retentionUntil = new Date(Date.now() + 180 * 86_400_000);
    const evidence = await this.prisma.returnEvidence.create({
      data: {
        returnRequestId,
        url: input.url,
        kind: input.kind ?? 'IMAGE',
        bytes: input.bytes ?? null,
        uploadedByUserId: userId,
        scanStatus: 'PENDING',
        retentionUntil,
      },
    });
    return { id: evidence.id, retentionUntil: retentionUntil.toISOString() };
  }

  /** FUL-008: the retention job. Files past their date are removed. */
  async purgeExpiredEvidence(): Promise<number> {
    const expired = await this.prisma.returnEvidence.findMany({
      where: { retentionUntil: { lt: new Date() } },
      select: { id: true },
      take: 500,
    });
    if (expired.length === 0) return 0;
    await this.prisma.returnEvidence.deleteMany({
      where: { id: { in: expired.map((row) => row.id) } },
    });
    logger.info({ count: expired.length }, 'purged expired return evidence');
    return expired.length;
  }

  /** The fit/returns analytics the spec calls the key size dataset. */
  async returnReasonStats(options: { sellerId?: string; from?: Date; to?: Date } = {}) {
    const where: Prisma.ReturnItemWhereInput = {
      ...(options.sellerId ? { orderItem: { sellerId: options.sellerId } } : {}),
      ...(options.from || options.to
        ? {
            returnRequest: {
              createdAt: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            },
          }
        : {}),
    };

    const groups = await this.prisma.returnItem.groupBy({
      by: ['reason'],
      where,
      _count: { _all: true },
      _sum: { quantity: true },
    });

    const total = groups.reduce((acc, group) => acc + (group._sum.quantity ?? 0), 0);
    return {
      total,
      bySizeReason: groups
        .filter((group) => SIZE_REASONS.includes(group.reason as ReturnReason))
        .reduce((acc, group) => acc + (group._sum.quantity ?? 0), 0),
      reasons: groups
        .map((group) => ({
          reason: group.reason,
          count: group._sum.quantity ?? 0,
          share: total > 0 ? Number((((group._sum.quantity ?? 0) / total) * 100).toFixed(1)) : 0,
          sellerFault: SELLER_FAULT_REASONS.includes(group.reason as ReturnReason),
        }))
        .sort((a, b) => b.count - a.count),
    };
  }
}

const RETURN_MESSAGES: Record<
  Locale,
  {
    ok: string;
    notDelivered: string;
    expired: string;
    already: string;
    escalation: string;
    dropOff: string;
    pickupArranged: string;
  }
> = {
  ru: {
    ok: 'Можно оформить возврат — выберите позиции и причину.',
    notDelivered: 'Возврат доступен после доставки заказа.',
    expired: 'Срок возврата по этому заказу истёк.',
    already: 'По этим позициям возврат уже оформлен.',
    escalation: 'Если ситуация особая, напишите в поддержку — разберёмся вручную.',
    dropOff: 'Упакуйте товар с ярлыками и передайте курьеру при заборе.',
    pickupArranged: 'Забор организуем мы — курьер приедет по адресу доставки.',
  },
  uz: {
    ok: 'Qaytarishni rasmiylashtirish mumkin — buyumlar va sababni tanlang.',
    notDelivered: 'Qaytarish buyurtma yetkazilgandan keyin mumkin.',
    expired: 'Bu buyurtma bo‘yicha qaytarish muddati tugagan.',
    already: 'Bu buyumlar bo‘yicha qaytarish allaqachon rasmiylashtirilgan.',
    escalation: 'Holat alohida bo‘lsa, qo‘llab-quvvatlashga yozing — qo‘lda ko‘rib chiqamiz.',
    dropOff: 'Buyumni yorliqlari bilan joylab, kuryerga topshiring.',
    pickupArranged: 'Olib ketishni biz tashkil qilamiz — kuryer yetkazish manziliga keladi.',
  },
  en: {
    ok: 'You can open a return — pick the items and a reason.',
    notDelivered: 'Returns open once the order is delivered.',
    expired: 'The return window for this order has closed.',
    already: 'A return already covers these items.',
    escalation: 'If your case is unusual, message support and we will look at it by hand.',
    dropOff: 'Pack the item with its tags and hand it to the courier at pickup.',
    pickupArranged: 'We arrange the pickup — a courier comes to your delivery address.',
  },
};
