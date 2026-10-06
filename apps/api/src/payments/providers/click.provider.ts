/**
 * CLICK adapter — spec PAY-002, §13.2 [S3].
 *
 * CLICK's Merchant API is a two-phase callback pair: Prepare (action=0) then
 * Complete (action=1), each signed with an MD5 `sign_string` over a fixed
 * field order. The shopper is sent to CLICK's hosted pay page.
 *
 * Status in this release: NOT LIVE, and deliberately so. The spec records
 * Split Shop as present in CLICK's documentation structure but requires the
 * technical parameters and availability for this marketplace to be confirmed
 * by CLICK in writing (§8.1, decision D-04). Guessing a split contract is how
 * sellers get paid the wrong amount, so the adapter refuses to operate until
 * CLICK_MERCHANT_ID, CLICK_SERVICE_ID and CLICK_SECRET_KEY are present.
 */

import { createHash } from 'node:crypto';
import { type Money, money } from '@fashion/core';
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

/** CLICK error codes used in the Prepare/Complete response. */
const CLICK_ERRORS = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INCORRECT_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  TRANSACTION_NOT_FOUND: -6,
  TRANSACTION_CANCELLED: -9,
} as const;

export class ClickPaymentProvider implements PaymentProvider {
  readonly code = 'click' as const;
  readonly displayName = 'CLICK';
  readonly capabilities: ProviderCapabilities = {
    // Split Shop appears in CLICK's documentation; availability for this
    // merchant is unconfirmed (D-04), so the orchestrator must not rely on it.
    nativeSplit: false,
    partialRefund: true,
    fiscalization: true,
    hostedCheckout: true,
    tokenization: false,
    twoStep: true,
    supportedMethods: ['uzcard', 'humo', 'visa', 'mastercard'],
  };

  private readonly config = loadConfig();
  readonly enabled: boolean;
  readonly live: boolean;

  constructor() {
    this.enabled =
      this.config.CLICK_MERCHANT_ID.trim() !== '' &&
      this.config.CLICK_SERVICE_ID.trim() !== '' &&
      this.config.CLICK_SECRET_KEY.trim() !== '';
    this.live = this.enabled && this.config.PAYMENTS_LIVE;
    if (!this.enabled) {
      logger.info('click adapter registered but disabled (no CLICK_* credentials)');
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ProviderError(
        'click',
        'CLICK is not configured. Set CLICK_MERCHANT_ID, CLICK_SERVICE_ID and CLICK_SECRET_KEY once the merchant contract, Split Shop terms (D-04) and sandbox certification are complete.',
        'NOT_CONFIGURED',
      );
    }
  }

  async init(request: InitPaymentRequest): Promise<InitPaymentResult> {
    this.assertEnabled();

    // CLICK's pay page takes the amount in soum, not tiyin, so the minor
    // amount is divided by the currency exponent here and nowhere else.
    const soum = (BigInt(request.amount.amount) / 100n).toString();
    const url = new URL('https://my.click.uz/services/pay');
    url.searchParams.set('service_id', this.config.CLICK_SERVICE_ID);
    url.searchParams.set('merchant_id', this.config.CLICK_MERCHANT_ID);
    url.searchParams.set('amount', soum);
    // transaction_param is echoed back as merchant_trans_id in the callbacks.
    url.searchParams.set('transaction_param', request.orderNumber);
    url.searchParams.set('return_url', request.returnUrl);

    return {
      providerPaymentId: request.paymentId,
      paymentUrl: url.toString(),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    };
  }

  async capture(providerPaymentId: string, amount: Money): Promise<CapturePaymentResult> {
    this.assertEnabled();
    void providerPaymentId;
    // Capture happens when CLICK calls Complete; there is no outbound capture.
    return {
      status: 'PENDING',
      capturedAmount: amount,
      providerReference: null,
      raw: { note: 'CLICK captures via the Complete callback (action=1)' },
    };
  }

  async status(providerPaymentId: string): Promise<ProviderStatusResult> {
    this.assertEnabled();
    logger.warn({ providerPaymentId }, 'click outbound status check is not wired (contract pending)');
    return {
      status: 'PENDING',
      paidAmount: null,
      providerReference: null,
      failureCode: 'NOT_IMPLEMENTED',
      failureMessage: 'Outbound status check requires CLICK Merchant API credentials',
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
    return {
      status: 'FAILED',
      providerRefundId: null,
      providerReference: null,
      failureMessage:
        'CLICK reversals require the Merchant API reversal endpoint and the contractual window (D-07). Process manually and record the reference.',
      raw: { refundId: request.refundId },
    };
  }

  /**
   * PAY-004: CLICK signs with
   *   md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id +
   *       [merchant_prepare_id] + amount + action + sign_time)
   * where merchant_prepare_id is present only on Complete (action=1).
   */
  verifyWebhook(context: WebhookContext): WebhookVerification {
    const body = (context.parsedBody ?? {}) as Record<string, string | number | undefined>;
    const query = context.query as Record<string, string | undefined>;
    const field = (name: string): string => String(body[name] ?? query[name] ?? '');

    const clickTransId = field('click_trans_id');
    const serviceId = field('service_id');
    const merchantTransId = field('merchant_trans_id');
    const merchantPrepareId = field('merchant_prepare_id');
    const amountRaw = field('amount');
    const action = field('action');
    const signTime = field('sign_time');
    const providedSign = field('sign_string').toLowerCase();
    const errorCode = field('error');

    const parts = [
      clickTransId,
      serviceId,
      this.config.CLICK_SECRET_KEY,
      merchantTransId,
      ...(action === '1' ? [merchantPrepareId] : []),
      amountRaw,
      action,
      signTime,
    ];
    const expected = createHash('md5').update(parts.join('')).digest('hex');
    const valid = this.enabled && providedSign.length === 32 && constantTimeEqual(expected, providedSign);

    if (!valid) {
      return {
        valid: false,
        externalEventId: `click_unauthorized_${clickTransId || Date.now()}`,
        eventType: action === '1' ? 'complete' : 'prepare',
        providerPaymentId: clickTransId || null,
        paymentId: null,
        amount: null,
        status: null,
        providerReference: null,
        responseBody: {
          error: CLICK_ERRORS.SIGN_CHECK_FAILED,
          error_note: 'SIGN CHECK FAILED',
        },
      };
    }

    // CLICK sends the amount in soum; convert back to our minor unit.
    const soum = Number.parseFloat(amountRaw || '0');
    const amount = Number.isFinite(soum)
      ? money(BigInt(Math.round(soum * 100)), 'UZS')
      : null;

    const failed = errorCode !== '' && errorCode !== '0';
    const status: ProviderStatusResult['status'] | null = failed
      ? 'FAILED'
      : action === '1'
        ? 'CAPTURED'
        : 'PENDING';

    return {
      valid: true,
      externalEventId: `click:${clickTransId}:${action}`,
      eventType: action === '1' ? 'complete' : 'prepare',
      providerPaymentId: clickTransId || null,
      paymentId: null,
      amount,
      status,
      providerReference: clickTransId || null,
      failureMessage: failed ? `CLICK error ${errorCode}` : null,
      responseBody: {
        click_trans_id: clickTransId,
        merchant_trans_id: merchantTransId,
        ...(action === '0'
          ? { merchant_prepare_id: merchantTransId }
          : { merchant_confirm_id: merchantTransId }),
        error: CLICK_ERRORS.SUCCESS,
        error_note: 'Success',
      },
    };
  }
}
