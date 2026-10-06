/**
 * Mock payment provider.
 *
 * This release ships with payments switched off at the business level: the
 * §8.4 decisions (merchant of record, seller on the receipt, commission base,
 * split vs platform settlement, fiscalisation) are not signed off, and no PSP
 * contract or certification exists yet. Until then, charging a real card would
 * be the one thing the spec explicitly forbids before sign-off.
 *
 * So instead of stubbing payments out and leaving the money model untested,
 * this adapter implements the full internal contract — init, callback, status,
 * capture, partial refund, failure and cancellation — against an in-memory
 * provider. Everything downstream is therefore exercised for real:
 * reservations become allocations, the 10% commission and seller payable are
 * posted per OrderItem, refunds reverse proportionally, reconciliation matches,
 * and payouts batch. Swapping in Payme/CLICK/Uzum later changes this file's
 * sibling, not the order domain (PAY-001).
 *
 * It refuses to run with PAYMENTS_LIVE=true so it can never be mistaken for a
 * real acquirer in production.
 */

import { type Money, money, toBigInt } from '@fashion/core';
import { hmacHex, randomToken, verifyHmac } from '../../common/crypto';
import { loadConfig } from '../../common/config';
import { logger } from '../../common/logger';
import {
  type CapturePaymentResult,
  type InitPaymentRequest,
  type InitPaymentResult,
  type PaymentProvider,
  type ProviderCapabilities,
  type ProviderStatusResult,
  ProviderError,
  type RefundRequest,
  type RefundResult,
  type WebhookContext,
  type WebhookVerification,
} from './provider.interface';

interface MockRecord {
  providerPaymentId: string;
  paymentId: string;
  orderNumber: string;
  amount: Money;
  status: ProviderStatusResult['status'];
  refunded: bigint;
  providerReference: string | null;
  createdAt: Date;
  expiresAt: Date;
  method: string;
  cardMask: string;
}

/** Simulated provider fee, so PAY-015 is exercised end to end. */
const MOCK_PSP_FEE_BPS = 150;

export class MockPaymentProvider implements PaymentProvider {
  readonly code = 'mock' as const;
  readonly displayName = 'Sandbox (no real money)';
  readonly capabilities: ProviderCapabilities = {
    nativeSplit: true,
    partialRefund: true,
    fiscalization: true,
    hostedCheckout: true,
    tokenization: false,
    twoStep: false,
    supportedMethods: ['uzcard', 'humo', 'visa', 'mastercard'],
  };
  readonly enabled = true;
  readonly live = false;

  private readonly config = loadConfig();
  private readonly records = new Map<string, MockRecord>();

  constructor() {
    if (this.config.PAYMENTS_LIVE) {
      throw new Error(
        'MockPaymentProvider cannot be used with PAYMENTS_LIVE=true. Configure a real PSP adapter.',
      );
    }
  }

  async init(request: InitPaymentRequest): Promise<InitPaymentResult> {
    const providerPaymentId = `mock_${randomToken(12)}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000);

    this.records.set(providerPaymentId, {
      providerPaymentId,
      paymentId: request.paymentId,
      orderNumber: request.orderNumber,
      amount: request.amount,
      status: 'PENDING',
      refunded: 0n,
      providerReference: null,
      createdAt: new Date(),
      expiresAt,
      method: 'uzcard',
      cardMask: '8600 •••• •••• 1234',
    });

    // The hosted "form" is served by the API itself, so the Mini App flow is
    // identical to a real PSP redirect: leave, pay, come back.
    const url = new URL(`${this.config.API_PUBLIC_URL}/payments/mock/checkout`);
    url.searchParams.set('pid', providerPaymentId);
    url.searchParams.set('amount', request.amount.amount);
    url.searchParams.set('currency', request.amount.currency);
    url.searchParams.set('order', request.orderNumber);
    url.searchParams.set('return', request.returnUrl);
    url.searchParams.set('locale', request.locale);

    logger.info(
      { providerPaymentId, orderNumber: request.orderNumber, amount: request.amount.amount },
      'mock payment initialised (no real money)',
    );

    return {
      providerPaymentId,
      paymentUrl: url.toString(),
      status: 'PENDING',
      expiresAt,
      clientPayload: {
        sandbox: true,
        notice: 'Sandbox provider: no card is charged.',
        splits: request.splits?.map((split) => ({
          sellerId: split.sellerId,
          amount: split.amount.amount,
        })),
      },
    };
  }

  async capture(providerPaymentId: string, amount: Money): Promise<CapturePaymentResult> {
    const record = this.records.get(providerPaymentId);
    if (!record) throw new ProviderError('mock', 'Unknown provider payment id');
    record.status = 'CAPTURED';
    record.providerReference = `MOCKREF-${randomToken(6).toUpperCase()}`;
    return {
      status: 'CAPTURED',
      capturedAmount: amount,
      providerReference: record.providerReference,
      pspFee: this.fee(amount),
      method: record.method,
      cardMask: record.cardMask,
    };
  }

  async status(providerPaymentId: string): Promise<ProviderStatusResult> {
    const record = this.records.get(providerPaymentId);
    if (!record) {
      // A restart loses the in-memory record. Reporting PENDING rather than
      // inventing a success is the honest answer, and reconciliation picks it up.
      return {
        status: 'PENDING',
        paidAmount: null,
        providerReference: null,
        failureCode: 'UNKNOWN_SESSION',
        failureMessage: 'Sandbox session is not in memory (provider restarted)',
      };
    }
    if (record.status === 'PENDING' && record.expiresAt < new Date()) {
      record.status = 'EXPIRED';
    }
    return {
      status: record.status,
      paidAmount: record.status === 'CAPTURED' ? record.amount : null,
      providerReference: record.providerReference,
      pspFee: record.status === 'CAPTURED' ? this.fee(record.amount) : null,
      method: record.method,
      cardMask: record.cardMask,
    };
  }

  async cancel(providerPaymentId: string, reason: string): Promise<{ cancelled: boolean }> {
    const record = this.records.get(providerPaymentId);
    if (!record) return { cancelled: false };
    if (record.status === 'CAPTURED') {
      throw new ProviderError('mock', 'Cannot cancel a captured payment; issue a refund instead');
    }
    record.status = 'CANCELLED';
    logger.info({ providerPaymentId, reason }, 'mock payment cancelled');
    return { cancelled: true };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const record = this.records.get(request.providerPaymentId);
    if (!record) {
      return {
        status: 'FAILED',
        providerRefundId: null,
        providerReference: null,
        failureMessage: 'Sandbox session is not in memory (provider restarted)',
      };
    }
    if (record.status !== 'CAPTURED' && record.status !== 'REFUNDED') {
      return {
        status: 'FAILED',
        providerRefundId: null,
        providerReference: null,
        failureMessage: `Cannot refund a payment in status ${record.status}`,
      };
    }

    const amount = toBigInt(request.amount);
    const total = toBigInt(record.amount);
    if (record.refunded + amount > total) {
      return {
        status: 'FAILED',
        providerRefundId: null,
        providerReference: null,
        failureMessage: 'Refund exceeds the captured amount',
      };
    }

    record.refunded += amount;
    if (record.refunded >= total) record.status = 'REFUNDED';

    return {
      status: 'COMPLETED',
      providerRefundId: `mockref_${randomToken(10)}`,
      providerReference: record.providerReference,
    };
  }

  /**
   * PAY-004: the callback carries an HMAC over the raw body plus an event id,
   * so a replay is detectable and a forged body fails verification — the same
   * properties a real provider's signature gives us.
   */
  verifyWebhook(context: WebhookContext): WebhookVerification {
    const signature = headerValue(context.headers, 'x-mock-signature');
    const eventId = headerValue(context.headers, 'x-mock-event-id');
    const secret = this.config.MOCK_PAYMENT_WEBHOOK_SECRET;

    const body = (context.parsedBody ?? {}) as {
      providerPaymentId?: string;
      paymentId?: string;
      event?: string;
      status?: string;
      amount?: string;
      currency?: string;
      reason?: string;
    };

    const valid =
      Boolean(signature) && Boolean(secret) && verifyHmac(context.rawBody, secret, signature!);

    if (!valid) {
      return {
        valid: false,
        externalEventId: eventId ?? `invalid_${Date.now()}`,
        eventType: body.event ?? 'unknown',
        providerPaymentId: body.providerPaymentId ?? null,
        paymentId: body.paymentId ?? null,
        amount: null,
        status: null,
        providerReference: null,
        responseBody: { ok: false, error: 'invalid signature' },
      };
    }

    const record = body.providerPaymentId ? this.records.get(body.providerPaymentId) : undefined;
    const status = normalizeStatus(body.status);
    if (record && status) {
      record.status = status;
      if (status === 'CAPTURED' && !record.providerReference) {
        record.providerReference = `MOCKREF-${randomToken(6).toUpperCase()}`;
      }
    }

    const amount =
      body.amount && body.currency
        ? money(body.amount, body.currency as Money['currency'])
        : (record?.amount ?? null);

    return {
      valid: true,
      externalEventId: eventId ?? `mock_${body.providerPaymentId}_${body.status}`,
      eventType: body.event ?? 'payment.status',
      providerPaymentId: body.providerPaymentId ?? null,
      paymentId: body.paymentId ?? record?.paymentId ?? null,
      amount,
      status,
      providerReference: record?.providerReference ?? null,
      reason: body.reason ?? null,
      responseBody: { ok: true },
    };
  }

  // ─────────────────────────── sandbox-only helpers (not part of the contract)

  /** Signature the sandbox checkout page uses when it calls the webhook. */
  signPayload(payload: string): string {
    return hmacHex(payload, this.config.MOCK_PAYMENT_WEBHOOK_SECRET);
  }

  peek(providerPaymentId: string): MockRecord | undefined {
    return this.records.get(providerPaymentId);
  }

  /** Lets the sandbox page and the e2e test drive a success or a failure. */
  force(providerPaymentId: string, status: ProviderStatusResult['status']): boolean {
    const record = this.records.get(providerPaymentId);
    if (!record) return false;
    record.status = status;
    if (status === 'CAPTURED' && !record.providerReference) {
      record.providerReference = `MOCKREF-${randomToken(6).toUpperCase()}`;
    }
    return true;
  }

  private fee(amount: Money): Money {
    return money((toBigInt(amount) * BigInt(MOCK_PSP_FEE_BPS)) / 10_000n, amount.currency);
  }
}

function normalizeStatus(value: string | undefined): ProviderStatusResult['status'] | null {
  switch ((value ?? '').toLowerCase()) {
    case 'paid':
    case 'captured':
    case 'success':
      return 'CAPTURED';
    case 'authorized':
      return 'AUTHORIZED';
    case 'failed':
    case 'error':
      return 'FAILED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'expired':
      return 'EXPIRED';
    case 'refunded':
      return 'REFUNDED';
    case 'pending':
      return 'PENDING';
    default:
      return null;
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
