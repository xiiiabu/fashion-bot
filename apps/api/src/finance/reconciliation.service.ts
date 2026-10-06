/**
 * Reconciliation — spec PAY-011 and ADM-009.
 *
 * "Ежедневная reconciliation internal transactions с provider reports/callbacks.
 *  Unmatched records имеют owner и workflow."
 *
 * Three classes of discrepancy are produced, each with its own queue:
 *  UNMATCHED_INTERNAL  we think it is paid, the provider never confirmed
 *  UNMATCHED_PROVIDER  the provider reported something we cannot place
 *  AMOUNT_MISMATCH     both sides exist but the amounts differ (PAY-005)
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type ReconciliationStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { toMoney } from '../common/money.util';
import { AuditService } from '../common/audit.service';
import type { AuthenticatedActor } from '../common/http';

export interface ReconciliationSummary {
  readonly periodDate: string;
  readonly provider: string;
  readonly matched: number;
  readonly unmatchedInternal: number;
  readonly unmatchedProvider: number;
  readonly amountMismatch: number;
  readonly internalTotalMinor: string;
  readonly providerTotalMinor: string;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The daily run. Compares captured payments against the provider events we
   * received for them; a real deployment also ingests the provider's own
   * statement file, which lands in the same records table.
   */
  async runDaily(date = new Date(), provider?: string): Promise<ReconciliationSummary[]> {
    const from = startOfDay(date);
    const to = new Date(from.getTime() + 86_400_000);

    const providers = provider
      ? [provider]
      : (
          await this.prisma.payment.groupBy({
            by: ['provider'],
            where: { createdAt: { gte: from, lt: to } },
          })
        ).map((group) => group.provider);

    const summaries: ReconciliationSummary[] = [];

    for (const providerCode of providers) {
      const payments = await this.prisma.payment.findMany({
        where: { provider: providerCode, createdAt: { gte: from, lt: to } },
        include: {
          providerEvents: { where: { signatureValid: true }, orderBy: { receivedAt: 'desc' } },
          order: { select: { number: true, grandTotalMinor: true } },
        },
      });

      let matched = 0;
      let unmatchedInternal = 0;
      let amountMismatch = 0;
      let internalTotal = 0n;
      let providerTotal = 0n;

      for (const payment of payments) {
        const existing = await this.prisma.reconciliationRecord.findFirst({
          where: { paymentId: payment.id, periodDate: from },
        });

        if (payment.status === 'CAPTURED') {
          internalTotal += payment.capturedMinor;
          const confirmed = payment.providerEvents.some((event) => event.processedAt != null);
          const amountMatches = payment.capturedMinor === payment.order.grandTotalMinor;

          let status: ReconciliationStatus;
          if (!confirmed) {
            // Captured without a verified callback: it came from a status poll
            // or the sandbox page. Worth a look, not necessarily wrong.
            status = 'UNMATCHED_INTERNAL';
            unmatchedInternal += 1;
          } else if (!amountMatches) {
            status = 'AMOUNT_MISMATCH';
            amountMismatch += 1;
          } else {
            status = 'MATCHED';
            matched += 1;
            providerTotal += payment.capturedMinor;
          }

          if (existing) {
            if (existing.status !== status && existing.status !== 'RESOLVED') {
              await this.prisma.reconciliationRecord.update({
                where: { id: existing.id },
                data: { status, providerAmountMinor: payment.capturedMinor },
              });
            }
          } else {
            await this.prisma.reconciliationRecord.create({
              data: {
                provider: providerCode,
                periodDate: from,
                paymentId: payment.id,
                providerReference: payment.providerReference,
                internalAmountMinor: payment.order.grandTotalMinor,
                providerAmountMinor: payment.capturedMinor,
                currency: payment.currency,
                status,
                notes:
                  status === 'UNMATCHED_INTERNAL'
                    ? 'Captured with no verified provider callback'
                    : status === 'AMOUNT_MISMATCH'
                      ? 'Captured amount differs from the order total'
                      : null,
              },
            });
          }
          continue;
        }

        if (payment.status === 'RECONCILIATION_HOLD') {
          amountMismatch += 1;
          internalTotal += payment.amountMinor;
        }
      }

      // Callbacks that never found a payment (already recorded by the
      // orchestrator) are counted here for the summary.
      const unmatchedProvider = await this.prisma.reconciliationRecord.count({
        where: { provider: providerCode, periodDate: from, status: 'UNMATCHED_PROVIDER' },
      });

      summaries.push({
        periodDate: from.toISOString().slice(0, 10),
        provider: providerCode,
        matched,
        unmatchedInternal,
        unmatchedProvider,
        amountMismatch,
        internalTotalMinor: internalTotal.toString(),
        providerTotalMinor: providerTotal.toString(),
      });

      // ADM-009: an unexplained discrepancy raises an alert with an owner.
      if (unmatchedInternal + unmatchedProvider + amountMismatch > 0) {
        await this.prisma.alert.create({
          data: {
            code: 'RECONCILIATION_DISCREPANCY',
            severity: amountMismatch > 0 ? 'CRITICAL' : 'WARNING',
            title: `${providerCode}: ${unmatchedInternal + unmatchedProvider + amountMismatch} unreconciled record(s)`,
            description: `For ${from.toISOString().slice(0, 10)}: ${unmatchedInternal} internal, ${unmatchedProvider} provider, ${amountMismatch} amount mismatch.`,
            objectType: 'ReconciliationRecord',
            context: { provider: providerCode, periodDate: from.toISOString() } as Prisma.InputJsonValue,
          },
        });
      }
    }

    logger.info({ summaries }, 'reconciliation completed');
    return summaries;
  }

  /** The finance queue: everything still open, oldest first. */
  async queue(options: { provider?: string; status?: ReconciliationStatus[]; limit?: number; offset?: number } = {}) {
    const where: Prisma.ReconciliationRecordWhereInput = {
      ...(options.provider ? { provider: options.provider } : {}),
      status: options.status
        ? { in: options.status }
        : { in: ['UNMATCHED_INTERNAL', 'UNMATCHED_PROVIDER', 'AMOUNT_MISMATCH'] },
    };

    const [total, rows] = await Promise.all([
      this.prisma.reconciliationRecord.count({ where }),
      this.prisma.reconciliationRecord.findMany({
        where,
        orderBy: [{ periodDate: 'asc' }, { createdAt: 'asc' }],
        take: Math.min(options.limit ?? 50, 200),
        skip: options.offset ?? 0,
        include: {
          payment: {
            select: {
              id: true,
              status: true,
              provider: true,
              order: { select: { id: true, number: true } },
            },
          },
        },
      }),
    ]);

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        periodDate: row.periodDate.toISOString().slice(0, 10),
        status: row.status,
        internalAmount: row.internalAmountMinor ? toMoney(row.internalAmountMinor, row.currency) : null,
        providerAmount: row.providerAmountMinor ? toMoney(row.providerAmountMinor, row.currency) : null,
        delta:
          row.internalAmountMinor != null && row.providerAmountMinor != null
            ? toMoney(row.providerAmountMinor - row.internalAmountMinor, row.currency)
            : null,
        providerReference: row.providerReference,
        orderNumber: row.payment?.order.number ?? null,
        orderId: row.payment?.order.id ?? null,
        paymentStatus: row.payment?.status ?? null,
        ownerAdminId: row.ownerAdminId,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** PAY-011: assigning an owner is part of the workflow, not a nicety. */
  async assign(recordId: string, adminUserId: string, actor: AuthenticatedActor) {
    const record = await this.prisma.reconciliationRecord.findUnique({ where: { id: recordId } });
    if (!record) throw AppError.notFound('ReconciliationRecord', recordId);
    await this.prisma.reconciliationRecord.update({
      where: { id: recordId },
      data: { ownerAdminId: adminUserId },
    });
    await this.audit.record(actor, {
      action: 'reconciliation.assign',
      objectType: 'ReconciliationRecord',
      objectId: recordId,
      after: { ownerAdminId: adminUserId },
    });
    return { ok: true };
  }

  async resolve(
    recordId: string,
    input: { resolution: string; releasePayment?: boolean },
    actor: AuthenticatedActor,
  ) {
    if (input.resolution.trim().length < 8) {
      throw AppError.validation('A resolution needs an explanation of at least 8 characters');
    }
    const record = await this.prisma.reconciliationRecord.findUnique({
      where: { id: recordId },
      include: { payment: true },
    });
    if (!record) throw AppError.notFound('ReconciliationRecord', recordId);

    await this.prisma.reconciliationRecord.update({
      where: { id: recordId },
      data: {
        status: 'RESOLVED',
        resolution: input.resolution,
        resolvedAt: new Date(),
        resolvedByAdminId: actor.adminUserId ?? null,
      },
    });

    await this.audit.record(actor, {
      action: 'reconciliation.resolve',
      objectType: 'ReconciliationRecord',
      objectId: recordId,
      after: { resolution: input.resolution, releasePayment: input.releasePayment ?? false },
      reason: input.resolution,
      severity: 'WARNING',
    });

    return {
      status: 'RESOLVED' as ReconciliationStatus,
      // Releasing a held payment is a separate, deliberate finance action: it
      // marks the order paid, so it is never a side effect of a note.
      note: input.releasePayment
        ? 'Use the payment release action to capture a held payment after resolving.'
        : null,
    };
  }

  /** Daily totals for the finance dashboard. */
  async dailySummary(days = 14) {
    const from = startOfDay(new Date(Date.now() - days * 86_400_000));
    const rows = await this.prisma.reconciliationRecord.groupBy({
      by: ['periodDate', 'status', 'provider'],
      where: { periodDate: { gte: from } },
      _count: { _all: true },
      _sum: { internalAmountMinor: true, providerAmountMinor: true },
    });

    const byDate = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const key = row.periodDate.toISOString().slice(0, 10);
      const entry = byDate.get(key) ?? {};
      entry[row.status] = (entry[row.status] ?? 0) + row._count._all;
      byDate.set(key, entry);
    }

    return [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, counts]) => ({
        date,
        matched: counts.MATCHED ?? 0,
        unmatchedInternal: counts.UNMATCHED_INTERNAL ?? 0,
        unmatchedProvider: counts.UNMATCHED_PROVIDER ?? 0,
        amountMismatch: counts.AMOUNT_MISMATCH ?? 0,
        resolved: counts.RESOLVED ?? 0,
      }));
  }

  /**
   * §17.1 MVP definition of done: "Provider reconciliation на тестовом периоде
   * не имеет необъяснённых расхождений." This is the check that proves it.
   */
  async unexplainedCount(from: Date, to: Date): Promise<number> {
    return this.prisma.reconciliationRecord.count({
      where: {
        periodDate: { gte: startOfDay(from), lte: startOfDay(to) },
        status: { in: ['UNMATCHED_INTERNAL', 'UNMATCHED_PROVIDER', 'AMOUNT_MISMATCH'] },
      },
    });
  }

  /** Ledger-to-order control total, run as an integrity check. */
  async verifyLedgerAgainstOrders(): Promise<{
    ok: boolean;
    orderCommissionMinor: string;
    ledgerCommissionMinor: string;
    deltaMinor: string;
  }> {
    const orders = await this.prisma.order.aggregate({
      where: { status: { notIn: ['DRAFT', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_FAILED', 'CANCELLED'] } },
      _sum: { commissionTotalMinor: true },
    });
    const ledger = await this.prisma.ledgerEntry.aggregate({
      where: { event: 'PLATFORM_COMMISSION' },
      _sum: { amountMinor: true },
    });

    const orderTotal = orders._sum.commissionTotalMinor ?? 0n;
    const ledgerTotal = ledger._sum.amountMinor ?? 0n;
    const delta = ledgerTotal - orderTotal;

    if (delta !== 0n) {
      logger.warn(
        { orderTotal: orderTotal.toString(), ledgerTotal: ledgerTotal.toString() },
        'order commission total differs from ledger commission total',
      );
    }

    return {
      // A non-zero delta is expected while an order is paid but a cancellation
      // has not yet been refunded, so this reports rather than asserts.
      ok: delta === 0n,
      orderCommissionMinor: orderTotal.toString(),
      ledgerCommissionMinor: ledgerTotal.toString(),
      deltaMinor: delta.toString(),
    };
  }
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
