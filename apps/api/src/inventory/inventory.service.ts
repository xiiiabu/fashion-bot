/**
 * Inventory, reservations and stock movements — spec CAT-007, CAT-008, ORD-005.
 *
 * CAT-007 on-hand / reserved / available / safety stock, with every change
 *         journalled into StockMovement.
 * CAT-008 A checkout reservation has a TTL: paid becomes an allocation, a
 *         timeout releases it, and "последняя единица не oversell".
 * ORD-005 No eternal reservations — the sweeper releases what expired.
 *
 * The oversell guarantee (UAT-08) rests on one thing: the row-level
 * `UPDATE ... WHERE onHand - reserved - safetyStock >= :qty` below. Two
 * concurrent checkouts for the last unit serialise on that row, and the loser
 * gets 0 rows updated rather than a negative balance.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type ReservationStatus, type StockMovementKind } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';

export interface ReserveRequest {
  readonly skuId: string;
  readonly quantity: number;
}

export interface ReserveResult {
  readonly reservations: Array<{ id: string; skuId: string; quantity: number; expiresAt: Date }>;
  readonly expiresAt: Date;
}

export interface StockSnapshot {
  readonly skuId: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly safetyStock: number;
  readonly available: number;
  readonly lowStock: boolean;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class InventoryService {
  private readonly config = loadConfig();

  constructor(private readonly prisma: PrismaService) {}

  async snapshot(skuIds: string[]): Promise<Map<string, StockSnapshot>> {
    const rows = await this.prisma.inventory.findMany({ where: { skuId: { in: skuIds } } });
    const out = new Map<string, StockSnapshot>();
    for (const row of rows) {
      const available = Math.max(0, row.onHand - row.reserved - row.safetyStock);
      out.set(row.skuId, {
        skuId: row.skuId,
        onHand: row.onHand,
        reserved: row.reserved,
        safetyStock: row.safetyStock,
        available,
        lowStock: available > 0 && available <= row.lowStockThreshold,
      });
    }
    for (const skuId of skuIds) {
      if (!out.has(skuId)) {
        out.set(skuId, {
          skuId,
          onHand: 0,
          reserved: 0,
          safetyStock: 0,
          available: 0,
          lowStock: false,
        });
      }
    }
    return out;
  }

  async available(skuId: string): Promise<number> {
    const snapshot = await this.snapshot([skuId]);
    return snapshot.get(skuId)?.available ?? 0;
  }

  /**
   * CAT-008: hold stock for a checkout. All-or-nothing — a cart that cannot be
   * fully reserved releases what it took and reports which SKU failed, so the
   * shopper sees one clear message instead of a half-reserved cart.
   */
  async reserveForCheckout(
    cartId: string,
    requests: ReserveRequest[],
    options: { ttlSeconds?: number; correlationId?: string; orderId?: string | null } = {},
  ): Promise<ReserveResult> {
    const ttl = options.ttlSeconds ?? this.config.RESERVATION_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    return this.prisma.$transaction(
      async (tx) => {
        // A fresh quote supersedes the previous hold for the same cart.
        await this.releaseForCart(cartId, tx, 'requote');

        const created: ReserveResult['reservations'] = [];
        for (const request of requests) {
          if (request.quantity <= 0) continue;
          const ok = await this.tryReserveRow(tx, request.skuId, request.quantity);
          if (!ok) {
            const snapshot = await this.snapshot([request.skuId]);
            throw new AppError('OUT_OF_STOCK', {
              message: 'Not enough stock to hold this item',
              details: {
                skuId: request.skuId,
                requested: request.quantity,
                available: snapshot.get(request.skuId)?.available ?? 0,
              },
            });
          }

          const reservation = await tx.reservation.create({
            data: {
              skuId: request.skuId,
              cartId,
              orderId: options.orderId ?? null,
              quantity: request.quantity,
              status: 'HELD',
              expiresAt,
            },
          });
          created.push({
            id: reservation.id,
            skuId: request.skuId,
            quantity: request.quantity,
            expiresAt,
          });

          await this.journal(tx, {
            skuId: request.skuId,
            kind: 'RESERVATION',
            quantity: -request.quantity,
            reason: `checkout hold for cart ${cartId}`,
            reservationId: reservation.id,
            correlationId: options.correlationId,
          });
        }

        return { reservations: created, expiresAt };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
    );
  }

  /**
   * The atomic guard. Returns false when the conditional update matched no
   * rows, which is exactly "someone else took the last unit".
   */
  private async tryReserveRow(tx: Tx, skuId: string, quantity: number): Promise<boolean> {
    const updated = await tx.$executeRaw`
      UPDATE "Inventory"
      SET "reserved" = "reserved" + ${quantity}, "updatedAt" = NOW()
      WHERE "skuId" = ${skuId}
        AND ("onHand" - "reserved" - "safetyStock") >= ${quantity}
    `;
    return updated === 1;
  }

  /** ORD-005: release on timeout, cancel or payment failure. */
  async releaseForCart(cartId: string, tx?: Tx, reason = 'released'): Promise<number> {
    const client = tx ?? this.prisma;
    const held = await client.reservation.findMany({
      where: { cartId, status: 'HELD' },
    });
    if (held.length === 0) return 0;

    for (const reservation of held) {
      await this.decrementReserved(client, reservation.skuId, reservation.quantity);
      await this.journal(client, {
        skuId: reservation.skuId,
        kind: 'RELEASE',
        quantity: reservation.quantity,
        reason,
        reservationId: reservation.id,
      });
    }
    await client.reservation.updateMany({
      where: { id: { in: held.map((reservation) => reservation.id) } },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    return held.length;
  }

  async releaseForOrder(orderId: string, reason = 'order_cancelled', tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma;
    const held = await client.reservation.findMany({ where: { orderId, status: 'HELD' } });
    for (const reservation of held) {
      await this.decrementReserved(client, reservation.skuId, reservation.quantity);
      await this.journal(client, {
        skuId: reservation.skuId,
        kind: 'RELEASE',
        quantity: reservation.quantity,
        reason,
        reservationId: reservation.id,
      });
    }
    if (held.length > 0) {
      await client.reservation.updateMany({
        where: { id: { in: held.map((reservation) => reservation.id) } },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
    }
    return held.length;
  }

  /** Attach existing cart holds to the order created from that cart. */
  async bindReservationsToOrder(cartId: string, orderId: string, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.reservation.updateMany({
      where: { cartId, status: 'HELD' },
      data: { orderId },
    });
  }

  /**
   * CAT-008: payment captured -> the hold becomes a real decrement of on-hand.
   * Reserved goes down by the same amount, so available is unchanged by the
   * allocation itself: the units were already unavailable.
   */
  async allocateForOrder(orderId: string, tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma;
    const held = await client.reservation.findMany({ where: { orderId, status: 'HELD' } });
    if (held.length === 0) return 0;

    for (const reservation of held) {
      await client.$executeRaw`
        UPDATE "Inventory"
        SET "onHand" = GREATEST(0, "onHand" - ${reservation.quantity}),
            "reserved" = GREATEST(0, "reserved" - ${reservation.quantity}),
            "updatedAt" = NOW()
        WHERE "skuId" = ${reservation.skuId}
      `;
      await this.journal(client, {
        skuId: reservation.skuId,
        kind: 'ALLOCATION',
        quantity: -reservation.quantity,
        reason: `allocated to order ${orderId}`,
        reservationId: reservation.id,
      });
    }

    await client.reservation.updateMany({
      where: { id: { in: held.map((reservation) => reservation.id) } },
      data: { status: 'ALLOCATED', allocatedAt: new Date() },
    });
    return held.length;
  }

  /**
   * FUL-004: a seller rejects a line for stock. The units were already
   * allocated, so returning them to on-hand is the correct compensation.
   */
  async restockFromCancellation(
    skuId: string,
    quantity: number,
    reason: string,
    tx?: Tx,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.$executeRaw`
      UPDATE "Inventory"
      SET "onHand" = "onHand" + ${quantity}, "updatedAt" = NOW()
      WHERE "skuId" = ${skuId}
    `;
    await this.journal(client, {
      skuId,
      kind: 'CANCELLATION',
      quantity,
      reason,
    });
  }

  /** FUL-007: a returned item passes inspection and goes back on sale. */
  async restockFromReturn(skuId: string, quantity: number, returnId: string, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.$executeRaw`
      UPDATE "Inventory"
      SET "onHand" = "onHand" + ${quantity}, "updatedAt" = NOW()
      WHERE "skuId" = ${skuId}
    `;
    await this.journal(client, {
      skuId,
      kind: 'RETURN_RESTOCK',
      quantity,
      reason: `restock from return ${returnId}`,
    });
  }

  /** CAT-007: manual, CSV and API stock updates all land here. */
  async setStock(
    skuId: string,
    input: {
      onHand?: number;
      safetyStock?: number;
      lowStockThreshold?: number;
      location?: string | null;
    },
    context: {
      kind?: StockMovementKind;
      reason: string;
      actorType?: string;
      actorId?: string;
      correlationId?: string;
    },
  ): Promise<StockSnapshot> {
    const existing = await this.prisma.inventory.findUnique({ where: { skuId } });
    const previousOnHand = existing?.onHand ?? 0;

    const inventory = await this.prisma.inventory.upsert({
      where: { skuId },
      create: {
        skuId,
        onHand: Math.max(0, input.onHand ?? 0),
        safetyStock: Math.max(0, input.safetyStock ?? 0),
        lowStockThreshold: input.lowStockThreshold ?? 2,
        location: input.location ?? null,
        lastFeedAt: new Date(),
      },
      update: {
        onHand: input.onHand != null ? Math.max(0, input.onHand) : undefined,
        safetyStock: input.safetyStock != null ? Math.max(0, input.safetyStock) : undefined,
        lowStockThreshold: input.lowStockThreshold ?? undefined,
        location: input.location === null ? null : (input.location ?? undefined),
        lastFeedAt: new Date(),
      },
    });

    if (input.onHand != null && input.onHand !== previousOnHand) {
      await this.journal(this.prisma, {
        skuId,
        kind: context.kind ?? 'MANUAL_ADJUST',
        quantity: input.onHand - previousOnHand,
        reason: context.reason,
        actorType: context.actorType,
        actorId: context.actorId,
        correlationId: context.correlationId,
      });
    }

    const available = Math.max(0, inventory.onHand - inventory.reserved - inventory.safetyStock);
    return {
      skuId,
      onHand: inventory.onHand,
      reserved: inventory.reserved,
      safetyStock: inventory.safetyStock,
      available,
      lowStock: available > 0 && available <= inventory.lowStockThreshold,
    };
  }

  /**
   * ORD-005 / CAT-008: the sweeper. Runs on a schedule and on demand, and is
   * safe to run concurrently because it re-reads state inside a transaction.
   */
  async releaseExpiredReservations(limit = 500): Promise<{ released: number; skuIds: string[] }> {
    const expired = await this.prisma.reservation.findMany({
      where: { status: 'HELD', expiresAt: { lt: new Date() } },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });
    if (expired.length === 0) return { released: 0, skuIds: [] };

    const skuIds = new Set<string>();
    for (const reservation of expired) {
      await this.prisma.$transaction(async (tx) => {
        // Re-check inside the transaction: an allocation may have landed since.
        const current = await tx.reservation.findUnique({ where: { id: reservation.id } });
        if (!current || current.status !== 'HELD') return;
        await this.decrementReserved(tx, current.skuId, current.quantity);
        await tx.reservation.update({
          where: { id: current.id },
          data: { status: 'EXPIRED', releasedAt: new Date() },
        });
        await this.journal(tx, {
          skuId: current.skuId,
          kind: 'RELEASE',
          quantity: current.quantity,
          reason: 'reservation expired',
          reservationId: current.id,
        });
        skuIds.add(current.skuId);
      });
    }

    logger.info({ released: expired.length }, 'released expired reservations');
    return { released: expired.length, skuIds: [...skuIds] };
  }

  /** Stock ledger for the admin panel and the seller cabinet (CAT-007). */
  async movements(skuId: string, limit = 50) {
    return this.prisma.stockMovement.findMany({
      where: { skuId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** ADM-009: SKUs whose feed has gone quiet, so the alert has an owner. */
  async staleStock(hours = 48, limit = 100) {
    const threshold = new Date(Date.now() - hours * 3_600_000);
    return this.prisma.inventory.findMany({
      where: { OR: [{ lastFeedAt: { lt: threshold } }, { lastFeedAt: null }], onHand: { gt: 0 } },
      include: { sku: { include: { product: { select: { titleRu: true, sellerId: true } } } } },
      take: limit,
    });
  }

  private async decrementReserved(client: Tx | PrismaService, skuId: string, quantity: number): Promise<void> {
    await client.$executeRaw`
      UPDATE "Inventory"
      SET "reserved" = GREATEST(0, "reserved" - ${quantity}), "updatedAt" = NOW()
      WHERE "skuId" = ${skuId}
    `;
  }

  /** CAT-007 acceptance criterion: "каждое изменение журналируется". */
  private async journal(
    client: Tx | PrismaService,
    input: {
      skuId: string;
      kind: StockMovementKind;
      quantity: number;
      reason?: string;
      reservationId?: string;
      orderItemId?: string;
      actorType?: string;
      actorId?: string;
      correlationId?: string;
    },
  ): Promise<void> {
    const inventory = await client.inventory.findUnique({ where: { skuId: input.skuId } });
    await client.stockMovement.create({
      data: {
        skuId: input.skuId,
        kind: input.kind,
        quantity: input.quantity,
        onHandAfter: inventory?.onHand ?? 0,
        reservedAfter: inventory?.reserved ?? 0,
        reason: input.reason ?? null,
        reservationId: input.reservationId ?? null,
        orderItemId: input.orderItemId ?? null,
        actorType: input.actorType ?? 'SYSTEM',
        actorId: input.actorId ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  }

  /** NTF-003: SKUs that just became available again, for the notifier. */
  async findBackInStockSubscriptions(skuIds: string[]) {
    if (skuIds.length === 0) return [];
    return this.prisma.stockSubscription.findMany({
      where: {
        skuId: { in: skuIds },
        wantsBackInStock: true,
        notifiedAt: null,
        sku: { inventory: { onHand: { gt: 0 } } },
      },
      include: {
        sku: { include: { product: { select: { id: true, titleRu: true, titleUz: true, titleEn: true } } } },
        user: { select: { id: true, locale: true } },
      },
      take: 200,
    });
  }

  async markSubscriptionNotified(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.stockSubscription.updateMany({
      where: { id: { in: ids } },
      data: { notifiedAt: new Date() },
    });
  }
}

export type { ReservationStatus };
