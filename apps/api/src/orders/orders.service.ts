/**
 * Orders — spec §7, §9 and the status model in §7.1.
 *
 * ORD-009 Post-payment changes depend on the state machine and seller policy.
 * ORD-010 Payment, order, suborder, shipment, return and refund statuses are
 *         separate; nothing is squashed into one ambiguous field.
 * ORD-011 Every transition goes through `transitionOrder` / `transitionSubOrder`,
 *         which validate against the machine and write OrderStatusHistory.
 * FUL-003 A suborder may have its own shipment while the buyer sees one order.
 * FUL-004 Seller confirm/reject within SLA; a stock rejection is recorded and
 *         automatically produces a refund obligation.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type OrderStatus, type SubOrderStatus } from '@prisma/client';
import {
  type AddressView,
  type Locale,
  type Money,
  type OrderItemView,
  type OrderView,
  type ReturnPolicySnapshot,
  type SubOrderView,
  add,
  assertTransition,
  buyerCanCancel,
  canTransition,
  deriveOrderStatus,
  multiply,
  orderPhase,
  returnableStatus,
  shortestPath,
  sum,
  translate,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { nullableMoney, toMoney } from '../common/money.util';
import { InventoryService } from '../inventory/inventory.service';
import type { AuthenticatedActor } from '../common/http';
import { AuditService } from '../common/audit.service';

/** ORD-004: the immutable address snapshot stored on the order. */
function mapAddressSnapshot(
  addressId: string | null,
  snapshot: unknown,
): AddressView | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = snapshot as Record<string, unknown>;
  const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '');
  const optional = (key: string): string | null =>
    typeof value[key] === 'string' && value[key] !== '' ? (value[key] as string) : null;

  return {
    id: addressId ?? '',
    label: text('label'),
    recipientName: text('recipientName'),
    phone: text('phone'),
    city: text('city'),
    district: optional('district'),
    street: text('street'),
    building: text('building'),
    apartment: optional('apartment'),
    landmark: optional('landmark'),
    postalCode: optional('postalCode'),
    isDefault: false,
    lat: typeof value.lat === 'number' ? value.lat : null,
    lng: typeof value.lng === 'number' ? value.lng : null,
  };
}

export interface TransitionContext {
  readonly actorType?: 'USER' | 'ADMIN' | 'SELLER' | 'SYSTEM' | 'PROVIDER';
  readonly actorId?: string | null;
  readonly note?: string | null;
  readonly correlationId?: string | null;
  /**
   * When the caller knows the *end state* rather than the next hop, walk the
   * shortest legal route instead of failing. Every intermediate step is still
   * validated and written to OrderStatusHistory, so ORD-011 holds; what stays
   * rejected is a target with no legal route at all.
   *
   * Used by the refund and sync paths (a return that is refunded goes
   * RETURN_REQUESTED -> REFUND_PENDING -> PARTIALLY_REFUNDED). Direct operator
   * actions leave it off, so an operator attempting an illegal move still
   * gets a 409 with the allowed transitions.
   */
  readonly viaPath?: boolean;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  /** Human-readable, sortable order number: FM-YYMMDD-XXXX. */
  async nextOrderNumber(): Promise<string> {
    const now = new Date();
    const datePart = [
      now.getUTCFullYear().toString().slice(-2),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
    ].join('');

    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayCount = await this.prisma.order.count({ where: { createdAt: { gte: startOfDay } } });
    // A collision is still possible under heavy concurrency, so the unique
    // constraint on `number` is the real guarantee; retry on conflict.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `FM-${datePart}-${String(todayCount + 1 + attempt).padStart(4, '0')}`;
      const existing = await this.prisma.order.findUnique({
        where: { number: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    return `FM-${datePart}-${Date.now().toString().slice(-6)}`;
  }

  // ─────────────────────────────────────────────────── buyer read model

  async listForUser(
    userId: string,
    locale: Locale,
    options: { limit?: number; offset?: number; status?: OrderStatus[] } = {},
  ): Promise<{ items: OrderView[]; total: number }> {
    const where: Prisma.OrderWhereInput = {
      userId,
      status: options.status ? { in: options.status } : { notIn: ['DRAFT', 'QUOTED'] },
    };
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(options.limit ?? 20, 50),
        skip: options.offset ?? 0,
        include: this.orderInclude(),
      }),
    ]);
    return { items: rows.map((row) => this.mapOrder(row, locale)), total };
  }

  async getForUser(userId: string, orderId: string, locale: Locale): Promise<OrderView> {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { number: orderId }], userId },
      include: this.orderInclude(),
    });
    if (!order) throw AppError.notFound('Order', orderId);
    return this.mapOrder(order, locale);
  }

  private orderInclude() {
    return {
      address: true,
      payments: { orderBy: { createdAt: 'desc' as const }, take: 1 },
      statusHistory: { orderBy: { createdAt: 'asc' as const } },
      fiscalReceipts: { take: 1, orderBy: { issuedAt: 'desc' as const } },
      subOrders: {
        orderBy: { number: 'asc' as const },
        include: {
          seller: { select: { id: true, displayName: true } },
          items: { orderBy: { createdAt: 'asc' as const } },
          shipments: { orderBy: { createdAt: 'desc' as const }, take: 1 },
        },
      },
    };
  }

  private mapOrder(
    order: Prisma.OrderGetPayload<{ include: ReturnType<OrdersService['orderInclude']> }>,
    locale: Locale,
  ): OrderView {
    const currency = order.currency as Money['currency'];
    const payment = order.payments[0] ?? null;

    const subOrders: SubOrderView[] = order.subOrders.map((subOrder) => {
      const shipment = subOrder.shipments[0] ?? null;
      const items: OrderItemView[] = subOrder.items.map((item) => this.mapItem(item, currency));
      const estimated =
        subOrder.estimatedMinDays != null && subOrder.estimatedMaxDays != null && order.paidAt
          ? {
              minDays: subOrder.estimatedMinDays,
              maxDays: subOrder.estimatedMaxDays,
              from: new Date(order.paidAt.getTime() + subOrder.estimatedMinDays * 86_400_000).toISOString(),
              to: new Date(order.paidAt.getTime() + subOrder.estimatedMaxDays * 86_400_000).toISOString(),
            }
          : null;

      return {
        id: subOrder.id,
        number: subOrder.number,
        sellerId: subOrder.sellerId,
        sellerName: subOrder.seller.displayName,
        status: subOrder.status,
        items,
        goodsTotal: toMoney(subOrder.goodsTotalMinor, currency),
        deliveryPrice: toMoney(subOrder.deliveryTotalMinor, currency),
        deliveryName: subOrder.deliveryMethodName ?? '',
        estimatedDelivery: estimated,
        shipment: shipment
          ? {
              id: shipment.id,
              status: shipment.status,
              carrier: shipment.carrier,
              trackingNumber: shipment.trackingNumber,
              trackingUrl: shipment.trackingUrl,
            }
          : null,
      };
    });

    const returnPolicy = (order.returnPolicySnapshot as unknown as ReturnPolicySnapshot) ?? {
      windowDays: 0,
      conditions: '',
      whoPaysReturn: 'BUYER' as const,
      nonReturnableReasons: [],
    };

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      phase: orderPhase(order.status),
      paymentStatus: payment?.status ?? 'CREATED',
      placedAt: (order.placedAt ?? order.createdAt).toISOString(),
      subOrders,
      goodsTotal: toMoney(order.goodsTotalMinor, currency),
      discountTotal: toMoney(order.discountTotalMinor, currency),
      deliveryTotal: toMoney(order.deliveryTotalMinor, currency),
      grandTotal: toMoney(order.grandTotalMinor, currency),
      refundedTotal: toMoney(order.refundedTotalMinor, currency),
      currency,
      // ORD-004: read from the snapshot, not the live address book, so the
      // order shows where it was actually sent.
      address: mapAddressSnapshot(order.addressId, order.addressSnapshot),
      returnPolicy,
      canCancel: buyerCanCancel(order.status),
      canReturn:
        returnableStatus(order.status) &&
        subOrders.some((subOrder) => subOrder.items.some((item) => item.returnable)),
      timeline: order.statusHistory
        .filter((entry) => entry.machine === 'order')
        .map((entry) => ({
          status: entry.toStatus,
          at: entry.createdAt.toISOString(),
          note: entry.note ?? translate(locale, `order.status.${entry.toStatus}`),
        })),
      fiscalReceiptUrl: order.fiscalReceipts[0]?.fiscalUrl ?? null,
    };
  }

  private mapItem(
    item: {
      id: string;
      skuId: string;
      productId: string;
      productTitle: string;
      brandName: string;
      sizeLabel: string;
      colorName: string;
      quantity: number;
      unitPriceMinor: bigint;
      lineTotalMinor: bigint;
      imageUrl: string | null;
      refundedQuantity: number;
      cancelledQuantity: number;
      returnableUntil: Date | null;
    },
    currency: Money['currency'],
  ): OrderItemView {
    const remaining = item.quantity - item.refundedQuantity - item.cancelledQuantity;
    return {
      id: item.id,
      skuId: item.skuId,
      productId: item.productId,
      title: item.productTitle,
      brandName: item.brandName,
      sizeLabel: item.sizeLabel,
      colorName: item.colorName,
      quantity: item.quantity,
      unitPrice: toMoney(item.unitPriceMinor, currency),
      lineTotal: toMoney(item.lineTotalMinor, currency),
      imageUrl: item.imageUrl,
      refundedQuantity: item.refundedQuantity,
      returnable:
        remaining > 0 && item.returnableUntil != null && item.returnableUntil.getTime() > Date.now(),
      returnableUntil: item.returnableUntil?.toISOString() ?? null,
    };
  }

  // ──────────────────────────────────────── transitions (ORD-010/ORD-011)

  /**
   * The only way an order status changes. Validates against the machine,
   * writes history, and is idempotent for a repeated same-status call.
   */
  async transitionOrder(
    orderId: string,
    to: OrderStatus,
    context: TransitionContext = {},
    tx?: Tx,
  ): Promise<OrderStatus> {
    const client = tx ?? this.prisma;
    const order = await client.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) throw AppError.notFound('Order', orderId);
    if (order.status === to) return to;

    if (context.viaPath && !canTransition('order', order.status, to)) {
      const path = shortestPath('order', order.status, to);
      if (path.length === 0) {
        // No legal route at all: this is a genuine illegal transition.
        assertTransition('order', order.status, to);
      }
      let current = order.status;
      for (const step of path as OrderStatus[]) {
        current = await this.transitionOrder(
          orderId,
          step,
          {
            ...context,
            viaPath: false,
            note: step === to ? context.note : `${context.note ?? 'transition'} (via ${step})`,
          },
          client,
        );
      }
      return current;
    }

    // Throws IllegalTransitionError, which the filter maps to HTTP 409 with
    // the allowed transitions attached.
    assertTransition('order', order.status, to);

    await client.order.update({
      where: { id: orderId },
      data: {
        status: to,
        ...(to === 'PAID' ? { paidAt: new Date() } : {}),
        ...(to === 'CANCELLED'
          ? { cancelledAt: new Date(), cancelReason: context.note ?? null }
          : {}),
        ...(to === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
    });

    await client.orderStatusHistory.create({
      data: {
        orderId,
        machine: 'order',
        fromStatus: order.status,
        toStatus: to,
        actorType: context.actorType ?? 'SYSTEM',
        actorId: context.actorId ?? null,
        note: context.note ?? null,
        correlationId: context.correlationId ?? null,
      },
    });

    logger.info({ orderId, from: order.status, to }, 'order transition');
    return to;
  }

  async transitionSubOrder(
    subOrderId: string,
    to: SubOrderStatus,
    context: TransitionContext = {},
    tx?: Tx,
  ): Promise<SubOrderStatus> {
    const client = tx ?? this.prisma;
    const subOrder = await client.subOrder.findUnique({
      where: { id: subOrderId },
      select: { id: true, status: true, orderId: true },
    });
    if (!subOrder) throw AppError.notFound('SubOrder', subOrderId);
    if (subOrder.status === to) return to;

    assertTransition('suborder', subOrder.status, to);

    await client.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: to,
        ...(to === 'CONFIRMED' ? { confirmedAt: new Date() } : {}),
        ...(to === 'REJECTED' ? { rejectedAt: new Date(), rejectReason: context.note ?? null } : {}),
        ...(to === 'HANDED_OVER' ? { handedOverAt: new Date() } : {}),
        ...(to === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
      },
    });

    await client.orderStatusHistory.create({
      data: {
        subOrderId,
        machine: 'suborder',
        fromStatus: subOrder.status,
        toStatus: to,
        actorType: context.actorType ?? 'SYSTEM',
        actorId: context.actorId ?? null,
        note: context.note ?? null,
        correlationId: context.correlationId ?? null,
      },
    });

    await this.syncOrderStatus(subOrder.orderId, context, client);
    return to;
  }

  /**
   * ORD-003: the buyer-facing status is derived from the suborders plus the
   * payment, so operations can move one seller without inventing an order
   * status by hand.
   */
  async syncOrderStatus(orderId: string, context: TransitionContext = {}, tx?: Tx): Promise<OrderStatus> {
    const client = tx ?? this.prisma;
    const order = await client.order.findUnique({
      where: { id: orderId },
      include: {
        subOrders: { select: { status: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
      },
    });
    if (!order) throw AppError.notFound('Order', orderId);

    const derived = deriveOrderStatus(
      order.subOrders.map((subOrder) => subOrder.status),
      order.payments[0]?.status ?? 'CREATED',
    );
    if (derived === order.status) return order.status;

    // The derived status is not always one hop away: two sellers moving at
    // different speeds can leave the order at PAID while the derivation
    // already says PICKING. `viaPath` walks the legal route so every step is
    // validated and recorded (ORD-011) instead of forcing an illegal jump.
    if (shortestPath('order', order.status, derived).length === 0) {
      logger.warn(
        { orderId, from: order.status, derived },
        'derived order status is unreachable from the current one; leaving status unchanged',
      );
      return order.status;
    }

    return this.transitionOrder(
      orderId,
      derived,
      { ...context, viaPath: true, note: context.note ?? 'derived from suborders' },
      client,
    );
  }

  // ───────────────────────────────────────────────── buyer cancellation

  /** ORD-009: allowed only from states the machine and policy permit. */
  async cancelByBuyer(
    userId: string,
    orderId: string,
    reason: string,
    actor: AuthenticatedActor,
  ): Promise<{ status: OrderStatus; refundRequired: boolean }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { subOrders: { select: { id: true, status: true } } },
    });
    if (!order) throw AppError.notFound('Order', orderId);

    if (!buyerCanCancel(order.status)) {
      throw AppError.conflict(
        'ILLEGAL_STATE_TRANSITION',
        'This order can no longer be cancelled from the app — contact support',
        { status: order.status },
      );
    }

    const wasPaid = order.paidAt != null;

    await this.prisma.$transaction(async (tx) => {
      for (const subOrder of order.subOrders) {
        if (subOrder.status === 'CANCELLED' || subOrder.status === 'REJECTED') continue;
        await this.transitionSubOrder(
          subOrder.id,
          'CANCELLED',
          { actorType: 'USER', actorId: userId, note: reason },
          tx,
        );
      }
      // Stock goes back: the hold is released, or allocated units are restocked.
      await this.inventory.releaseForOrder(order.id, 'buyer_cancelled', tx);
      if (wasPaid) {
        const items = await tx.orderItem.findMany({
          where: { orderId: order.id },
          select: { skuId: true, quantity: true, cancelledQuantity: true },
        });
        for (const item of items) {
          const remaining = item.quantity - item.cancelledQuantity;
          if (remaining > 0) {
            await this.inventory.restockFromCancellation(
              item.skuId,
              remaining,
              `order ${order.number} cancelled by buyer`,
              tx,
            );
          }
        }
        await tx.orderItem.updateMany({
          where: { orderId: order.id },
          data: { cancelledQuantity: 0 },
        });
      }
      await this.transitionOrder(
        order.id,
        wasPaid ? 'REFUND_PENDING' : 'CANCELLED',
        { actorType: 'USER', actorId: userId, note: reason },
        tx,
      );
    });

    await this.audit.record(actor, {
      action: 'order.cancel',
      objectType: 'Order',
      objectId: order.id,
      after: { reason, wasPaid },
      severity: 'NOTICE',
    });

    return {
      status: wasPaid ? 'REFUND_PENDING' : 'CANCELLED',
      // PAY-009: the refund itself is created by the finance workflow.
      refundRequired: wasPaid,
    };
  }

  // ───────────────────────────────────────── seller operations (FUL-004)

  async sellerQueue(
    sellerId: string,
    options: { status?: SubOrderStatus[]; limit?: number; offset?: number } = {},
  ) {
    const where: Prisma.SubOrderWhereInput = {
      sellerId,
      status: options.status
        ? { in: options.status }
        : { in: ['PENDING_CONFIRMATION', 'CONFIRMED', 'PICKING', 'READY_FOR_HANDOVER'] },
    };
    const [total, rows] = await Promise.all([
      this.prisma.subOrder.count({ where }),
      this.prisma.subOrder.findMany({
        where,
        orderBy: [{ confirmDueAt: 'asc' }, { createdAt: 'asc' }],
        take: Math.min(options.limit ?? 25, 100),
        skip: options.offset ?? 0,
        include: {
          items: true,
          order: {
            select: {
              number: true,
              placedAt: true,
              locale: true,
              addressSnapshot: true,
              currency: true,
            },
          },
          shipments: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
    ]);

    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        number: row.number,
        orderNumber: row.order.number,
        status: row.status,
        placedAt: row.order.placedAt?.toISOString() ?? null,
        confirmDueAt: row.confirmDueAt?.toISOString() ?? null,
        // FUL-004: the SLA timer the seller cabinet shows.
        slaBreached: row.confirmDueAt != null && row.confirmDueAt < new Date() && !row.confirmedAt,
        goodsTotal: toMoney(row.goodsTotalMinor, row.currency),
        payableTotal: toMoney(row.payableTotalMinor, row.currency),
        commissionTotal: toMoney(row.commissionTotalMinor, row.currency),
        deliveryName: row.deliveryMethodName,
        itemCount: row.items.reduce((acc, item) => acc + item.quantity, 0),
        items: row.items.map((item) => ({
          id: item.id,
          title: item.productTitle,
          brandName: item.brandName,
          sizeLabel: item.sizeLabel,
          colorName: item.colorName,
          quantity: item.quantity,
          cancelledQuantity: item.cancelledQuantity,
          unitPrice: toMoney(item.unitPriceMinor, item.currency),
          imageUrl: item.imageUrl,
          sellerSku: null,
        })),
        shipment: row.shipments[0]
          ? { id: row.shipments[0].id, status: row.shipments[0].status }
          : null,
      })),
    };
  }

  async sellerConfirm(
    sellerId: string,
    subOrderId: string,
    actor: AuthenticatedActor,
  ): Promise<{ status: SubOrderStatus }> {
    const subOrder = await this.requireSubOrder(sellerId, subOrderId);
    await this.transitionSubOrder(subOrder.id, 'CONFIRMED', {
      actorType: 'SELLER',
      actorId: actor.sellerUserId ?? actor.adminUserId ?? null,
    });
    return { status: 'CONFIRMED' };
  }

  /**
   * FUL-004: a rejection records the reason, restocks nothing (the units were
   * never shipped), cancels the affected lines and leaves a refund obligation
   * that the finance workflow picks up. A partial rejection automatically
   * produces a partial cancellation.
   */
  async sellerReject(
    sellerId: string,
    subOrderId: string,
    input: { reason: string; itemIds?: string[] },
    actor: AuthenticatedActor,
  ): Promise<{ status: SubOrderStatus; cancelledItemIds: string[]; refundRequired: boolean }> {
    const subOrder = await this.requireSubOrder(sellerId, subOrderId);
    const items = await this.prisma.orderItem.findMany({ where: { subOrderId } });
    const targetIds = input.itemIds?.length ? input.itemIds : items.map((item) => item.id);
    const targets = items.filter((item) => targetIds.includes(item.id));
    if (targets.length === 0) throw AppError.validation('No matching items to reject');

    const full = targets.length === items.length;
    const paid = subOrder.order.paidAt != null;

    await this.prisma.$transaction(async (tx) => {
      for (const item of targets) {
        const remaining = item.quantity - item.cancelledQuantity;
        if (remaining <= 0) continue;
        await tx.orderItem.update({
          where: { id: item.id },
          data: { cancelledQuantity: item.cancelledQuantity + remaining },
        });
        // Only allocated stock needs restocking; an unpaid order still holds
        // a reservation, which is released below instead.
        if (paid) {
          await this.inventory.restockFromCancellation(
            item.skuId,
            remaining,
            `seller rejected on ${subOrder.number}: ${input.reason}`,
            tx,
          );
        }
      }

      if (!paid) {
        await this.inventory.releaseForOrder(subOrder.orderId, 'seller_rejected', tx);
      }

      await this.transitionSubOrder(
        subOrder.id,
        full ? 'REJECTED' : 'PARTIALLY_CANCELLED',
        {
          actorType: 'SELLER',
          actorId: actor.sellerUserId ?? actor.adminUserId ?? null,
          note: input.reason,
        },
        tx,
      );

      // ADM-009: a stock rejection is exactly the signal the cancellation
      // monitor and the seller quality score are built on.
      await tx.alert.create({
        data: {
          code: 'SELLER_STOCK_REJECTION',
          severity: full ? 'WARNING' : 'INFO',
          title: `Seller rejected ${full ? 'all items' : 'some items'} on ${subOrder.number}`,
          description: input.reason,
          objectType: 'SubOrder',
          objectId: subOrder.id,
          context: { sellerId, itemIds: targetIds } as Prisma.InputJsonValue,
        },
      });
    });

    await this.audit.record(actor, {
      action: 'suborder.reject',
      objectType: 'SubOrder',
      objectId: subOrder.id,
      after: { reason: input.reason, itemIds: targetIds, full },
      severity: 'WARNING',
    });

    return {
      status: full ? 'REJECTED' : 'PARTIALLY_CANCELLED',
      cancelledItemIds: targets.map((item) => item.id),
      refundRequired: paid,
    };
  }

  async sellerAdvance(
    sellerId: string,
    subOrderId: string,
    to: SubOrderStatus,
    actor: AuthenticatedActor,
    note?: string,
  ): Promise<{ status: SubOrderStatus }> {
    const allowed: SubOrderStatus[] = [
      'PICKING',
      'READY_FOR_HANDOVER',
      'HANDED_OVER',
      'IN_TRANSIT',
      'DELIVERED',
      'COMPLETED',
    ];
    if (!allowed.includes(to)) {
      throw AppError.validation('A seller cannot move a suborder to this status', { to, allowed });
    }
    const subOrder = await this.requireSubOrder(sellerId, subOrderId);
    await this.transitionSubOrder(subOrder.id, to, {
      actorType: 'SELLER',
      actorId: actor.sellerUserId ?? actor.adminUserId ?? null,
      note: note ?? null,
    });
    return { status: to };
  }

  private async requireSubOrder(sellerId: string, subOrderId: string) {
    const subOrder = await this.prisma.subOrder.findFirst({
      where: { id: subOrderId, sellerId },
      include: { order: { select: { id: true, number: true, paidAt: true } } },
    });
    // SEL-001: a suborder belonging to another tenant reads as not found, not
    // as forbidden, so the API does not confirm its existence.
    if (!subOrder) throw AppError.notFound('SubOrder', subOrderId);
    return subOrder;
  }

  // ──────────────────────────────────────────────── admin read model

  async adminList(options: {
    status?: OrderStatus[];
    sellerId?: string;
    search?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: Prisma.OrderWhereInput = {
      ...(options.status ? { status: { in: options.status } } : {}),
      ...(options.sellerId ? { subOrders: { some: { sellerId: options.sellerId } } } : {}),
      ...(options.from || options.to
        ? { createdAt: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lte: options.to } : {}) } }
        : {}),
      ...(options.search
        ? {
            OR: [
              { number: { contains: options.search, mode: 'insensitive' } },
              { items: { some: { productTitle: { contains: options.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(options.limit ?? 25, 100),
        skip: options.offset ?? 0,
        include: {
          user: { select: { id: true, firstName: true, phone: true } },
          subOrders: { select: { id: true, number: true, status: true, sellerId: true, seller: { select: { displayName: true } } } },
          payments: { orderBy: { createdAt: 'desc' }, take: 1 },
          _count: { select: { items: true } },
        },
      }),
    ]);

    return { total, rows };
  }

  async adminDetail(orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { number: orderId }] },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true, locale: true } },
        address: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        payments: {
          orderBy: { createdAt: 'desc' },
          include: { transactions: { orderBy: { createdAt: 'desc' }, take: 10 } },
        },
        refunds: { orderBy: { createdAt: 'desc' }, include: { items: true } },
        returnRequests: { orderBy: { createdAt: 'desc' }, include: { items: true } },
        ledgerEntries: { orderBy: { sequence: 'asc' } },
        reservations: true,
        fiscalReceipts: true,
        subOrders: {
          include: {
            seller: { select: { id: true, displayName: true, legalName: true } },
            items: { include: { commissionRule: { select: { code: true, version: true, rateBps: true } } } },
            shipments: { include: { events: { orderBy: { occurredAt: 'desc' } } } },
            statusHistory: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!order) throw AppError.notFound('Order', orderId);
    return order;
  }

  /** Totals used by the dashboard and by reconciliation control totals. */
  async totals(options: { from?: Date; to?: Date; sellerId?: string } = {}) {
    const where: Prisma.OrderWhereInput = {
      status: { notIn: ['DRAFT', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_FAILED'] },
      ...(options.from || options.to
        ? { paidAt: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lte: options.to } : {}) } }
        : {}),
      ...(options.sellerId ? { subOrders: { some: { sellerId: options.sellerId } } } : {}),
    };
    const aggregate = await this.prisma.order.aggregate({
      where,
      _sum: {
        goodsTotalMinor: true,
        discountTotalMinor: true,
        deliveryTotalMinor: true,
        grandTotalMinor: true,
        commissionTotalMinor: true,
        refundedTotalMinor: true,
      },
      _count: { _all: true },
      _avg: { grandTotalMinor: true },
    });

    const itemsAggregate = await this.prisma.orderItem.aggregate({
      where: { order: where },
      _sum: { quantity: true },
    });

    return {
      orderCount: aggregate._count._all,
      goods: toMoney(aggregate._sum.goodsTotalMinor ?? 0n),
      discounts: toMoney(aggregate._sum.discountTotalMinor ?? 0n),
      delivery: toMoney(aggregate._sum.deliveryTotalMinor ?? 0n),
      gmv: toMoney(aggregate._sum.grandTotalMinor ?? 0n),
      commission: toMoney(aggregate._sum.commissionTotalMinor ?? 0n),
      refunded: toMoney(aggregate._sum.refundedTotalMinor ?? 0n),
      averageOrderValue: toMoney(BigInt(Math.round(aggregate._avg.grandTotalMinor ?? 0))),
      itemCount: itemsAggregate._sum.quantity ?? 0,
      itemsPerOrder:
        aggregate._count._all > 0
          ? Number(((itemsAggregate._sum.quantity ?? 0) / aggregate._count._all).toFixed(2))
          : 0,
    };
  }

  /** FUL-004: suborders whose confirmation SLA has lapsed (ADM-009 alert). */
  async overdueConfirmations(limit = 50) {
    return this.prisma.subOrder.findMany({
      where: { status: 'PENDING_CONFIRMATION', confirmDueAt: { lt: new Date() } },
      orderBy: { confirmDueAt: 'asc' },
      take: limit,
      include: { seller: { select: { id: true, displayName: true } }, order: { select: { number: true } } },
    });
  }

  /** Items eligible for a fit-feedback prompt after delivery (FIT-005). */
  async deliveredItemsAwaitingFeedback(userId: string, limit = 10) {
    const items = await this.prisma.orderItem.findMany({
      where: {
        order: { userId },
        subOrder: { status: { in: ['DELIVERED', 'COMPLETED'] } },
        refundedQuantity: 0,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        skuId: true,
        productId: true,
        productTitle: true,
        brandName: true,
        sizeLabel: true,
        imageUrl: true,
      },
    });
    const existing = await this.prisma.fitFeedback.findMany({
      where: { userId, orderItemId: { in: items.map((item) => item.id) } },
      select: { orderItemId: true },
    });
    const answered = new Set(existing.map((row) => row.orderItemId));
    return items.filter((item) => !answered.has(item.id)).slice(0, limit);
  }

  /** Helper for the ledger: every item of an order with its commission data. */
  async itemsForLedger(orderId: string) {
    return this.prisma.orderItem.findMany({
      where: { orderId },
      include: { subOrder: { select: { id: true, sellerId: true, deliveryTotalMinor: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Sum helper kept here so money maths stays in one dialect. */
  totalOf(amounts: Money[], currency: Money['currency'] = 'UZS'): Money {
    return amounts.length === 0 ? zero(currency) : sum(amounts, currency);
  }

  addMoney(a: Money, b: Money): Money {
    return add(a, b);
  }

  multiplyMoney(value: Money, factor: number): Money {
    return multiply(value, factor);
  }

  nullable(minor: bigint | null, currency: string): Money | null {
    return nullableMoney(minor, currency);
  }
}
