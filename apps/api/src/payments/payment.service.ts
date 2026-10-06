/**
 * Payment orchestrator — spec §8.3.
 *
 * PAY-001 Providers are adapters behind one internal contract; the order
 *         domain never branches on provider.
 * PAY-004 Callbacks are verified, deduplicated and replay-safe (ProviderEvent
 *         has a unique (provider, externalEventId), and the ledger has its own
 *         dedupe key, so UAT-10 holds at both layers).
 * PAY-005 The provider amount is compared with the internal order amount; a
 *         mismatch goes to reconciliation and the order does NOT become paid
 *         (UAT-15).
 * PAY-013 Two settlement modes — native split or platform settlement.
 * PAY-016 A fiscal reference is stored for the sale.
 * PAY-018 Failover happens before a transaction starts; a second charge
 *         requires a user action.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type PaymentStatus } from '@prisma/client';
import {
  type Locale,
  type Money,
  assertTransition,
  compare,
  money,
  subtract,
  toBigInt,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { toMinor, toMoney } from '../common/money.util';
import { AuditService } from '../common/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrdersService } from '../orders/orders.service';
import { LedgerService } from '../finance/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  type PaymentProvider,
  type ProviderCode,
  ProviderError,
  type WebhookContext,
} from './providers/provider.interface';
import { PAYMENT_PROVIDERS } from './providers/registry';

export interface InitPaymentInput {
  readonly userId: string;
  readonly orderId: string;
  readonly provider?: ProviderCode;
  readonly locale: Locale;
  readonly returnUrl?: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface InitPaymentOutput {
  readonly paymentId: string;
  readonly provider: ProviderCode;
  readonly status: PaymentStatus;
  readonly paymentUrl: string | null;
  readonly amount: Money;
  readonly expiresAt: string | null;
  readonly clientPayload: Record<string, unknown> | null;
  /** False in this release: the sandbox provider moves no real money. */
  readonly live: boolean;
}

@Injectable()
export class PaymentService {
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProvider[],
  ) {}

  /** The methods the Mini App may offer right now (PAY-002). */
  listMethods(): Array<{
    code: ProviderCode;
    name: string;
    enabled: boolean;
    live: boolean;
    methods: string[];
    nativeSplit: boolean;
  }> {
    return this.providers
      .filter((provider) => this.config.PAYMENT_PROVIDERS.includes(provider.code))
      .map((provider) => ({
        code: provider.code,
        name: provider.displayName,
        enabled: provider.enabled,
        live: provider.live,
        methods: provider.capabilities.supportedMethods,
        nativeSplit: provider.capabilities.nativeSplit,
      }));
  }

  private resolveProvider(code?: ProviderCode): PaymentProvider {
    if (!this.config.PAYMENTS_ENABLED) {
      throw new AppError('PAYMENT_UNAVAILABLE', { message: 'Payments are disabled on this deployment' });
    }
    const allowed = this.providers.filter(
      (provider) => provider.enabled && this.config.PAYMENT_PROVIDERS.includes(provider.code),
    );
    if (allowed.length === 0) {
      throw new AppError('PAYMENT_UNAVAILABLE', {
        message: 'No payment provider is configured',
        details: { configured: this.config.PAYMENT_PROVIDERS },
      });
    }
    if (code) {
      const chosen = allowed.find((provider) => provider.code === code);
      if (!chosen) {
        throw new AppError('PAYMENT_UNAVAILABLE', {
          message: `Provider ${code} is not available`,
          details: { available: allowed.map((provider) => provider.code) },
        });
      }
      return chosen;
    }
    // PAY-018: the choice happens before a transaction exists, so picking the
    // first healthy provider here can never double-charge.
    return allowed[0]!;
  }

  providerByCode(code: string): PaymentProvider | null {
    return this.providers.find((provider) => provider.code === code) ?? null;
  }

  /**
   * ORD-006/PAY-018: initialise a payment for an order. Idempotent at the
   * service level too — re-initialising an order that already has a live
   * payment returns the same payment rather than creating a second one.
   */
  async init(input: InitPaymentInput): Promise<InitPaymentOutput> {
    const order = await this.prisma.order.findFirst({
      where: { id: input.orderId, userId: input.userId },
      include: {
        payments: { orderBy: { createdAt: 'desc' } },
        subOrders: {
          select: {
            sellerId: true,
            payableTotalMinor: true,
            seller: { select: { settlementMode: true, payoutAccounts: { take: 1 } } },
          },
        },
      },
    });
    if (!order) throw AppError.notFound('Order', input.orderId);

    if (order.status === 'PAID' || order.paidAt) {
      throw AppError.conflict('CONFLICT', 'This order is already paid');
    }
    if (!['AWAITING_PAYMENT', 'PAYMENT_FAILED', 'QUOTED'].includes(order.status)) {
      throw AppError.conflict('ILLEGAL_STATE_TRANSITION', 'This order cannot be paid in its current status', {
        status: order.status,
      });
    }

    // The stock hold must still be alive, or we would charge for stock we no
    // longer have (CAT-008).
    const heldCount = await this.prisma.reservation.count({
      where: { orderId: order.id, status: 'HELD', expiresAt: { gt: new Date() } },
    });
    if (heldCount === 0) {
      throw new AppError('RESERVATION_EXPIRED', {
        message: 'The stock hold for this order expired — please rebuild your cart',
      });
    }

    const live = order.payments.find((payment) =>
      ['CREATED', 'PENDING', 'AUTHORIZED'].includes(payment.status),
    );
    if (live && live.expiresAt && live.expiresAt > new Date()) {
      return {
        paymentId: live.id,
        provider: live.provider as ProviderCode,
        status: live.status,
        paymentUrl: live.paymentUrl,
        amount: toMoney(live.amountMinor, live.currency),
        expiresAt: live.expiresAt?.toISOString() ?? null,
        clientPayload: null,
        live: this.providerByCode(live.provider)?.live ?? false,
      };
    }

    const provider = this.resolveProvider(input.provider);
    const currency = order.currency as Money['currency'];
    const amount = money(order.grandTotalMinor, currency);

    // PAY-013: in native-split mode the per-seller shares go to the provider;
    // in platform-settlement mode the ledger computes obligations and payouts
    // settle later.
    const useNativeSplit =
      provider.capabilities.nativeSplit &&
      order.subOrders.every((subOrder) => subOrder.seller.settlementMode === 'NATIVE_SPLIT');

    const payment = await this.prisma.payment.create({
      data: {
        orderId: order.id,
        provider: provider.code,
        status: 'CREATED',
        amountMinor: order.grandTotalMinor,
        currency,
        idempotencyKey: `${input.idempotencyKey}:${provider.code}`,
        settlementMode: useNativeSplit ? 'NATIVE_SPLIT' : 'PLATFORM_SETTLEMENT',
        pspFeeBearer: 'PLATFORM',
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });

    try {
      const result = await provider.init({
        paymentId: payment.id,
        orderId: order.id,
        orderNumber: order.number,
        amount,
        description: `Order ${order.number}`,
        locale: input.locale,
        returnUrl: input.returnUrl ?? `${this.config.MINIAPP_PUBLIC_URL}/orders/${order.id}`,
        callbackUrl: `${this.config.API_PUBLIC_URL}/payments/webhook/${provider.code}`,
        splits: useNativeSplit
          ? order.subOrders.map((subOrder) => ({
              sellerId: subOrder.sellerId,
              externalAccountId: subOrder.seller.payoutAccounts[0]?.id ?? null,
              amount: money(subOrder.payableTotalMinor, currency),
            }))
          : undefined,
        customer: { userId: input.userId },
        idempotencyKey: payment.idempotencyKey!,
      });

      const updated = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerPaymentId: result.providerPaymentId,
          paymentUrl: result.paymentUrl,
          status: result.status === 'CAPTURED' ? 'CAPTURED' : result.status === 'FAILED' ? 'FAILED' : 'PENDING',
          expiresAt: result.expiresAt ?? payment.expiresAt,
        },
      });

      await this.prisma.transaction.create({
        data: {
          paymentId: payment.id,
          kind: 'INIT',
          status: result.status,
          amountMinor: order.grandTotalMinor,
          currency,
          providerTransactionId: result.providerPaymentId,
          rawResponse: safeJson(result.raw),
          correlationId: input.correlationId ?? null,
        },
      });

      logger.info(
        { paymentId: payment.id, provider: provider.code, orderNumber: order.number, live: provider.live },
        'payment initialised',
      );

      return {
        paymentId: updated.id,
        provider: provider.code,
        status: updated.status,
        paymentUrl: updated.paymentUrl,
        amount,
        expiresAt: updated.expiresAt?.toISOString() ?? null,
        clientPayload: (result.clientPayload as Record<string, unknown> | null) ?? null,
        live: provider.live,
      };
    } catch (error) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          failureCode: error instanceof ProviderError ? (error.providerCode ?? 'PROVIDER_ERROR') : 'INIT_FAILED',
          failureMessage: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
        },
      });
      if (error instanceof ProviderError) {
        throw new AppError('PAYMENT_UNAVAILABLE', {
          message: error.message,
          details: { provider: error.provider, retryable: error.retryable },
        });
      }
      throw error;
    }
  }

  /**
   * PAY-004: the single entry point for every inbound callback. Verification,
   * dedupe and the response body all come from the adapter, so each provider's
   * protocol quirks stay in its own file.
   */
  async handleWebhook(
    providerCode: string,
    context: WebhookContext,
  ): Promise<{ status: number; body: unknown }> {
    const provider = this.providerByCode(providerCode);
    if (!provider) {
      logger.warn({ providerCode }, 'webhook for unknown provider');
      return { status: 404, body: { error: 'unknown provider' } };
    }

    const verification = provider.verifyWebhook(context);

    // Record every callback, valid or not: an invalid one is a security signal.
    let eventRow: { id: string; processedAt: Date | null } | null = null;
    try {
      eventRow = await this.prisma.providerEvent.create({
        data: {
          provider: provider.code,
          externalEventId: verification.externalEventId,
          eventType: verification.eventType,
          signatureValid: verification.valid,
          payload: safeJson(context.parsedBody) ?? {},
          headers: safeJson(redactHeaders(context.headers)) ?? {},
        },
        select: { id: true, processedAt: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // UAT-10: a replay. Acknowledge so the provider stops retrying, and
        // change nothing.
        logger.info(
          { provider: provider.code, externalEventId: verification.externalEventId },
          'duplicate provider callback ignored',
        );
        return { status: 200, body: verification.responseBody ?? { ok: true, duplicate: true } };
      }
      throw error;
    }

    if (!verification.valid) {
      await this.prisma.alert.create({
        data: {
          code: 'PAYMENT_WEBHOOK_INVALID_SIGNATURE',
          severity: 'CRITICAL',
          title: `Invalid ${provider.code} callback signature`,
          description: 'A callback failed signature verification and was rejected.',
          objectType: 'ProviderEvent',
          objectId: eventRow.id,
        },
      });
      await this.prisma.providerEvent.update({
        where: { id: eventRow.id },
        data: { processedAt: new Date(), processingError: 'invalid signature' },
      });
      return { status: 401, body: verification.responseBody ?? { error: 'invalid signature' } };
    }

    try {
      await this.applyProviderStatus({
        provider: provider.code,
        providerPaymentId: verification.providerPaymentId,
        paymentId: verification.paymentId,
        status: verification.status,
        amount: verification.amount,
        providerReference: verification.providerReference,
        failureMessage: verification.failureMessage ?? null,
        eventId: eventRow.id,
      });
      await this.prisma.providerEvent.update({
        where: { id: eventRow.id },
        data: { processedAt: new Date() },
      });
      return { status: 200, body: verification.responseBody ?? { ok: true } };
    } catch (error) {
      await this.prisma.providerEvent.update({
        where: { id: eventRow.id },
        data: {
          processedAt: new Date(),
          processingError: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
        },
      });
      logger.error({ err: error, provider: provider.code }, 'failed to process provider callback');
      // A 500 makes the provider retry, which is what we want for a transient
      // failure — the dedupe key makes the retry safe.
      return { status: 500, body: { error: 'processing failed' } };
    }
  }

  /**
   * The state machine for money. Called from webhooks, from a status poll and
   * from the sandbox page, so all three paths share one implementation.
   */
  async applyProviderStatus(input: {
    provider: string;
    providerPaymentId: string | null;
    paymentId: string | null;
    status: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED' | null;
    amount: Money | null;
    providerReference: string | null;
    failureMessage?: string | null;
    pspFee?: Money | null;
    method?: string | null;
    cardMask?: string | null;
    eventId?: string;
  }): Promise<{ paymentStatus: PaymentStatus; orderStatus: string } | null> {
    if (!input.status) return null;

    const payment = await this.findPayment(input);
    if (!payment) {
      logger.warn(
        { provider: input.provider, providerPaymentId: input.providerPaymentId },
        'provider callback did not match a known payment',
      );
      // PAY-011: an unmatched provider record gets an owner and a workflow
      // rather than being dropped.
      await this.prisma.reconciliationRecord.create({
        data: {
          provider: input.provider,
          periodDate: startOfDay(new Date()),
          providerReference: input.providerReference ?? input.providerPaymentId,
          providerAmountMinor: input.amount ? toMinor(input.amount) : null,
          status: 'UNMATCHED_PROVIDER',
          notes: 'Callback did not match any internal payment',
        },
      });
      return null;
    }

    if (input.providerPaymentId && !payment.providerPaymentId) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: input.providerPaymentId },
      });
    }

    const currency = payment.currency as Money['currency'];
    const internalAmount = money(payment.amountMinor, currency);

    // ── PAY-005 / UAT-15: amount mismatch parks the payment.
    if (input.status === 'CAPTURED' && input.amount && compare(input.amount, internalAmount) !== 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'RECONCILIATION_HOLD',
            failureCode: 'AMOUNT_MISMATCH',
            failureMessage: `Provider reported ${input.amount!.amount}, internal amount is ${internalAmount.amount}`,
          },
        });
        await tx.reconciliationRecord.create({
          data: {
            provider: input.provider,
            periodDate: startOfDay(new Date()),
            paymentId: payment.id,
            providerReference: input.providerReference,
            internalAmountMinor: payment.amountMinor,
            providerAmountMinor: toMinor(input.amount!),
            currency,
            status: 'AMOUNT_MISMATCH',
            notes: 'Captured amount does not match the order total',
          },
        });
        await tx.alert.create({
          data: {
            code: 'PAYMENT_AMOUNT_MISMATCH',
            severity: 'CRITICAL',
            title: `Amount mismatch on payment ${payment.id}`,
            description: `Provider ${input.provider} reported a different amount than the order total.`,
            objectType: 'Payment',
            objectId: payment.id,
            context: {
              internal: payment.amountMinor.toString(),
              provider: input.amount!.amount,
            } as Prisma.InputJsonValue,
          },
        });
      });

      logger.error(
        {
          paymentId: payment.id,
          internal: payment.amountMinor.toString(),
          provider: input.amount.amount,
        },
        'payment amount mismatch — order not marked paid',
      );
      // The order deliberately does NOT become PAID.
      return { paymentStatus: 'RECONCILIATION_HOLD', orderStatus: payment.order.status };
    }

    const nextStatus = mapToPaymentStatus(input.status);
    if (payment.status === nextStatus) {
      return { paymentStatus: payment.status, orderStatus: payment.order.status };
    }
    try {
      assertTransition('payment', payment.status, nextStatus);
    } catch (error) {
      logger.warn(
        { paymentId: payment.id, from: payment.status, to: nextStatus },
        'ignoring out-of-order provider status',
      );
      return { paymentStatus: payment.status, orderStatus: payment.order.status };
    }

    if (nextStatus === 'CAPTURED') {
      return this.markCaptured(payment.id, {
        provider: input.provider,
        providerReference: input.providerReference,
        pspFee: input.pspFee ?? null,
        method: input.method ?? null,
        cardMask: input.cardMask ?? null,
      });
    }

    if (nextStatus === 'FAILED' || nextStatus === 'CANCELLED' || nextStatus === 'EXPIRED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: nextStatus,
            failureMessage: input.failureMessage?.slice(0, 500) ?? null,
          },
        });
        await tx.transaction.create({
          data: {
            paymentId: payment.id,
            kind: nextStatus,
            status: nextStatus,
            amountMinor: payment.amountMinor,
            currency,
            providerTransactionId: input.providerReference,
          },
        });
        // ORD-005: release the hold so the stock is sellable again.
        await this.inventory.releaseForOrder(payment.orderId, `payment_${nextStatus.toLowerCase()}`, tx);
        await this.orders.transitionOrder(
          payment.orderId,
          nextStatus === 'FAILED' ? 'PAYMENT_FAILED' : 'CANCELLED',
          { actorType: 'PROVIDER', note: input.failureMessage ?? nextStatus },
          tx,
        );
      });
      return { paymentStatus: nextStatus, orderStatus: nextStatus === 'FAILED' ? 'PAYMENT_FAILED' : 'CANCELLED' };
    }

    await this.prisma.payment.update({ where: { id: payment.id }, data: { status: nextStatus } });
    return { paymentStatus: nextStatus, orderStatus: payment.order.status };
  }

  /**
   * The capture path, which is where the money model actually happens:
   * allocate stock, post the 10% ledger entries per item, record the fiscal
   * reference, move the order, notify the shopper.
   */
  private async markCaptured(
    paymentId: string,
    details: {
      provider: string;
      providerReference: string | null;
      pspFee: Money | null;
      method: string | null;
      cardMask: string | null;
    },
  ): Promise<{ paymentStatus: PaymentStatus; orderStatus: string }> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: { order: { include: { subOrders: true } } },
        });
        if (payment.status === 'CAPTURED') {
          return { paymentStatus: payment.status, orderStatus: payment.order.status };
        }

        const currency = payment.currency as Money['currency'];
        const pspFeeMinor = details.pspFee ? toMinor(details.pspFee) : 0n;

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'CAPTURED',
            capturedMinor: payment.amountMinor,
            capturedAt: new Date(),
            providerReference: details.providerReference,
            // PAY-003: only a masked suffix, never a PAN.
            cardMask: details.cardMask,
            method: details.method,
            pspFeeMinor,
          },
        });

        await tx.transaction.create({
          data: {
            paymentId: payment.id,
            kind: 'CAPTURE',
            status: 'CAPTURED',
            amountMinor: payment.amountMinor,
            currency,
            providerTransactionId: details.providerReference,
          },
        });

        // CAT-008: the hold becomes a real decrement.
        await this.inventory.allocateForOrder(payment.orderId, tx);

        // PAY-006: one set of entries per OrderItem.
        await this.ledger.postSaleForOrder(
          payment.orderId,
          { paymentId: payment.id, pspFeeMinor },
          tx,
        );

        // PAY-016: a traceable fiscal reference for the sale. The real fiscal
        // document comes from the PSP once D-02 is settled; until then we
        // store our own reference so nothing is lost.
        await tx.fiscalReceipt.create({
          data: {
            orderId: payment.orderId,
            kind: 'SALE',
            provider: details.provider,
            fiscalId: details.providerReference,
            sellerOfRecord:
              payment.order.subOrders.length === 1 ? payment.order.subOrders[0]!.sellerId : 'PLATFORM_PENDING_D02',
            amountMinor: payment.amountMinor,
            currency,
            payload: {
              note: 'Fiscalisation route pending decision D-02 (seller on the receipt / fiscal issuer)',
              provider: details.provider,
            } as Prisma.InputJsonValue,
          },
        });

        await this.orders.transitionOrder(
          payment.orderId,
          'PAID',
          { actorType: 'PROVIDER', note: `Captured via ${details.provider}` },
          tx,
        );

        // FUL-004: the sellers' confirmation clock starts now.
        for (const subOrder of payment.order.subOrders) {
          if (subOrder.status === 'PENDING_CONFIRMATION') continue;
          await this.orders.transitionSubOrder(
            subOrder.id,
            'PENDING_CONFIRMATION',
            { actorType: 'SYSTEM', note: 'payment captured' },
            tx,
          );
        }

        return { paymentStatus: 'CAPTURED' as PaymentStatus, orderStatus: 'PAID' };
      },
      { timeout: 25_000 },
    );

    const order = await this.prisma.order.findUnique({
      where: { id: (await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).orderId },
      select: { id: true, number: true, userId: true, locale: true },
    });

    if (order) {
      // NTF-001: service notification with a deep link and minimal PII.
      await this.notifications
        .sendOrderNotification(order.userId, 'notify.payment_received', {
          orderNumber: order.number,
          orderId: order.id,
          locale: order.locale as Locale,
        })
        .catch((error) => logger.warn({ err: error }, 'payment notification failed'));

      await this.audit.record(
        { kind: 'service', roles: [], permissions: new Set() },
        {
          action: 'payment.captured',
          objectType: 'Payment',
          objectId: paymentId,
          after: { orderNumber: order.number, provider: details.provider },
          severity: 'NOTICE',
        },
      );
    }

    return result;
  }

  /** Buyer-initiated status poll after returning from the hosted page. */
  async syncStatus(userId: string, paymentId: string): Promise<{ status: PaymentStatus; orderStatus: string }> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, order: { userId } },
      include: { order: { select: { id: true, status: true } } },
    });
    if (!payment) throw AppError.notFound('Payment', paymentId);

    if (payment.status === 'CAPTURED') {
      return { status: payment.status, orderStatus: payment.order.status };
    }

    const provider = this.providerByCode(payment.provider);
    if (!provider || !payment.providerPaymentId) {
      return { status: payment.status, orderStatus: payment.order.status };
    }

    const status = await provider.status(payment.providerPaymentId);
    const applied = await this.applyProviderStatus({
      provider: payment.provider,
      providerPaymentId: payment.providerPaymentId,
      paymentId: payment.id,
      status: status.status,
      amount: status.paidAmount,
      providerReference: status.providerReference,
      pspFee: status.pspFee ?? null,
      method: status.method ?? null,
      cardMask: status.cardMask ?? null,
      failureMessage: status.failureMessage ?? null,
    });

    return {
      status: applied?.paymentStatus ?? payment.status,
      orderStatus: applied?.orderStatus ?? payment.order.status,
    };
  }

  async getPayment(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, order: { userId } },
      select: {
        id: true,
        provider: true,
        status: true,
        amountMinor: true,
        currency: true,
        paymentUrl: true,
        expiresAt: true,
        order: { select: { id: true, number: true, status: true } },
      },
    });
    if (!payment) throw AppError.notFound('Payment', paymentId);
    return {
      id: payment.id,
      provider: payment.provider,
      status: payment.status,
      amount: toMoney(payment.amountMinor, payment.currency),
      paymentUrl: payment.paymentUrl,
      expiresAt: payment.expiresAt?.toISOString() ?? null,
      order: payment.order,
      live: this.providerByCode(payment.provider)?.live ?? false,
    };
  }

  /** Remaining capturable/refundable amount, used by the refund service. */
  async refundableAmount(paymentId: string): Promise<Money> {
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const currency = payment.currency as Money['currency'];
    if (payment.status !== 'CAPTURED' && payment.status !== 'PARTIALLY_REFUNDED') {
      return zero(currency);
    }
    return subtract(money(payment.capturedMinor, currency), money(payment.refundedMinor, currency));
  }

  private async findPayment(input: { paymentId: string | null; providerPaymentId: string | null; provider: string }) {
    if (input.paymentId) {
      const byId = await this.prisma.payment.findUnique({
        where: { id: input.paymentId },
        include: { order: { select: { id: true, status: true } } },
      });
      if (byId) return byId;
    }
    if (input.providerPaymentId) {
      const byProvider = await this.prisma.payment.findFirst({
        where: { provider: input.provider, providerPaymentId: input.providerPaymentId },
        include: { order: { select: { id: true, status: true } } },
      });
      if (byProvider) return byProvider;
      // Some providers echo our own payment id as their reference.
      const byEcho = await this.prisma.payment.findFirst({
        where: { id: input.providerPaymentId },
        include: { order: { select: { id: true, status: true } } },
      });
      if (byEcho) return byEcho;
    }
    return null;
  }

  /** Expire stale payment attempts so the stock is not held forever. */
  async expireStalePayments(): Promise<number> {
    const stale = await this.prisma.payment.findMany({
      where: {
        status: { in: ['CREATED', 'PENDING'] },
        expiresAt: { lt: new Date() },
      },
      take: 200,
      select: { id: true, orderId: true },
    });

    for (const payment of stale) {
      await this.prisma
        .$transaction(async (tx) => {
          await tx.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' } });
          await this.inventory.releaseForOrder(payment.orderId, 'payment_expired', tx);
          const order = await tx.order.findUnique({
            where: { id: payment.orderId },
            select: { status: true },
          });
          if (order && order.status === 'AWAITING_PAYMENT') {
            await this.orders.transitionOrder(
              payment.orderId,
              'PAYMENT_FAILED',
              { actorType: 'SYSTEM', note: 'payment session expired' },
              tx,
            );
          }
        })
        .catch((error) => logger.warn({ err: error, paymentId: payment.id }, 'failed to expire payment'));
    }
    return stale.length;
  }
}

function mapToPaymentStatus(
  status: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED',
): PaymentStatus {
  switch (status) {
    case 'CAPTURED':
      return 'CAPTURED';
    case 'AUTHORIZED':
      return 'AUTHORIZED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'PENDING':
    default:
      return 'PENDING';
  }
}

function safeJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry)),
    ) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

/** §14.3: a stored callback must not keep its auth header. */
function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = ['authorization', 'cookie', 'x-api-key', 'x-signature'].includes(key.toLowerCase())
      ? '[redacted]'
      : value;
  }
  return out;
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
