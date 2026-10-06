/**
 * Payment endpoints — API group "Payments" (§14.2):
 * /payments/methods, /payments/init, /status, provider webhooks.
 *
 * The webhook route is public by design: PAY-004 authenticates the *provider*
 * by signature, not by a session.
 */

import {
  All,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { type Locale, formatMoney, money } from '@fashion/core';
import { PaymentService } from './payment.service';
import { Public } from '../identity/guards';
import {
  type AppRequest,
  CorrelationId,
  CurrentUserId,
  IdempotencyKey,
  RateLimit,
  RequestLocale,
  zodBody,
} from '../common/http';
import { IdempotencyService } from '../common/idempotency.service';
import { loadConfig } from '../common/config';
import { AppError } from '../common/errors';
import { MockPaymentProvider } from './providers/mock.provider';

const initSchema = z.object({
  orderId: z.string().uuid(),
  provider: z.enum(['mock', 'payme', 'click', 'uzum', 'card']).optional(),
  returnUrl: z.string().url().max(500).optional(),
});

@Controller('payments')
export class PaymentsController {
  private readonly config = loadConfig();

  constructor(
    private readonly payments: PaymentService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('methods')
  methods() {
    return {
      providers: this.payments.listMethods(),
      /**
       * The Mini App uses this to show the sandbox banner. Payments are not
       * live in this release pending the §8.4 decisions and PSP certification.
       */
      live: this.config.PAYMENTS_LIVE,
      notice: this.config.PAYMENTS_LIVE
        ? null
        : 'Sandbox mode: no card is charged. Commission, ledger, refunds and payouts run for real.',
    };
  }

  /** ORD-006: requires an Idempotency-Key. */
  @RateLimit({ bucket: 'checkout', max: 30 })
  @Post('init')
  async init(
    @CurrentUserId() userId: string,
    @Body(zodBody(initSchema)) body: z.infer<typeof initSchema>,
    @IdempotencyKey() key: string | null,
    @RequestLocale() locale: Locale,
    @CorrelationId() correlationId: string,
  ) {
    const idempotencyKey = this.idempotency.requireKey(key, 'POST /payments/init');
    return this.idempotency.run(
      { key: idempotencyKey, scope: 'payments.init', body, userId },
      () =>
        this.payments.init({
          userId,
          orderId: body.orderId,
          provider: body.provider,
          locale,
          returnUrl: body.returnUrl,
          idempotencyKey,
          correlationId,
        }),
    );
  }

  @Get(':id')
  async get(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.payments.getPayment(userId, id);
  }

  /** Called when the shopper returns from the hosted page. */
  @RateLimit({ max: 60 })
  @Post(':id/sync')
  async sync(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.payments.syncStatus(userId, id);
  }

  /**
   * PAY-004: one route per provider. `All` because providers differ on verb
   * (CLICK posts form-encoded, Payme posts JSON-RPC, some GET).
   */
  @Public()
  @RateLimit({ bucket: 'webhook', max: 600 })
  @All('webhook/:provider')
  async webhook(
    @Param('provider') provider: string,
    @Req() request: AppRequest,
    @Res() response: Response,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<void> {
    const result = await this.payments.handleWebhook(provider, {
      // The raw body is captured by the verify hook in main.ts so a signature
      // is computed over the exact bytes the provider signed.
      rawBody: request.rawBodyText ?? (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
      headers,
      query,
      parsedBody: body,
    });
    response.status(result.status).json(result.body);
  }

  // ───────────────────────────── sandbox checkout (non-live deployments only)

  /**
   * The sandbox "hosted page". It exists so the whole payment journey —
   * leave the app, authorise, come back, see the order paid — is exercised
   * exactly as it will be with a real PSP. It is served only while
   * PAYMENTS_LIVE is false, and it charges nothing.
   */
  @Public()
  @Get('mock/checkout')
  async mockCheckout(
    @Query('pid') providerPaymentId: string,
    @Query('amount') amount: string,
    @Query('currency') currency: string,
    @Query('order') orderNumber: string,
    @Query('return') returnUrl: string,
    @Query('locale') locale: string,
    @Res() response: Response,
  ): Promise<void> {
    if (this.config.PAYMENTS_LIVE) throw AppError.notFound('Page');
    const provider = this.payments.providerByCode('mock');
    if (!provider) throw AppError.notFound('Page');

    const resolved = (locale as Locale) ?? 'ru';
    const copy = SANDBOX_COPY[resolved] ?? SANDBOX_COPY.ru;
    // The amount is written the way the page's language writes it, so the
    // sandbox page does not say "so'm" above Russian copy.
    const display = formatMoney(money(amount || '0', (currency as 'UZS') || 'UZS'), resolved);

    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.send(renderSandboxPage({ providerPaymentId, display, orderNumber, returnUrl, copy }));
  }

  /** The sandbox page posts here; this is not part of the provider contract. */
  @Public()
  @RateLimit({ max: 60 })
  @Post('mock/complete')
  async mockComplete(
    @Body(
      zodBody(
        z.object({
          providerPaymentId: z.string().min(4),
          outcome: z.enum(['paid', 'failed', 'cancelled']),
        }),
      ),
    )
    body: { providerPaymentId: string; outcome: 'paid' | 'failed' | 'cancelled' },
  ) {
    if (this.config.PAYMENTS_LIVE) throw AppError.notFound('Endpoint');
    const provider = this.payments.providerByCode('mock') as MockPaymentProvider | null;
    if (!provider) throw AppError.notFound('Endpoint');

    const record = provider.peek(body.providerPaymentId);
    if (!record) throw AppError.notFound('Payment session', body.providerPaymentId);

    const status =
      body.outcome === 'paid' ? 'CAPTURED' : body.outcome === 'failed' ? 'FAILED' : 'CANCELLED';
    provider.force(body.providerPaymentId, status);

    const applied = await this.payments.applyProviderStatus({
      provider: 'mock',
      providerPaymentId: body.providerPaymentId,
      paymentId: record.paymentId,
      status,
      amount: record.amount,
      providerReference: record.providerReference,
      pspFee: status === 'CAPTURED' ? await providerFee(provider, body.providerPaymentId) : null,
      method: record.method,
      cardMask: record.cardMask,
      failureMessage: status === 'FAILED' ? 'Sandbox: declined by the operator' : null,
    });

    return {
      outcome: body.outcome,
      paymentStatus: applied?.paymentStatus ?? status,
      orderStatus: applied?.orderStatus ?? null,
    };
  }

  @Public()
  @Get('mock/signature-help')
  signatureHelp(@Headers('host') host: string) {
    if (this.config.PAYMENTS_LIVE) throw AppError.notFound('Endpoint');
    return {
      note: 'Sandbox only. POST a JSON body to the webhook with an HMAC-SHA256 hex signature of the raw body.',
      endpoint: `${this.config.API_PUBLIC_URL}/payments/webhook/mock`,
      headers: { 'x-mock-signature': '<hmac-sha256-hex>', 'x-mock-event-id': '<unique-id>' },
      body: { providerPaymentId: '<pid>', event: 'payment.status', status: 'paid' },
      host,
    };
  }
}

async function providerFee(provider: MockPaymentProvider, providerPaymentId: string) {
  const status = await provider.status(providerPaymentId);
  return status.pspFee ?? null;
}

const SANDBOX_COPY: Record<Locale, { title: string; subtitle: string; pay: string; fail: string; cancel: string; notice: string; back: string }> = {
  ru: {
    title: 'Тестовая оплата',
    subtitle: 'Заказ',
    pay: 'Оплатить',
    fail: 'Смоделировать отказ',
    cancel: 'Отменить',
    notice:
      'Это песочница: карта не списывается. Комиссия 10%, проводки, возвраты и выплаты рассчитываются по-настоящему.',
    back: 'Вернуться в приложение',
  },
  uz: {
    title: 'Sinov to‘lovi',
    subtitle: 'Buyurtma',
    pay: 'To‘lash',
    fail: 'Rad etishni sinash',
    cancel: 'Bekor qilish',
    notice:
      'Bu sinov muhiti: kartadan pul olinmaydi. 10% komissiya, provodkalar, qaytarishlar va to‘lovlar haqiqiy hisoblanadi.',
    back: 'Ilovaga qaytish',
  },
  en: {
    title: 'Sandbox payment',
    subtitle: 'Order',
    pay: 'Pay',
    fail: 'Simulate decline',
    cancel: 'Cancel',
    notice:
      'Sandbox: no card is charged. The 10% commission, ledger entries, refunds and payouts are computed for real.',
    back: 'Return to the app',
  },
};

function renderSandboxPage(input: {
  providerPaymentId: string;
  display: string;
  orderNumber: string;
  returnUrl: string;
  copy: (typeof SANDBOX_COPY)['ru'];
}): string {
  const { providerPaymentId, display, orderNumber, returnUrl, copy } = input;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(copy.title)}</title>
<style>
  :root{color-scheme:light dark;--bg:#0b0b0d;--card:#17171b;--fg:#f5f5f4;--muted:#a1a1aa;--line:#2a2a30;--accent:#d4b483}
  @media (prefers-color-scheme: light){:root{--bg:#f6f5f3;--card:#fff;--fg:#17171b;--muted:#6b6b72;--line:#e6e4e0}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
    background:var(--bg);color:var(--fg)}
  .card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);
    border-radius:20px;padding:26px 22px;box-shadow:0 18px 50px rgba(0,0,0,.18)}
  .tag{display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.09em;
    text-transform:uppercase;color:var(--accent);border:1px solid var(--accent);
    border-radius:999px;padding:4px 10px;margin-bottom:18px}
  h1{font-size:19px;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}
  .order{color:var(--muted);font-size:13px;margin:0 0 20px}
  .amount{font-size:33px;font-weight:650;letter-spacing:-.02em;margin:0 0 6px}
  .notice{font-size:12.5px;color:var(--muted);border-top:1px solid var(--line);
    margin-top:20px;padding-top:16px}
  button{width:100%;border:0;border-radius:13px;padding:14px;font-size:15px;font-weight:600;
    cursor:pointer;font-family:inherit;transition:transform .12s ease,opacity .12s ease}
  button:active{transform:scale(.985)}
  .pay{background:var(--accent);color:#1a1613;margin-bottom:9px}
  .ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
  .ghost+.ghost{margin-top:9px}
  .done{text-align:center}
  .done .mark{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;
    margin:0 auto 14px;font-size:24px}
  .ok .mark{background:#1d3a24;color:#6ee7a0}
  .bad .mark{background:#3a1d1d;color:#f3a1a1}
  a.link{display:block;margin-top:16px;color:var(--accent);text-decoration:none;font-weight:600}
  [hidden]{display:none!important}
</style>
</head>
<body>
<div class="card" id="form">
  <span class="tag">Sandbox</span>
  <h1>${escapeHtml(copy.title)}</h1>
  <p class="order">${escapeHtml(copy.subtitle)} ${escapeHtml(orderNumber)}</p>
  <p class="amount">${escapeHtml(display)}</p>
  <button class="pay" data-outcome="paid">${escapeHtml(copy.pay)}</button>
  <button class="ghost" data-outcome="failed">${escapeHtml(copy.fail)}</button>
  <button class="ghost" data-outcome="cancelled">${escapeHtml(copy.cancel)}</button>
  <p class="notice">${escapeHtml(copy.notice)}</p>
</div>

<div class="card done ok" id="ok" hidden>
  <div class="mark">✓</div>
  <h1>${escapeHtml(copy.pay)}</h1>
  <p class="order">${escapeHtml(copy.subtitle)} ${escapeHtml(orderNumber)}</p>
  <a class="link" href="${escapeAttr(returnUrl)}">${escapeHtml(copy.back)}</a>
</div>

<div class="card done bad" id="bad" hidden>
  <div class="mark">!</div>
  <h1 id="badTitle"></h1>
  <p class="order">${escapeHtml(copy.subtitle)} ${escapeHtml(orderNumber)}</p>
  <a class="link" href="${escapeAttr(returnUrl)}">${escapeHtml(copy.back)}</a>
</div>

<script>
  const pid = ${JSON.stringify(providerPaymentId)};
  const copy = ${JSON.stringify(copy)};
  document.querySelectorAll('button[data-outcome]').forEach((button) => {
    button.addEventListener('click', async () => {
      document.querySelectorAll('button').forEach((b) => { b.disabled = true; b.style.opacity = '.55'; });
      const outcome = button.dataset.outcome;
      try {
        const response = await fetch('/payments/mock/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providerPaymentId: pid, outcome }),
        });
        if (!response.ok) throw new Error('request failed');
        document.getElementById('form').hidden = true;
        if (outcome === 'paid') {
          document.getElementById('ok').hidden = false;
        } else {
          document.getElementById('badTitle').textContent = outcome === 'failed' ? copy.fail : copy.cancel;
          document.getElementById('bad').hidden = false;
        }
        setTimeout(() => { window.location.href = ${JSON.stringify(returnUrl)}; }, 1400);
      } catch (error) {
        document.querySelectorAll('button').forEach((b) => { b.disabled = false; b.style.opacity = '1'; });
        alert('Sandbox request failed: ' + error.message);
      }
    });
  });
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  // Only allow http(s) and relative targets so the sandbox cannot be used as
  // an open redirect to a javascript: URL.
  const raw = String(value ?? '/');
  const safe = /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : '/';
  return escapeHtml(safe);
}
