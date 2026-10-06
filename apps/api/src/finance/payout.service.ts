/**
 * Payouts and reconciliation — spec PAY-011, PAY-012, ADM-005, ADM-012.
 *
 * PAY-011 Daily reconciliation of internal transactions against provider
 *         records; every unmatched row gets an owner and a workflow.
 * PAY-012 Payout batches per seller / currency / period against the available
 *         balance, with hold and reserve, maker/checker and an export.
 * ADM-012 Exports carry immutable ids and control totals that tie to the ledger.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type PayoutBatchStatus } from '@prisma/client';
import { type Money, add, money, subtract, toBigInt, zero } from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { sha256 } from '../common/crypto';
import { toMinor, toMoney } from '../common/money.util';
import { AuditService } from '../common/audit.service';
import type { AuthenticatedActor } from '../common/http';
import { LedgerService } from './ledger.service';

@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /**
   * PAY-012: build a draft batch. Nothing is posted to the ledger yet — a
   * DRAFT is a proposal, and the PAYOUT entry appears only when it is sent.
   */
  async createBatch(
    input: { sellerId: string; periodFrom: Date; periodTo: Date; currency?: string },
    actor: AuthenticatedActor,
  ): Promise<{ id: string; number: string; net: Money; lineCount: number }> {
    if (!actor.adminUserId) throw AppError.forbidden('Only an admin may create a payout batch');
    const currency = input.currency ?? 'UZS';

    const seller = await this.prisma.seller.findUnique({
      where: { id: input.sellerId },
      include: { payoutAccounts: { where: { isDefault: true }, take: 1 } },
    });
    if (!seller) throw AppError.notFound('Seller', input.sellerId);

    const open = await this.prisma.payoutBatch.findFirst({
      where: { sellerId: input.sellerId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
    });
    if (open) {
      throw AppError.conflict('CONFLICT', 'This seller already has an open payout batch', {
        batchNumber: open.number,
      });
    }

    // Only entries in the period that are not already in a batch.
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        sellerId: input.sellerId,
        currency,
        createdAt: { gte: input.periodFrom, lte: input.periodTo },
        payoutBatchId: null,
        event: {
          in: ['SELLER_PAYABLE', 'SELLER_PAYABLE_REVERSAL', 'DISCOUNT_SELLER', 'ADJUSTMENT'],
        },
      },
      orderBy: { sequence: 'asc' },
      include: { orderItem: { select: { productTitle: true, sizeLabel: true } }, order: { select: { number: true } } },
    });

    if (entries.length === 0) {
      throw AppError.validation('Nothing to pay out for this seller and period');
    }

    const balance = await this.ledger.sellerBalance(input.sellerId, currency);
    let gross = zero(currency as Money['currency']);
    let commission = zero(currency as Money['currency']);
    let refunds = zero(currency as Money['currency']);
    let adjustments = zero(currency as Money['currency']);
    let net = zero(currency as Money['currency']);

    for (const entry of entries) {
      const signed = money(entry.signedAmountMinor, currency as Money['currency']);
      net = add(net, signed);
      switch (entry.event) {
        case 'SELLER_PAYABLE':
          gross = add(gross, money(entry.amountMinor, currency as Money['currency']));
          break;
        case 'SELLER_PAYABLE_REVERSAL':
          refunds = add(refunds, money(entry.amountMinor, currency as Money['currency']));
          break;
        case 'DISCOUNT_SELLER':
          commission = add(commission, money(entry.amountMinor, currency as Money['currency']));
          break;
        case 'ADJUSTMENT':
          adjustments = add(adjustments, signed);
          break;
        default:
          break;
      }
    }

    const commissionAggregate = await this.prisma.ledgerEntry.aggregate({
      where: {
        sellerId: input.sellerId,
        currency,
        createdAt: { gte: input.periodFrom, lte: input.periodTo },
        event: { in: ['PLATFORM_COMMISSION'] },
      },
      _sum: { amountMinor: true },
    });

    // PAY-012: the hold and the return reserve are withheld from the net.
    const hold = balance.hold;
    const reserve = balance.reserve;
    const payable = subtract(subtract(net, hold), reserve);
    const finalNet = toBigInt(payable) > 0n ? payable : zero(currency as Money['currency']);

    const count = await this.prisma.payoutBatch.count();
    const number = `PO-${input.periodTo.getUTCFullYear()}-${String(count + 1).padStart(5, '0')}`;

    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payoutBatch.create({
        data: {
          number,
          sellerId: input.sellerId,
          payoutAccountId: seller.payoutAccounts[0]?.id ?? null,
          periodFrom: input.periodFrom,
          periodTo: input.periodTo,
          grossMinor: toMinor(gross),
          commissionMinor: commissionAggregate._sum.amountMinor ?? 0n,
          refundsMinor: toMinor(refunds),
          adjustmentsMinor: toMinor(adjustments),
          holdMinor: toMinor(hold),
          reserveMinor: toMinor(reserve),
          netMinor: toMinor(finalNet),
          currency,
          status: 'DRAFT',
          createdByAdminId: actor.adminUserId!,
        },
      });

      for (const entry of entries) {
        await tx.payoutLine.create({
          data: {
            batchId: created.id,
            orderItemId: entry.orderItemId,
            orderId: entry.orderId,
            kind: entry.event,
            amountMinor: entry.signedAmountMinor,
            currency,
            memo:
              entry.orderItem && entry.order
                ? `${entry.order.number} · ${entry.orderItem.productTitle} (${entry.orderItem.sizeLabel})`
                : entry.memo,
          },
        });
      }

      // Claim the entries so a second batch cannot double-pay them.
      await tx.ledgerEntry.updateMany({
        where: { id: { in: entries.map((entry) => entry.id) } },
        data: { payoutBatchId: created.id },
      });

      return created;
    });

    await this.audit.record(actor, {
      action: 'payout.create',
      objectType: 'PayoutBatch',
      objectId: batch.id,
      after: { number, net: finalNet.amount, lineCount: entries.length },
      severity: 'WARNING',
    });

    return { id: batch.id, number, net: finalNet, lineCount: entries.length };
  }

  /** ADM-005: submit for approval; a separate admin must approve. */
  async submitForApproval(batchId: string, actor: AuthenticatedActor): Promise<{ status: PayoutBatchStatus }> {
    const batch = await this.prisma.payoutBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw AppError.notFound('PayoutBatch', batchId);
    if (batch.status !== 'DRAFT') {
      throw AppError.conflict('CONFLICT', 'Only a draft batch can be submitted', { status: batch.status });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payoutBatch.update({ where: { id: batchId }, data: { status: 'PENDING_APPROVAL' } });
      await tx.approvalRequest.create({
        data: {
          action: 'payout.release',
          objectType: 'PayoutBatch',
          objectId: batchId,
          payload: {
            number: batch.number,
            netMinor: batch.netMinor.toString(),
            sellerId: batch.sellerId,
          } as Prisma.InputJsonValue,
          makerAdminId: actor.adminUserId ?? 'system',
          makerEmail: actor.email ?? 'system',
          expiresAt: new Date(Date.now() + 14 * 86_400_000),
        },
      });
    });

    return { status: 'PENDING_APPROVAL' };
  }

  /**
   * ADM-005 acceptance criterion: "Maker не approve собственную action."
   * Approval posts the PAYOUT ledger entry, which is the moment the
   * obligation leaves the seller's balance.
   */
  async approve(
    batchId: string,
    actor: AuthenticatedActor,
    decision: { approve: boolean; note?: string; paymentReference?: string },
  ): Promise<{ status: PayoutBatchStatus; ledgerEntryId: string | null }> {
    if (!actor.adminUserId) throw AppError.forbidden('Only an admin may approve a payout');

    const batch = await this.prisma.payoutBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw AppError.notFound('PayoutBatch', batchId);
    if (batch.status !== 'PENDING_APPROVAL') {
      throw AppError.conflict('CONFLICT', 'This batch is not awaiting approval', { status: batch.status });
    }
    if (batch.createdByAdminId === actor.adminUserId) {
      throw AppError.forbidden('The creator of a payout batch cannot approve it (ADM-005)', {
        rule: 'maker_checker',
      });
    }

    const approval = await this.prisma.approvalRequest.findFirst({
      where: { objectType: 'PayoutBatch', objectId: batchId, status: 'PENDING' },
    });

    if (!decision.approve) {
      await this.prisma.$transaction(async (tx) => {
        await tx.payoutBatch.update({
          where: { id: batchId },
          data: { status: 'REJECTED', rejectedReason: decision.note ?? null },
        });
        // Release the entries so a corrected batch can pick them up.
        await tx.ledgerEntry.updateMany({ where: { payoutBatchId: batchId }, data: { payoutBatchId: null } });
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
        action: 'payout.reject',
        objectType: 'PayoutBatch',
        objectId: batchId,
        reason: decision.note,
        severity: 'WARNING',
      });
      return { status: 'REJECTED', ledgerEntryId: null };
    }

    const entryId = await this.prisma.$transaction(async (tx) => {
      await tx.payoutBatch.update({
        where: { id: batchId },
        data: {
          status: 'SENT',
          approvedByAdminId: actor.adminUserId,
          approvedAt: new Date(),
          sentAt: new Date(),
          paymentReference: decision.paymentReference ?? null,
          controlTotalHash: sha256(`${batch.number}:${batch.netMinor.toString()}:${batch.sellerId}`),
        },
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

      if (batch.netMinor <= 0n) return null;
      return this.ledger.post(
        {
          event: 'PAYOUT',
          amount: money(batch.netMinor, batch.currency as Money['currency']),
          sellerId: batch.sellerId,
          payoutBatchId: batch.id,
          memo: `Payout ${batch.number}`,
          dedupeKey: `payout:${batch.id}`,
        },
        tx,
      );
    });

    await this.audit.record(actor, {
      action: 'payout.approve',
      objectType: 'PayoutBatch',
      objectId: batchId,
      after: { net: batch.netMinor.toString(), ledgerEntryId: entryId },
      severity: 'CRITICAL',
    });

    logger.info({ batchId, number: batch.number, net: batch.netMinor.toString() }, 'payout released');
    return { status: 'SENT', ledgerEntryId: entryId };
  }

  async markSettled(batchId: string, reference: string, actor: AuthenticatedActor) {
    const batch = await this.prisma.payoutBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw AppError.notFound('PayoutBatch', batchId);
    if (batch.status !== 'SENT') {
      throw AppError.conflict('CONFLICT', 'Only a sent batch can be settled', { status: batch.status });
    }
    await this.prisma.payoutBatch.update({
      where: { id: batchId },
      data: { status: 'SETTLED', settledAt: new Date(), paymentReference: reference },
    });
    await this.audit.record(actor, {
      action: 'payout.settle',
      objectType: 'PayoutBatch',
      objectId: batchId,
      after: { reference },
      severity: 'NOTICE',
    });
    return { status: 'SETTLED' as PayoutBatchStatus };
  }

  async list(options: { sellerId?: string; status?: PayoutBatchStatus[]; limit?: number; offset?: number }) {
    const where: Prisma.PayoutBatchWhereInput = {
      ...(options.sellerId ? { sellerId: options.sellerId } : {}),
      ...(options.status ? { status: { in: options.status } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.payoutBatch.count({ where }),
      this.prisma.payoutBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(options.limit ?? 25, 100),
        skip: options.offset ?? 0,
        include: {
          seller: { select: { displayName: true, legalName: true } },
          payoutAccount: { select: { bankName: true, accountNumberMasked: true } },
          _count: { select: { lines: true } },
        },
      }),
    ]);

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        number: row.number,
        sellerId: row.sellerId,
        sellerName: row.seller.displayName,
        status: row.status,
        periodFrom: row.periodFrom.toISOString(),
        periodTo: row.periodTo.toISOString(),
        gross: toMoney(row.grossMinor, row.currency),
        commission: toMoney(row.commissionMinor, row.currency),
        refunds: toMoney(row.refundsMinor, row.currency),
        adjustments: toMoney(row.adjustmentsMinor, row.currency),
        hold: toMoney(row.holdMinor, row.currency),
        reserve: toMoney(row.reserveMinor, row.currency),
        net: toMoney(row.netMinor, row.currency),
        lineCount: row._count.lines,
        account: row.payoutAccount
          ? `${row.payoutAccount.bankName} ${row.payoutAccount.accountNumberMasked}`
          : null,
        createdAt: row.createdAt.toISOString(),
        approvedAt: row.approvedAt?.toISOString() ?? null,
      })),
    };
  }

  /** SEL-006: the statement a seller sees, drilling down to the OrderItem. */
  async batchDetail(batchId: string, sellerId?: string) {
    const batch = await this.prisma.payoutBatch.findFirst({
      where: { id: batchId, ...(sellerId ? { sellerId } : {}) },
      include: {
        seller: { select: { displayName: true, legalName: true } },
        payoutAccount: true,
        lines: { orderBy: { id: 'asc' } },
      },
    });
    if (!batch) throw AppError.notFound('PayoutBatch', batchId);

    const orderItemIds = batch.lines.map((line) => line.orderItemId).filter(Boolean) as string[];
    const items = await this.prisma.orderItem.findMany({
      where: { id: { in: orderItemIds } },
      select: {
        id: true,
        productTitle: true,
        brandName: true,
        sizeLabel: true,
        quantity: true,
        unitPriceMinor: true,
        commissionMinor: true,
        sellerPayableMinor: true,
        currency: true,
        order: { select: { number: true, placedAt: true } },
      },
    });
    const byId = new Map(items.map((item) => [item.id, item]));

    return {
      id: batch.id,
      number: batch.number,
      status: batch.status,
      seller: batch.seller,
      period: { from: batch.periodFrom.toISOString(), to: batch.periodTo.toISOString() },
      totals: {
        gross: toMoney(batch.grossMinor, batch.currency),
        commission: toMoney(batch.commissionMinor, batch.currency),
        refunds: toMoney(batch.refundsMinor, batch.currency),
        adjustments: toMoney(batch.adjustmentsMinor, batch.currency),
        hold: toMoney(batch.holdMinor, batch.currency),
        reserve: toMoney(batch.reserveMinor, batch.currency),
        net: toMoney(batch.netMinor, batch.currency),
      },
      controlTotalHash: batch.controlTotalHash,
      lines: batch.lines.map((line) => {
        const item = line.orderItemId ? byId.get(line.orderItemId) : null;
        return {
          id: line.id,
          kind: line.kind,
          amount: toMoney(line.amountMinor, line.currency),
          memo: line.memo,
          orderNumber: item?.order.number ?? null,
          placedAt: item?.order.placedAt?.toISOString() ?? null,
          item: item
            ? {
                title: item.productTitle,
                brand: item.brandName,
                size: item.sizeLabel,
                quantity: item.quantity,
                unitPrice: toMoney(item.unitPriceMinor, item.currency),
                commission: toMoney(item.commissionMinor, item.currency),
                payable: toMoney(item.sellerPayableMinor, item.currency),
              }
            : null,
        };
      }),
    };
  }

  /** Sellers whose available balance is worth a batch, for the scheduler. */
  async sellersDueForPayout(): Promise<Array<{ sellerId: string; displayName: string; available: Money }>> {
    const sellers = await this.prisma.seller.findMany({
      where: { onboardingStatus: 'ACTIVE' },
      select: { id: true, displayName: true, currency: true, payoutScheduleDays: true },
    });
    const out: Array<{ sellerId: string; displayName: string; available: Money }> = [];
    for (const seller of sellers) {
      const balance = await this.ledger.sellerBalance(seller.id, seller.currency);
      if (toBigInt(balance.availableForPayout) > 0n) {
        out.push({
          sellerId: seller.id,
          displayName: seller.displayName,
          available: balance.availableForPayout,
        });
      }
    }
    return out;
  }
}
