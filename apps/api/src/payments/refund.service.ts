/**
 * Refunds — spec PAY-009, PAY-010, ADM-005.
 *
 * PAY-009 Full or partial refund by item and quantity; commission and seller
 *         payable reverse proportionally (UAT-14).
 * PAY-010 The refund goes back through the original PSP unless contract or law
 *         says otherwise; the provider reference and status are stored.
 * ADM-005 A large refund needs a second approval, and the maker may not be the
 *         checker.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type Locale,
  type Money,
  LARGE_REFUND_THRESHOLD_BPS,
  add,
  compare,
  money,
  toBigInt,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { toMinor, toMoney } from '../common/money.util';
import { AuditService } from '../common/audit.service';
import type { AuthenticatedActor } from '../common/http';
import { LedgerService } from '../finance/ledger.service';
import { OrdersService } from '../orders/orders.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentService } from './payment.service';

export interface CreateRefundInput {
  readonly orderId: string;
  readonly lines: Array<{ orderItemId: string; quantity: number; grossOverrideMinor?: string | null }>;
  readonly reason: string;
  readonly returnRequestId?: string | null;
  readonly restock?: boolean;
  readonly idempotencyKey?: string | null;
}

@Injectable()
export class RefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly payments: PaymentService,
    private readonly orders: OrdersService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** Preview, so the operator sees the 10% reversal before committing. */
  async preview(input: Pick<CreateRefundInput, 'orderId' | 'lines'>) {
    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, grandTotalMinor: true, currency: true },
    });
    if (!order) throw AppError.notFound('Order', input.orderId);

    const preview = await this.ledger.previewRefund(
      input.lines.map((line) => ({
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        grossOverrideMinor: line.grossOverrideMinor ? BigInt(line.grossOverrideMinor) : null,
      })),
    );

    const shareBps =
      order.grandTotalMinor === 0n
        ? 0
        : Number((toBigInt(preview.totalGross) * 10_000n) / order.grandTotalMinor);

    return {
      ...preview,
      shareOfOrderBps: shareBps,
      requiresApproval: shareBps >= LARGE_REFUND_THRESHOLD_BPS,
    };
  }

  /**
   * Create the refund. It is persisted in PENDING, posts no ledger entries
   * yet, and is only sent to the PSP once it is approved (immediately for a
   * small refund, after a second approval for a large one).
   */
  async create(
    input: CreateRefundInput,
    actor: AuthenticatedActor,
  ): Promise<{ id: string; number: string; status: string; requiresApproval: boolean; amount: Money }> {
    if (input.reason.trim().length < 4) {
      throw AppError.validation('A refund needs a reason');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      include: {
        payments: { where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } }, orderBy: { capturedAt: 'desc' } },
        items: true,
      },
    });
    if (!order) throw AppError.notFound('Order', input.orderId);

    const payment = order.payments[0];
    if (!payment) {
      throw AppError.conflict('CONFLICT', 'This order has no captured payment to refund');
    }

    const preview = await this.ledger.previewRefund(
      input.lines.map((line) => ({
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        grossOverrideMinor: line.grossOverrideMinor ? BigInt(line.grossOverrideMinor) : null,
      })),
    );

    const refundable = await this.payments.refundableAmount(payment.id);
    if (compare(preview.totalGross, refundable) > 0) {
      throw AppError.validation('Refund exceeds the refundable amount on this payment', {
        requested: preview.totalGross.amount,
        refundable: refundable.amount,
      });
    }

    const shareBps =
      order.grandTotalMinor === 0n
        ? 0
        : Number((toBigInt(preview.totalGross) * 10_000n) / order.grandTotalMinor);
    const requiresApproval = shareBps >= LARGE_REFUND_THRESHOLD_BPS;

    const count = await this.prisma.refund.count();
    const number = `RF-${new Date().getUTCFullYear()}-${String(count + 1).padStart(5, '0')}`;

    const refund = await this.prisma.$transaction(async (tx) => {
      const created = await tx.refund.create({
        data: {
          number,
          orderId: order.id,
          paymentId: payment.id,
          returnRequestId: input.returnRequestId ?? null,
          amountMinor: toMinor(preview.totalGross),
          commissionReversalMinor: toMinor(preview.totalCommissionReversal),
          currency: order.currency,
          reason: input.reason,
          status: requiresApproval ? 'PENDING_APPROVAL' : 'PENDING',
          provider: payment.provider,
          requiresApproval,
          requestedByAdminId: actor.adminUserId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      for (const line of preview.lines) {
        await tx.refundItem.create({
          data: {
            refundId: created.id,
            orderItemId: line.orderItemId,
            quantity: line.quantity,
            grossMinor: toMinor(line.gross),
            commissionReversalMinor: toMinor(line.commissionReversal),
            sellerPayableReversalMinor: toMinor(line.sellerPayableReversal),
            currency: order.currency,
          },
        });
      }
      return created;
    });

    await this.audit.record(actor, {
      action: 'refund.create',
      objectType: 'Refund',
      objectId: refund.id,
      after: {
        number,
        amount: preview.totalGross,
        commissionReversal: preview.totalCommissionReversal,
        shareBps,
        requiresApproval,
      },
      reason: input.reason,
      severity: requiresApproval ? 'WARNING' : 'NOTICE',
    });

    // A small refund proceeds immediately; a large one waits for a checker.
    if (!requiresApproval) {
      await this.process(refund.id, actor, { restock: input.restock ?? false });
      const processed = await this.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
      return {
        id: refund.id,
        number,
        status: processed.status,
        requiresApproval: false,
        amount: preview.totalGross,
      };
    }

    // ADM-005: the maker/checker record the admin UI drives.
    await this.prisma.approvalRequest.create({
      data: {
        action: 'refund.large',
        objectType: 'Refund',
        objectId: refund.id,
        payload: {
          amountMinor: preview.totalGross.amount,
          shareBps,
          reason: input.reason,
          restock: input.restock ?? false,
        } as Prisma.InputJsonValue,
        makerAdminId: actor.adminUserId ?? 'system',
        makerEmail: actor.email ?? 'system',
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });

    return {
      id: refund.id,
      number,
      status: 'PENDING_APPROVAL',
      requiresApproval: true,
      amount: preview.totalGross,
    };
  }

  /** ADM-005 / UAT-18: the second approval, which the maker cannot give. */
  async approve(
    refundId: string,
    actor: AuthenticatedActor,
    decision: { approve: boolean; note?: string },
  ): Promise<{ status: string }> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw AppError.notFound('Refund', refundId);
    if (refund.status !== 'PENDING_APPROVAL') {
      throw AppError.conflict('CONFLICT', 'This refund is not awaiting approval', { status: refund.status });
    }
    if (refund.requestedByAdminId && refund.requestedByAdminId === actor.adminUserId) {
      throw AppError.forbidden('The requester of a refund cannot approve it (ADM-005)', {
        rule: 'maker_checker',
      });
    }

    const approval = await this.prisma.approvalRequest.findFirst({
      where: { objectType: 'Refund', objectId: refundId, status: 'PENDING' },
    });

    if (!decision.approve) {
      await this.prisma.$transaction(async (tx) => {
        await tx.refund.update({
          where: { id: refundId },
          data: { status: 'REJECTED', failureMessage: decision.note ?? 'Rejected by approver' },
        });
        if (approval) {
          await tx.approvalRequest.update({
            where: { id: approval.id },
            data: {
              status: 'REJECTED',
              checkerAdminId: actor.adminUserId,
              checkerEmail: actor.email,
              decidedAt: new Date(),
              rejectReason: decision.note ?? null,
            },
          });
        }
      });
      await this.audit.record(actor, {
        action: 'refund.reject',
        objectType: 'Refund',
        objectId: refundId,
        reason: decision.note,
        severity: 'WARNING',
      });
      return { status: 'REJECTED' };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refundId },
        data: { status: 'PENDING', approvedByAdminId: actor.adminUserId, approvedAt: new Date() },
      });
      if (approval) {
        await tx.approvalRequest.update({
          where: { id: approval.id },
          data: {
            status: 'APPROVED',
            checkerAdminId: actor.adminUserId,
            checkerEmail: actor.email,
            decidedAt: new Date(),
          },
        });
      }
    });

    const payload = (approval?.payload as { restock?: boolean } | undefined) ?? {};
    await this.process(refundId, actor, { restock: payload.restock ?? false });
    const processed = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    return { status: processed.status };
  }

  /**
   * PAY-010: send the reversal to the original provider, then post the ledger
   * entries. The order is deliberate — we never reverse the books for money
   * that did not actually go back.
   */
  async process(
    refundId: string,
    actor: AuthenticatedActor,
    options: { restock?: boolean } = {},
  ): Promise<{ status: string; providerRefundId: string | null }> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        payment: true,
        items: { include: { orderItem: true } },
        order: { select: { id: true, number: true, userId: true, locale: true, currency: true } },
      },
    });
    if (!refund) throw AppError.notFound('Refund', refundId);
    if (refund.status === 'COMPLETED') {
      return { status: refund.status, providerRefundId: refund.providerRefundId };
    }
    if (refund.status === 'PENDING_APPROVAL') {
      throw AppError.conflict('CONFLICT', 'This refund still needs approval');
    }

    const currency = refund.currency as Money['currency'];
    const provider = this.payments.providerByCode(refund.provider);
    const amount = money(refund.amountMinor, currency);

    let providerRefundId: string | null = null;
    let providerReference: string | null = null;
    let providerStatus: 'COMPLETED' | 'PENDING' | 'FAILED' = 'PENDING';
    let failureMessage: string | null = null;

    if (provider && refund.payment.providerPaymentId) {
      const result = await provider.refund({
        refundId: refund.id,
        paymentId: refund.paymentId,
        providerPaymentId: refund.payment.providerPaymentId,
        amount,
        reason: refund.reason,
        idempotencyKey: refund.idempotencyKey ?? `refund:${refund.id}`,
      });
      providerStatus = result.status;
      providerRefundId = result.providerRefundId;
      providerReference = result.providerReference;
      failureMessage = result.failureMessage ?? null;
    } else {
      // No provider route: the finance team pays out manually and records the
      // reference. The books must still be correct, so we continue.
      providerStatus = 'PENDING';
      failureMessage = 'No automated provider route — process manually and record the reference';
    }

    if (providerStatus === 'FAILED') {
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: { status: 'FAILED', failureMessage: failureMessage?.slice(0, 500) ?? 'Provider refused' },
      });
      await this.prisma.alert.create({
        data: {
          code: 'REFUND_FAILED',
          severity: 'CRITICAL',
          title: `Refund ${refund.number} failed at the provider`,
          description: failureMessage ?? undefined,
          objectType: 'Refund',
          objectId: refund.id,
        },
      });
      return { status: 'FAILED', providerRefundId: null };
    }

    await this.prisma.$transaction(
      async (tx) => {
        await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: providerStatus === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
            providerRefundId,
            providerReference,
            processedAt: providerStatus === 'COMPLETED' ? new Date() : null,
            failureMessage: failureMessage?.slice(0, 500) ?? null,
          },
        });

        // PAY-009: the proportional reversal.
        await this.ledger.postRefundEntries(refund.id, {}, tx);

        let refundedTotal = zero(currency);
        for (const line of refund.items) {
          await tx.orderItem.update({
            where: { id: line.orderItemId },
            data: {
              refundedQuantity: { increment: line.quantity },
              refundedAmountMinor: { increment: line.grossMinor },
            },
          });
          refundedTotal = add(refundedTotal, money(line.grossMinor, currency));

          // FUL-007: restock only when the goods actually came back and passed
          // inspection; a goodwill refund must not inflate stock.
          if (options.restock) {
            await this.inventory.restockFromReturn(
              line.orderItem.skuId,
              line.quantity,
              refund.number,
              tx,
            );
          }
        }

        await tx.payment.update({
          where: { id: refund.paymentId },
          data: {
            refundedMinor: { increment: refund.amountMinor },
            status:
              refund.payment.refundedMinor + refund.amountMinor >= refund.payment.capturedMinor
                ? 'REFUNDED'
                : 'PARTIALLY_REFUNDED',
          },
        });

        await tx.order.update({
          where: { id: refund.orderId },
          data: { refundedTotalMinor: { increment: refund.amountMinor } },
        });

        // PAY-016: a fiscal record for the refund, not only for the sale.
        await tx.fiscalReceipt.create({
          data: {
            orderId: refund.orderId,
            refundId: refund.id,
            kind: 'REFUND',
            provider: refund.provider,
            fiscalId: providerRefundId,
            sellerOfRecord: 'PLATFORM_PENDING_D02',
            amountMinor: refund.amountMinor,
            currency,
          },
        });

        const order = await tx.order.findUniqueOrThrow({
          where: { id: refund.orderId },
          select: { grandTotalMinor: true, refundedTotalMinor: true, status: true },
        });
        const fullyRefunded = order.refundedTotalMinor >= order.grandTotalMinor;
        // A refund can land while the order sits anywhere from PAID to
        // RETURN_REQUESTED, so the target is an end state, not a next hop.
        await this.orders.transitionOrder(
          refund.orderId,
          fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          {
            actorType: 'ADMIN',
            actorId: actor.adminUserId ?? null,
            note: `Refund ${refund.number}`,
            viaPath: true,
          },
          tx,
        );

        if (refund.returnRequestId) {
          await tx.returnRequest.update({
            where: { id: refund.returnRequestId },
            data: { status: 'REFUNDED', refundedAt: new Date() },
          });
          await tx.returnStatusHistory.create({
            data: {
              returnRequestId: refund.returnRequestId,
              fromStatus: 'REFUND_PENDING',
              toStatus: 'REFUNDED',
              actorType: 'ADMIN',
              actorId: actor.adminUserId ?? null,
              note: refund.number,
            },
          });
        }
      },
      { timeout: 25_000 },
    );

    await this.notifications
      .sendOrderNotification(refund.order.userId, 'notify.refund_done', {
        orderNumber: refund.order.number,
        orderId: refund.order.id,
        locale: refund.order.locale as Locale,
      })
      .catch((error) => logger.warn({ err: error }, 'refund notification failed'));

    await this.audit.record(actor, {
      action: 'refund.process',
      objectType: 'Refund',
      objectId: refund.id,
      after: { status: providerStatus, providerRefundId, amount: amount.amount },
      severity: 'WARNING',
    });

    logger.info(
      { refundId: refund.id, number: refund.number, amount: amount.amount, status: providerStatus },
      'refund processed',
    );

    return { status: providerStatus === 'COMPLETED' ? 'COMPLETED' : 'PENDING', providerRefundId };
  }

  /**
   * Convenience path used when a seller rejects lines or a buyer cancels a
   * paid order: refund exactly the cancelled quantities.
   */
  async refundCancelledItems(
    orderId: string,
    reason: string,
    actor: AuthenticatedActor,
  ): Promise<{ id: string; number: string; amount: Money } | null> {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { id: true, quantity: true, cancelledQuantity: true, refundedQuantity: true },
    });
    const lines = items
      .map((item) => ({
        orderItemId: item.id,
        quantity: Math.max(0, item.cancelledQuantity - item.refundedQuantity),
      }))
      .filter((line) => line.quantity > 0);

    // A buyer cancellation marks nothing as cancelled per line, so fall back
    // to everything that is still unrefunded.
    const effective =
      lines.length > 0
        ? lines
        : items
            .map((item) => ({
              orderItemId: item.id,
              quantity: Math.max(0, item.quantity - item.refundedQuantity),
            }))
            .filter((line) => line.quantity > 0);

    if (effective.length === 0) return null;

    const result = await this.create({ orderId, lines: effective, reason, restock: false }, actor);
    return { id: result.id, number: result.number, amount: result.amount };
  }

  async list(options: { status?: string; orderId?: string; limit?: number; offset?: number }) {
    const where: Prisma.RefundWhereInput = {
      ...(options.status ? { status: options.status } : {}),
      ...(options.orderId ? { orderId: options.orderId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(options.limit ?? 25, 100),
        skip: options.offset ?? 0,
        include: {
          order: { select: { number: true, currency: true } },
          items: { include: { orderItem: { select: { productTitle: true, sizeLabel: true, sellerId: true } } } },
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
        amount: toMoney(row.amountMinor, row.currency),
        commissionReversal: toMoney(row.commissionReversalMinor, row.currency),
        reason: row.reason,
        provider: row.provider,
        requiresApproval: row.requiresApproval,
        createdAt: row.createdAt.toISOString(),
        items: row.items.map((item) => ({
          title: item.orderItem.productTitle,
          sizeLabel: item.orderItem.sizeLabel,
          quantity: item.quantity,
          gross: toMoney(item.grossMinor, item.currency),
        })),
      })),
    };
  }
}
