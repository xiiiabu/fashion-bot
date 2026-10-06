/**
 * Uzum Bank adapter — spec PAY-002, §13.2 [S4][S5].
 *
 * Uzum's Merchant API is a conventional REST surface (create a payment, read
 * its status, refund it) with an API-key header and a signed webhook. Their
 * merchant material lists Uzcard, Humo, Visa and Mastercard acceptance, which
 * also makes this the natural route for PAY-002's Visa/Mastercard requirement
 * without the platform ever touching a PAN (PAY-003, SEC-010).
 *
 * Status in this release: NOT LIVE. Tariffs, settlement period and merchant
 * onboarding for this legal entity are unconfirmed (§15.3), so the adapter
 * stays disabled until UZUM_MERCHANT_ID and UZUM_SECRET_KEY are configured.
 * The HTTP calls below are written against the documented shape and go through
 * one `request` helper, so certification is a matter of pointing it at the
 * sandbox host rather than rewriting the flow.
 */

import { type Money, money, toBigInt } from '@fashion/core';
import { loadConfig } from '../../common/config';
import { logger } from '../../common/logger';
import { verifyHmac } from '../../common/crypto';
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

const UZUM_API_BASE = 'https://mapi.uzumbank.uz/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;

export class UzumPaymentProvider implements PaymentProvider {
  readonly code = 'uzum' as const;
  readonly displayName = 'Uzum Bank';
  readonly capabilities: ProviderCapabilities = {
    nativeSplit: false,
    partialRefund: true,
    fiscalization: true,
    hostedCheckout: true,
    tokenization: true,
    twoStep: false,
    supportedMethods: ['uzcard', 'humo', 'visa', 'mastercard'],
  };

  private readonly config = loadConfig();
  readonly enabled: boolean;
  readonly live: boolean;

  constructor() {
    this.enabled =
      this.config.UZUM_MERCHANT_ID.trim() !== '' && this.config.UZUM_SECRET_KEY.trim() !== '';
    this.live = this.enabled && this.config.PAYMENTS_LIVE;
    if (!this.enabled) {
      logger.info('uzum adapter registered but disabled (no UZUM_MERCHANT_ID / UZUM_SECRET_KEY)');
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ProviderError(
        'uzum',
        'Uzum Bank is not configured. Set UZUM_MERCHANT_ID and UZUM_SECRET_KEY once the merchant contract and certification are complete.',
        'NOT_CONFIGURED',
      );
    }
  }

  async init(request: InitPaymentRequest): Promise<InitPaymentResult> {
    this.assertEnabled();

    const response = await this.request<{
      paymentId: string;
      paymentUrl?: string;
      status?: string;
      expiresAt?: string;
    }>('POST', '/payment/create', {
      merchantId: this.config.UZUM_MERCHANT_ID,
      // Uzum expects the amount in tiyin, matching our minor unit.
      amount: Number(toBigInt(request.amount)),
      currency: request.amount.currency,
      orderId: request.orderNumber,
      description: request.description.slice(0, 255),
      successUrl: request.returnUrl,
      failureUrl: request.returnUrl,
      callbackUrl: request.callbackUrl,
      language: request.locale,
      // PAY-003: we send no card data; the shopper enters it on Uzum's page.
      clientReference: request.paymentId,
    }, request.idempotencyKey);

    return {
      providerPaymentId: response.paymentId,
      paymentUrl: response.paymentUrl ?? null,
      status: mapStatus(response.status) === 'CAPTURED' ? 'CAPTURED' : 'PENDING',
      expiresAt: response.expiresAt ? new Date(response.expiresAt) : null,
      raw: response,
    };
  }

  async capture(providerPaymentId: string, amount: Money): Promise<CapturePaymentResult> {
    this.assertEnabled();
    // Single-step provider: the hosted page captures. Reading status back is
    // the correct way to confirm, so capture delegates to it.
    const status = await this.status(providerPaymentId);
    return {
      status: status.status === 'CAPTURED' ? 'CAPTURED' : status.status === 'FAILED' ? 'FAILED' : 'PENDING',
      capturedAmount: status.paidAmount ?? amount,
      providerReference: status.providerReference,
      pspFee: status.pspFee ?? null,
      method: status.method ?? null,
      cardMask: status.cardMask ?? null,
    };
  }

  async status(providerPaymentId: string): Promise<ProviderStatusResult> {
    this.assertEnabled();
    const response = await this.request<{
      status?: string;
      paidAmount?: number;
      currency?: string;
      transactionId?: string;
      commission?: number;
      paymentMethod?: string;
      cardMask?: string;
      errorCode?: string;
      errorMessage?: string;
    }>('GET', `/payment/${encodeURIComponent(providerPaymentId)}/status`);

    return {
      status: mapStatus(response.status),
      paidAmount:
        typeof response.paidAmount === 'number'
          ? money(BigInt(Math.round(response.paidAmount)), (response.currency as Money['currency']) ?? 'UZS')
          : null,
      providerReference: response.transactionId ?? null,
      pspFee:
        typeof response.commission === 'number'
          ? money(BigInt(Math.round(response.commission)), (response.currency as Money['currency']) ?? 'UZS')
          : null,
      method: response.paymentMethod ?? null,
      cardMask: response.cardMask ?? null,
      failureCode: response.errorCode ?? null,
      failureMessage: response.errorMessage ?? null,
      raw: response,
    };
  }

  async cancel(providerPaymentId: string, reason: string): Promise<{ cancelled: boolean; raw?: unknown }> {
    this.assertEnabled();
    const response = await this.request<{ status?: string }>(
      'POST',
      `/payment/${encodeURIComponent(providerPaymentId)}/cancel`,
      { reason: reason.slice(0, 255) },
    );
    return { cancelled: mapStatus(response.status) === 'CANCELLED', raw: response };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.assertEnabled();
    try {
      const response = await this.request<{
        refundId?: string;
        status?: string;
        transactionId?: string;
        errorMessage?: string;
      }>(
        'POST',
        `/payment/${encodeURIComponent(request.providerPaymentId)}/refund`,
        {
          amount: Number(toBigInt(request.amount)),
          reason: request.reason.slice(0, 255),
          merchantRefundId: request.refundId,
        },
        request.idempotencyKey,
      );

      const status = (response.status ?? '').toUpperCase();
      return {
        status: status === 'SUCCESS' || status === 'COMPLETED' ? 'COMPLETED' : status === 'FAILED' ? 'FAILED' : 'PENDING',
        providerRefundId: response.refundId ?? null,
        providerReference: response.transactionId ?? null,
        failureMessage: response.errorMessage ?? null,
        raw: response,
      };
    } catch (error) {
      return {
        status: 'FAILED',
        providerRefundId: null,
        providerReference: null,
        failureMessage: error instanceof Error ? error.message : 'Uzum refund failed',
      };
    }
  }

  /** PAY-004: HMAC-SHA256 over the raw body, with the event id from a header. */
  verifyWebhook(context: WebhookContext): WebhookVerification {
    const signature = headerValue(context.headers, 'x-signature') ?? '';
    const eventId = headerValue(context.headers, 'x-event-id');
    const valid =
      this.enabled && signature !== '' && verifyHmac(context.rawBody, this.config.UZUM_SECRET_KEY, signature);

    const body = (context.parsedBody ?? {}) as {
      eventId?: string;
      eventType?: string;
      paymentId?: string;
      orderId?: string;
      clientReference?: string;
      status?: string;
      amount?: number;
      currency?: string;
      transactionId?: string;
      errorMessage?: string;
    };

    if (!valid) {
      return {
        valid: false,
        externalEventId: eventId ?? body.eventId ?? `uzum_unauthorized_${Date.now()}`,
        eventType: body.eventType ?? 'unknown',
        providerPaymentId: body.paymentId ?? null,
        paymentId: body.clientReference ?? null,
        amount: null,
        status: null,
        providerReference: null,
        responseBody: { accepted: false, reason: 'invalid signature' },
      };
    }

    return {
      valid: true,
      externalEventId: eventId ?? body.eventId ?? `uzum:${body.paymentId}:${body.status}`,
      eventType: body.eventType ?? 'payment.status',
      providerPaymentId: body.paymentId ?? null,
      paymentId: body.clientReference ?? null,
      amount:
        typeof body.amount === 'number'
          ? money(BigInt(Math.round(body.amount)), (body.currency as Money['currency']) ?? 'UZS')
          : null,
      status: mapStatus(body.status),
      providerReference: body.transactionId ?? null,
      failureMessage: body.errorMessage ?? null,
      responseBody: { accepted: true },
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${UZUM_API_BASE}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          // SEC-004: the key comes from the secrets manager via the env, and
          // is never logged — the redaction list covers `secretKey`/`apiKey`.
          'x-api-key': this.config.UZUM_SECRET_KEY,
          'x-merchant-id': this.config.UZUM_MERCHANT_ID,
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new ProviderError(
          'uzum',
          `Uzum API ${method} ${path} failed with ${response.status}`,
          String(response.status),
          response.status >= 500 || response.status === 429,
        );
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const retryable = error instanceof Error && error.name === 'AbortError';
      throw new ProviderError(
        'uzum',
        error instanceof Error ? error.message : 'Uzum request failed',
        'TRANSPORT',
        retryable,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapStatus(value: string | undefined): ProviderStatusResult['status'] {
  switch ((value ?? '').toUpperCase()) {
    case 'PAID':
    case 'SUCCESS':
    case 'COMPLETED':
    case 'CAPTURED':
      return 'CAPTURED';
    case 'AUTHORIZED':
    case 'HOLD':
      return 'AUTHORIZED';
    case 'FAILED':
    case 'ERROR':
    case 'DECLINED':
      return 'FAILED';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELLED';
    case 'EXPIRED':
    case 'TIMEOUT':
      return 'EXPIRED';
    case 'REFUNDED':
    case 'REVERSED':
      return 'REFUNDED';
    default:
      return 'PENDING';
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
