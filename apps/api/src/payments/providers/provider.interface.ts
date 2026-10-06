/**
 * Payment provider contract — spec PAY-001.
 *
 * "Payment Orchestrator использует provider adapters и единый internal
 *  contract. Provider можно добавить/выключить без изменения order domain."
 *
 * Everything below is provider-agnostic. Payme's Merchant API, CLICK's
 * Prepare/Complete pair and Uzum's checkout all map onto these five calls,
 * and the order domain never learns which one is in use.
 *
 * PAY-003: no adapter may accept or return a PAN or a CVV. The only card data
 * that crosses this boundary is a masked suffix the provider chose to share.
 */

import type { Money } from '@fashion/core';

export type ProviderCode = 'mock' | 'payme' | 'click' | 'uzum' | 'card';

export interface ProviderCapabilities {
  /** §8.4 model A: the PSP splits the payment between platform and sellers. */
  readonly nativeSplit: boolean;
  readonly partialRefund: boolean;
  readonly fiscalization: boolean;
  readonly hostedCheckout: boolean;
  readonly tokenization: boolean;
  /** Whether a capture step is separate from authorisation. */
  readonly twoStep: boolean;
  readonly supportedMethods: string[];
}

export interface InitPaymentRequest {
  readonly paymentId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly amount: Money;
  readonly description: string;
  readonly locale: string;
  readonly returnUrl: string;
  readonly callbackUrl: string;
  /** Used by native-split providers to address each seller's share. */
  readonly splits?: Array<{ sellerId: string; externalAccountId: string | null; amount: Money }>;
  readonly customer?: { userId: string; phone?: string | null };
  readonly idempotencyKey: string;
}

export interface InitPaymentResult {
  readonly providerPaymentId: string;
  /** Where the Mini App sends the shopper (hosted form, deep link, invoice). */
  readonly paymentUrl: string | null;
  /** Some providers need the client to render their own widget. */
  readonly clientPayload?: Record<string, unknown> | null;
  readonly status: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED';
  readonly expiresAt: Date | null;
  readonly raw?: unknown;
}

export interface CapturePaymentResult {
  readonly status: 'CAPTURED' | 'FAILED' | 'PENDING';
  readonly capturedAmount: Money;
  readonly providerReference: string | null;
  readonly pspFee?: Money | null;
  readonly method?: string | null;
  readonly cardMask?: string | null;
  readonly raw?: unknown;
}

export interface ProviderStatusResult {
  readonly status: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';
  readonly paidAmount: Money | null;
  readonly providerReference: string | null;
  readonly pspFee?: Money | null;
  readonly method?: string | null;
  readonly cardMask?: string | null;
  readonly failureCode?: string | null;
  readonly failureMessage?: string | null;
  readonly raw?: unknown;
}

export interface RefundRequest {
  readonly refundId: string;
  readonly paymentId: string;
  readonly providerPaymentId: string;
  readonly amount: Money;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface RefundResult {
  readonly status: 'COMPLETED' | 'PENDING' | 'FAILED';
  readonly providerRefundId: string | null;
  readonly providerReference: string | null;
  readonly failureMessage?: string | null;
  readonly raw?: unknown;
}

/** PAY-004: the parsed, verified shape of an inbound callback. */
export interface WebhookVerification {
  readonly valid: boolean;
  /** Provider-side unique id for this event; the dedupe key. */
  readonly externalEventId: string;
  readonly eventType: string;
  readonly providerPaymentId: string | null;
  /** Our payment id, when the provider echoes it back. */
  readonly paymentId: string | null;
  readonly amount: Money | null;
  readonly status: ProviderStatusResult['status'] | null;
  readonly providerReference: string | null;
  readonly reason?: string | null;
  /** Body the provider expects in the HTTP response (some require a shape). */
  readonly responseBody?: unknown;
  readonly failureMessage?: string | null;
}

export interface WebhookContext {
  readonly rawBody: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly query: Record<string, unknown>;
  readonly parsedBody: unknown;
}

export interface PaymentProvider {
  readonly code: ProviderCode;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** False when credentials are absent: the adapter exists but is not offered. */
  readonly enabled: boolean;
  /** True only for a provider that moves real money. */
  readonly live: boolean;

  init(request: InitPaymentRequest): Promise<InitPaymentResult>;
  /** No-op for single-step providers. */
  capture(providerPaymentId: string, amount: Money): Promise<CapturePaymentResult>;
  status(providerPaymentId: string): Promise<ProviderStatusResult>;
  cancel(providerPaymentId: string, reason: string): Promise<{ cancelled: boolean; raw?: unknown }>;
  refund(request: RefundRequest): Promise<RefundResult>;
  verifyWebhook(context: WebhookContext): WebhookVerification;
}

/** Thrown by an adapter when the provider itself is at fault. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderCode,
    message: string,
    readonly providerCode?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
