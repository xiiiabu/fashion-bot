/**
 * Payme Business adapter — spec PAY-002, integration matrix §13.2 [S2].
 *
 * Payme's Merchant API is a JSON-RPC surface the PSP calls on *us*
 * (CheckPerformTransaction, CreateTransaction, PerformTransaction,
 * CancelTransaction, CheckTransaction, GetStatement) plus a checkout URL we
 * send the shopper to. Authentication on the inbound side is a Basic header
 * carrying the merchant key.
 *
 * Status in this release: NOT LIVE. The adapter stays disabled until
 * PAYME_MERCHANT_ID and PAYME_SECRET_KEY exist, because the commercial terms
 * the spec lists as unconfirmed — tariffs, settlement period, merchant
 * onboarding, and whether marketplace split is available to this legal entity
 * — can only be settled by contract and sandbox certification (§8.4, §15.3
 * "Что пока нельзя подтвердить"). Leaving it disabled rather than guessing is
 * deliberate: a wrong split assumption is a financial defect, not a bug.
 */

import { type Money, money, toBigInt } from '@fashion/core';
import { constantTimeEqual } from '../../common/crypto';
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

/** Payme JSON-RPC error codes (negative, per their documentation). */
const PAYME_ERRORS = {
  TRANSPORT: -32300,
  PARSE: -32700,
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  CANNOT_PERFORM: -31008,
  ORDER_NOT_FOUND: -31050,
  UNAUTHORIZED: -32504,
} as const;

export class PaymePaymentProvider implements PaymentProvider {
  readonly code = 'payme' as const;
  readonly displayName = 'Payme';
  readonly capabilities: ProviderCapabilities = {
    // Payme documents distribution between the app owner and business
    // partners; whether it is enabled for this merchant is a contract matter.
    nativeSplit: true,
    partialRefund: true,
    fiscalization: true,
    hostedCheckout: true,
    tokenization: true,
    twoStep: true,
    supportedMethods: ['uzcard', 'humo'],
  };

  private readonly config = loadConfig();
  readonly enabled: boolean;
  readonly live: boolean;

  constructor() {
    this.enabled =
      this.config.PAYME_MERCHANT_ID.trim() !== '' && this.config.PAYME_SECRET_KEY.trim() !== '';
    this.live = this.enabled && this.config.PAYMENTS_LIVE;
    if (!this.enabled) {
      logger.info('payme adapter registered but disabled (no PAYME_MERCHANT_ID / PAYME_SECRET_KEY)');
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ProviderError(
        'payme',
        'Payme is not configured on this deployment. Set PAYME_MERCHANT_ID and PAYME_SECRET_KEY after the merchant contract and sandbox certification are complete.',
        'NOT_CONFIGURED',
      );
    }
  }

  /**
   * Payme's checkout is a GET to their host with a base64 parameter string.
   * `ac.order_id` is the account field the merchant cabinet is configured with;
   * it is what Payme echoes back in CheckPerformTransaction.
   */
  async init(request: InitPaymentRequest): Promise<InitPaymentResult> {
    this.assertEnabled();

    const params = [
      `m=${this.config.PAYME_MERCHANT_ID}`,
      `ac.order_id=${request.orderNumber}`,
      // Payme expects tiyin, which is already our minor unit (CAT-005).
      `a=${toBigInt(request.amount).toString()}`,
      `l=${request.locale === 'uz' ? 'uz' : request.locale === 'en' ? 'en' : 'ru'}`,
      `c=${request.returnUrl}`,
      `ct=${15 * 60 * 1000}`,
    ].join(';');

    const encoded = Buffer.from(params, 'utf8').toString('base64');
    return {
      // Payme creates the transaction itself and tells us via CreateTransaction,
      // so at init we only have our own reference to correlate on.
      providerPaymentId: request.paymentId,
      paymentUrl: `https://checkout.paycom.uz/${encoded}`,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
  }

  /** Payme performs the transaction on its side; we never initiate a capture. */
  async capture(providerPaymentId: string, amount: Money): Promise<CapturePaymentResult> {
    this.assertEnabled();
    void providerPaymentId;
    return {
      status: 'PENDING',
      capturedAmount: amount,
      providerReference: null,
      raw: { note: 'Payme captures via PerformTransaction callback' },
    };
  }

  async status(providerPaymentId: string): Promise<ProviderStatusResult> {
    this.assertEnabled();
    // CheckTransaction is a merchant-side method Payme calls on us; the
    // outbound direction uses the Subscribe API, which needs the contract's
    // credentials. Until then, reconciliation (PAY-011) is the source of truth.
    logger.warn({ providerPaymentId }, 'payme outbound status check is not wired (contract pending)');
    return {
      status: 'PENDING',
      paidAmount: null,
      providerReference: null,
      failureCode: 'NOT_IMPLEMENTED',
      failureMessage: 'Outbound status check requires Payme Subscribe API credentials',
    };
  }

  async cancel(providerPaymentId: string, reason: string): Promise<{ cancelled: boolean }> {
    this.assertEnabled();
    void providerPaymentId;
    void reason;
    return { cancelled: false };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.assertEnabled();
    // Payme reverses through CancelTransaction, which it initiates. A
    // merchant-initiated reversal needs the Subscribe API and the contractual
    // refund window, so this stays unimplemented rather than half-implemented.
    return {
      status: 'FAILED',
      providerRefundId: null,
      providerReference: null,
      failureMessage:
        'Payme refunds require the Subscribe API and the contractual reversal window (D-07). Process manually and record the reference.',
      raw: { refundId: request.refundId },
    };
  }

  /**
   * PAY-004: verify the Basic auth header Payme sends, then map the JSON-RPC
   * method onto our internal event. The response body shape matters: Payme
   * retries anything that is not a well-formed JSON-RPC result.
   */
  verifyWebhook(context: WebhookContext): WebhookVerification {
    const authorization = headerValue(context.headers, 'authorization') ?? '';
    const expected = `Basic ${Buffer.from(`Paycom:${this.config.PAYME_SECRET_KEY}`, 'utf8').toString('base64')}`;
    const valid = this.enabled && constantTimeEqual(authorization, expected);

    const body = (context.parsedBody ?? {}) as {
      id?: number | string;
      method?: string;
      params?: {
        id?: string;
        amount?: number;
        account?: { order_id?: string };
        reason?: number;
        time?: number;
      };
    };

    const rpcId = body.id ?? null;
    const method = body.method ?? 'unknown';
    const transactionId = body.params?.id ?? null;
    const orderNumber = body.params?.account?.order_id ?? null;

    if (!valid) {
      return {
        valid: false,
        externalEventId: `payme_unauthorized_${Date.now()}`,
        eventType: method,
        providerPaymentId: transactionId,
        paymentId: null,
        amount: null,
        status: null,
        providerReference: null,
        responseBody: {
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: PAYME_ERRORS.UNAUTHORIZED, message: 'Insufficient privileges' },
        },
      };
    }

    const amount =
      typeof body.params?.amount === 'number'
        ? money(BigInt(Math.round(body.params.amount)), 'UZS')
        : null;

    const status: ProviderStatusResult['status'] | null =
      method === 'PerformTransaction'
        ? 'CAPTURED'
        : method === 'CancelTransaction'
          ? 'REFUNDED'
          : method === 'CreateTransaction'
            ? 'PENDING'
            : null;

    return {
      valid: true,
      // Payme reuses its transaction id across the lifecycle, so the event id
      // must include the method or a Perform would dedupe against a Create.
      externalEventId: `payme:${transactionId ?? orderNumber ?? 'unknown'}:${method}`,
      eventType: method,
      providerPaymentId: transactionId,
      paymentId: null,
      amount,
      status,
      providerReference: transactionId,
      reason: body.params?.reason != null ? String(body.params.reason) : null,
      responseBody: {
        jsonrpc: '2.0',
        id: rpcId,
        result: { state: method === 'PerformTransaction' ? 2 : 1 },
      },
    };
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
