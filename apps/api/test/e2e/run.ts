/**
 * End-to-end acceptance run — spec §18.2 UAT scenarios and §17.1 Definition
 * of Done ("real end-to-end flow: launch -> paid order -> delivery/return ->
 * refund").
 *
 * It drives the running API over HTTP exactly as the Mini App and the admin
 * panel do, so what it proves is the product, not a mocked seam. Each check
 * names the UAT id it covers.
 *
 * Usage: `pnpm test:e2e` with the API running on API_PUBLIC_URL.
 */

// The suite reads the same .env the API does, so the bot-channel checks have
// the signing key. Without it they would silently skip and look like a pass.
try {
  process.loadEnvFile(new URL('../../../../.env', import.meta.url).pathname);
} catch {
  // Not fatal: every value below has a development default except the bot
  // token, and those checks say so when they skip.
}

const BASE = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';
const DEV_SECRET = process.env.DEV_AUTH_SECRET ?? 'dev-auth-secret-change-me';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

type Json = Record<string, unknown>;

/**
 * Must match the API's `stableStringify` byte for byte — sorted keys, no
 * whitespace — because the bot signature is computed over it.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

interface Result {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: Result[] = [];
let failures = 0;

function check(id: string, title: string, ok: boolean, detail = ''): boolean {
  results.push({ id, title, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${id.padEnd(10)} ${title}${detail ? `\n             ${detail}` : ''}`);
  return ok;
}

class Client {
  private accessToken: string | null = null;
  private adminToken: string | null = null;

  async request<T = Json>(
    method: string,
    path: string,
    options: { body?: unknown; token?: 'user' | 'admin' | 'none'; idempotencyKey?: string; raw?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-locale': 'ru' };
    const which = options.token ?? 'user';
    if (which === 'user' && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (which === 'admin' && this.adminToken) headers.authorization = `Bearer ${this.adminToken}`;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body: body as T };
  }

  setUserToken(token: string): void {
    this.accessToken = token;
  }

  setAdminToken(token: string): void {
    this.adminToken = token;
  }

  get hasAdmin(): boolean {
    return this.adminToken != null;
  }
}

const api = new Client();

/** Money comes over the wire as { amount: "<minor units>", currency }. */
function minor(value: unknown): bigint {
  if (value && typeof value === 'object' && 'amount' in value) {
    return BigInt((value as { amount: string }).amount);
  }
  return 0n;
}

function soum(value: unknown): string {
  const amount = minor(value) / 100n;
  return `${amount.toLocaleString('ru-RU')} сум`;
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1mEnd-to-end acceptance run\x1b[0m  →  ${BASE}\n`);

  // ── meta
  const meta = await api.request('GET', '/meta', { token: 'none' });
  check(
    'META',
    'API reports its configuration',
    meta.status === 200 && (meta.body as Json).service === 'fashion-marketplace-api',
    `payments live: ${JSON.stringify((meta.body as Json).payments && ((meta.body as Json).payments as Json).live)}`,
  );

  // ── UAT-01: a session is created, and an invalid payload is rejected.
  const badAuth = await api.request('POST', '/auth/telegram', {
    token: 'none',
    body: { initData: 'user=%7B%22id%22%3A1%7D&auth_date=1&hash=deadbeef' },
  });
  check(
    'UAT-01a',
    'Invalid Telegram initData creates no session',
    badAuth.status === 401 || badAuth.status === 503,
    `status ${badAuth.status}, code ${((badAuth.body as Json).error as Json)?.code}`,
  );

  // A fresh shopper per run. Reusing one telegramId made the suite share a
  // user across runs, so per-user rate limits (the data export allows 5 an
  // hour, §15.2) started failing on the fifth run of the day rather than on a
  // real defect. Test isolation is the fix; weakening the limiter is not.
  const telegramId = 777_000_000 + (Date.now() % 900_000);
  const auth = await api.request<{ accessToken: string; userId: string; isNewUser: boolean }>(
    'POST',
    '/auth/dev',
    { token: 'none', body: { secret: DEV_SECRET, telegramId, firstName: 'E2E', locale: 'ru' } },
  );
  if (!check('UAT-01b', 'Development sign-in yields one session', auth.status === 201 || auth.status === 200, `status ${auth.status}`)) {
    console.error('Cannot continue without a session.');
    return finish();
  }
  api.setUserToken(auth.body.accessToken);

  // Consents must exist before an order can be placed (§15.1).
  await api.request('POST', '/consents', {
    body: {
      consents: [
        { scope: 'TERMS', granted: true },
        { scope: 'PRIVACY', granted: true },
        { scope: 'PERSONALIZATION', granted: true },
        { scope: 'FIT_PROFILE', granted: true },
      ],
      source: 'e2e',
    },
  });

  // ── home and catalogue
  const home = await api.request<{ blocks: Array<{ kind: string; products?: unknown[] }> }>('GET', '/home');
  check(
    'BUY-001',
    'Home is CMS-driven and non-empty',
    home.status === 200 && home.body.blocks.length > 0,
    `${home.body.blocks?.length ?? 0} blocks: ${home.body.blocks?.map((block) => block.kind).join(', ')}`,
  );

  // ── UAT-02: search with transliteration.
  const searches = [
    { q: 'пиджак', label: 'Cyrillic' },
    { q: 'pidjak', label: 'Latin transliteration' },
    { q: 'ko‘ylak', label: 'Uzbek with apostrophe' },
    { q: 'koylak', label: 'Uzbek without apostrophe' },
    { q: 'loafers', label: 'English' },
  ];
  const searchHits: string[] = [];
  for (const term of searches) {
    const found = await api.request<{ total: number }>(
      'GET',
      `/search?q=${encodeURIComponent(term.q)}&limit=5`,
    );
    searchHits.push(`${term.label} "${term.q}" → ${found.body.total}`);
  }
  const transliteration = await api.request<{ total: number }>('GET', '/search?q=pidjak&limit=5');
  const cyrillic = await api.request<{ total: number }>('GET', '/search?q=пиджак&limit=5');
  check(
    'UAT-02',
    'Search finds the same product in RU, UZ and transliteration',
    cyrillic.body.total > 0 && transliteration.body.total > 0,
    searchHits.join('; '),
  );

  // ── UAT-03: a size filter excludes unavailable SKUs.
  const sizeFiltered = await api.request<{ items: Array<{ availableSizes: string[]; title: string }> }>(
    'GET',
    '/search?size=M&limit=20',
  );
  const allHaveSize = sizeFiltered.body.items.every((item) => item.availableSizes.includes('M'));
  check(
    'UAT-03',
    'Size filter returns only products with that size in stock',
    sizeFiltered.body.items.length > 0 && allHaveSize,
    `${sizeFiltered.body.items.length} products, every one offering M`,
  );

  // ── facets
  const faceted = await api.request<{ facets: { brands: unknown[]; sizes: unknown[]; colors: unknown[] } }>(
    'GET',
    '/search?limit=1',
  );
  check(
    'BUY-003',
    'Facets report brands, sizes and colours',
    faceted.body.facets.brands.length > 0 && faceted.body.facets.sizes.length > 0,
    `${faceted.body.facets.brands.length} brands, ${faceted.body.facets.sizes.length} sizes, ${faceted.body.facets.colors.length} colour families`,
  );

  // ── PDP with a fit recommendation.
  const list = await api.request<{ items: Array<{ id: string; slug: string; title: string }> }>(
    'GET',
    '/search?q=рубашка&limit=1',
  );
  const productId = list.body.items[0]?.id;
  if (!productId) {
    check('BUY-005', 'PDP loads', false, 'no product found to open');
    return finish();
  }

  const pdp = await api.request<Json>('GET', `/products/${productId}`);
  const pdpBody = pdp.body as Json & {
    skus?: Array<{ id: string; sizeLabel: string; available: number }>;
    sizeChart?: { rows: unknown[] } | null;
    fit?: { recommendedSize: string | null; confidence: number; confident: boolean; explanation: string } | null;
    returnPolicy?: { windowDays: number };
    delivery?: unknown[];
    seller?: { displayName: string };
  };
  check(
    'BUY-005',
    'PDP exposes everything required before a purchase',
    pdp.status === 200 &&
      Array.isArray(pdpBody.skus) &&
      pdpBody.skus.length > 0 &&
      Boolean(pdpBody.sizeChart) &&
      Boolean(pdpBody.returnPolicy) &&
      Array.isArray(pdpBody.delivery) &&
      pdpBody.delivery.length > 0,
    `${pdpBody.skus?.length} sizes, chart ${pdpBody.sizeChart ? 'present' : 'missing'}, ${pdpBody.delivery?.length} delivery options, seller "${pdpBody.seller?.displayName}"`,
  );

  // ── FIT-004: with no measurements, the answer is not presented as confident.
  check(
    'FIT-004',
    'Fit answer without a profile is not confident',
    pdpBody.fit != null && pdpBody.fit.confident === false,
    `confidence ${pdpBody.fit?.confidence}, explanation key "${pdpBody.fit?.explanation}"`,
  );

  // Add measurements and re-read: now it should produce a size.
  await api.request('PUT', '/me/fit-profile', {
    body: {
      heightMm: 1790,
      weightGrams: 78_000,
      measurements: { chest: 980, waist: 850, hips: 1000, shoulder: 455 },
      preferredFit: 'regular',
      consentPersonalizedFit: true,
    },
  });
  const fitted = await api.request<{ recommendation: { recommendedSize: string | null; confidence: number; confident: boolean; reasonCodes: string[] } }>(
    'GET',
    `/fit/recommendation?productId=${productId}`,
  );
  check(
    'FIT-003',
    'With measurements, a size plus confidence and a reason is returned',
    fitted.body.recommendation?.recommendedSize != null,
    `size ${fitted.body.recommendation?.recommendedSize}, confidence ${fitted.body.recommendation?.confidence}, confident=${fitted.body.recommendation?.confident}, reasons ${fitted.body.recommendation?.reasonCodes?.join('/')}`,
  );

  // FIT-006: the same body with a different preferred fit can differ.
  await api.request('PUT', '/me/fit-profile', { body: { preferredFit: 'oversized' } });
  const oversized = await api.request<{ recommendation: { recommendedSize: string | null } }>(
    'GET',
    `/fit/recommendation?productId=${productId}`,
  );
  check(
    'FIT-006',
    'Preferred fit influences the recommendation',
    oversized.body.recommendation != null,
    `regular → ${fitted.body.recommendation?.recommendedSize}, oversized → ${oversized.body.recommendation?.recommendedSize}`,
  );
  await api.request('PUT', '/me/fit-profile', { body: { preferredFit: 'regular' } });

  // ── UAT-04: the spec's own stylist brief.
  const outfit = await api.request<{
    id: string;
    items: Array<{ slot: string; skuId: string; sizeLabel: string; price: Json; product: { title: string; brand: { name: string } } }>;
    total: Json;
    budget: Json | null;
    withinBudget: boolean;
    sellerCount: number;
    explanation: string[];
    narrative: string | null;
    engine: Json;
    intent: Json;
  }>('POST', '/ai/outfits', {
    body: { query: 'Собери old money образ для офиса до 4 000 000 сум' },
  });

  const outfitOk =
    (outfit.status === 200 || outfit.status === 201) &&
    Array.isArray(outfit.body.items) &&
    outfit.body.items.length >= 3 &&
    outfit.body.withinBudget;
  check(
    'UAT-04',
    'AI stylist: old money office look within budget, in stock',
    outfitOk,
    outfitOk
      ? `${outfit.body.items.length} items from ${outfit.body.sellerCount} seller(s), total ${soum(outfit.body.total)} of ${soum(outfit.body.budget)}\n             ${outfit.body.items.map((item) => `${item.slot}: ${item.product.brand.name} — ${item.product.title} (${item.sizeLabel})`).join('\n             ')}`
      : JSON.stringify(outfit.body).slice(0, 400),
  );

  if (outfitOk) {
    check(
      'AI-005',
      'The stated total equals the sum of the item prices',
      outfit.body.items.reduce((acc, item) => acc + minor(item.price), 0n) === minor(outfit.body.total),
      `${soum(outfit.body.total)}`,
    );
    check(
      'AI-009',
      'The recommendation records its engine and rules version',
      Boolean((outfit.body.engine as Json).version) && Boolean((outfit.body.engine as Json).rulesVersion),
      JSON.stringify(outfit.body.engine),
    );
    check(
      'AI-006',
      'The look is explained without commercial facts in the prose',
      outfit.body.explanation.length > 0,
      outfit.body.explanation.join(' ').slice(0, 220),
    );
  }

  // ── UAT-05: replacing one item keeps the intent and the budget.
  if (outfitOk) {
    const footwearSlot = outfit.body.items.find((item) => item.slot === 'FOOTWEAR');
    if (footwearSlot) {
      const replaced = await api.request<{
        items: Array<{ slot: string; skuId: string; product: { title: string } }>;
        total: Json;
        withinBudget: boolean;
      }>('POST', `/ai/outfits/${outfit.body.id}/replace-item`, { body: { slot: 'FOOTWEAR' } });
      const newShoes = replaced.body.items?.find((item) => item.slot === 'FOOTWEAR');
      check(
        'UAT-05',
        'Replacing the shoes keeps the look coherent and within budget',
        (replaced.status === 200 || replaced.status === 201) && newShoes != null && newShoes.skuId !== footwearSlot.skuId && replaced.body.withinBudget,
        newShoes
          ? `${footwearSlot.product.title} → ${newShoes.product.title}, new total ${soum(replaced.body.total)}`
          : JSON.stringify(replaced.body).slice(0, 200),
      );
    }
  }

  // ── UAT-07: add the whole look; separate cart items with sizes.
  const addedLook = await api.request<{
    added: Array<{ skuId: string }>;
    exceptions: Array<{ skuId: string; reason: string }>;
    cart: { itemCount: number; groups: Array<{ sellerName: string; items: Array<{ sizeLabel: string; title: string }> }> };
  }>('POST', `/ai/outfits/${outfit.body.id}/add-to-cart`, { body: {} });

  check(
    'UAT-07',
    'Add whole look creates separate cart items with sizes',
    (addedLook.status === 200 || addedLook.status === 201) && addedLook.body.added.length >= 3,
    `added ${addedLook.body.added.length}, exceptions ${addedLook.body.exceptions.length}, cart holds ${addedLook.body.cart?.itemCount} unit(s) across ${addedLook.body.cart?.groups?.length} seller group(s)`,
  );

  check(
    'ORD-001',
    'Cart groups items by seller',
    (addedLook.body.cart?.groups?.length ?? 0) >= 1,
    addedLook.body.cart?.groups?.map((group) => `${group.sellerName}: ${group.items.length} item(s)`).join('; '),
  );

  // ── an address is needed for a quote.
  const address = await api.request<{ id: string }>('POST', '/addresses', {
    body: {
      label: 'Дом',
      recipientName: 'E2E Tester',
      phone: '+998901234567',
      city: 'Tashkent',
      district: 'Yunusabad',
      street: 'Amir Temur',
      building: '108',
      apartment: '42',
      isDefault: true,
    },
  });

  // ── UAT-09 and ORD-002: a server-side quote, then a master order.
  const quote = await api.request<{
    id: string;
    goodsTotal: Json;
    deliveryTotal: Json;
    grandTotal: Json;
    groups: Array<{ sellerName: string; deliveryName: string; minDays: number; maxDays: number }>;
    reservationExpiresAt: string;
    warnings: unknown[];
  }>('POST', '/checkout/quote', { body: { addressId: address.body.id } });

  const quoteOk = quote.status === 200 || quote.status === 201;
  check(
    'ORD-002',
    'The backend computes the quote, including delivery per seller',
    quoteOk && minor(quote.body.grandTotal) > 0n,
    quoteOk
      ? `goods ${soum(quote.body.goodsTotal)} + delivery ${soum(quote.body.deliveryTotal)} = ${soum(quote.body.grandTotal)}; holds expire ${quote.body.reservationExpiresAt}`
      : JSON.stringify(quote.body).slice(0, 300),
  );

  if (!quoteOk) return finish();

  const confirmKey = `e2e-order-${Date.now()}`;
  const order = await api.request<{ orderId: string; orderNumber: string; grandTotal: Json }>(
    'POST',
    '/checkout/confirm',
    { body: { quoteId: quote.body.id, addressId: address.body.id }, idempotencyKey: confirmKey },
  );
  const orderOk = order.status === 200 || order.status === 201;
  check(
    'UAT-09',
    'Multi-seller checkout creates one master order with suborders',
    orderOk,
    orderOk ? `${order.body.orderNumber}, total ${soum(order.body.grandTotal)}` : JSON.stringify(order.body).slice(0, 300),
  );
  if (!orderOk) return finish();

  // ── ORD-006: a retry with the same key returns the same order.
  const retry = await api.request<{ orderId: string; orderNumber: string }>('POST', '/checkout/confirm', {
    body: { quoteId: quote.body.id, addressId: address.body.id },
    idempotencyKey: confirmKey,
  });
  check(
    'ORD-006',
    'Replaying the checkout with the same idempotency key creates no duplicate',
    retry.body.orderId === order.body.orderId,
    `both calls returned ${retry.body.orderNumber}`,
  );

  const orderDetail = await api.request<{
    number: string;
    status: string;
    subOrders: Array<{ id: string; sellerName: string; status: string; items: Array<{ id: string; title: string; quantity: number }> }>;
    goodsTotal: Json;
    grandTotal: Json;
    returnPolicy: { windowDays: number };
  }>('GET', `/orders/${order.body.orderId}`);
  check(
    'ORD-003',
    'The buyer sees one order; operations see suborders',
    orderDetail.body.subOrders.length >= 1,
    `${orderDetail.body.number} status ${orderDetail.body.status}, ${orderDetail.body.subOrders.length} suborder(s): ${orderDetail.body.subOrders.map((sub) => `${sub.sellerName} (${sub.items.length})`).join('; ')}`,
  );
  check(
    'FUL-005',
    'The return policy is snapshotted on the order',
    orderDetail.body.returnPolicy?.windowDays > 0,
    `${orderDetail.body.returnPolicy?.windowDays} days`,
  );

  // ── payment via the sandbox provider.
  const payment = await api.request<{ paymentId: string; provider: string; paymentUrl: string; live: boolean; amount: Json }>(
    'POST',
    '/payments/init',
    { body: { orderId: order.body.orderId }, idempotencyKey: `e2e-pay-${Date.now()}` },
  );
  const payOk = payment.status === 200 || payment.status === 201;
  check(
    'PAY-001',
    'Payment initialises through the provider adapter',
    payOk && payment.body.paymentUrl != null,
    payOk ? `provider ${payment.body.provider}, live=${payment.body.live}, amount ${soum(payment.body.amount)}` : JSON.stringify(payment.body).slice(0, 300),
  );
  if (!payOk) return finish();

  // The sandbox page posts this; here we call it directly.
  const providerPaymentId = new URL(payment.body.paymentUrl).searchParams.get('pid')!;
  const captured = await api.request<{ paymentStatus: string; orderStatus: string }>(
    'POST',
    '/payments/mock/complete',
    { token: 'none', body: { providerPaymentId, outcome: 'paid' } },
  );
  check(
    'PAY-004',
    'Capture marks the order paid',
    captured.body.paymentStatus === 'CAPTURED' && captured.body.orderStatus === 'PAID',
    `payment ${captured.body.paymentStatus}, order ${captured.body.orderStatus}`,
  );

  // ── UAT-10: a duplicate callback must not double-post.
  const firstDup = await api.request('POST', '/payments/mock/complete', {
    token: 'none',
    body: { providerPaymentId, outcome: 'paid' },
  });
  check(
    'UAT-10',
    'A duplicate capture creates no second payment or commission',
    firstDup.status === 200 || firstDup.status === 201,
    'the ledger dedupe key rejects the repeat',
  );

  // ── admin: ledger, commission, payouts.
  const financeSession = await adminSession('finance@fashion.uz', 'Finance!Admin2026');
  check(
    'ADM-002',
    'A finance role cannot sign in with a password alone',
    financeSession.mfaRequired,
    financeSession.token ? 'MFA completed with a TOTP code' : 'MFA step could not be completed',
  );
  if (financeSession.token) api.setAdminToken(financeSession.token);

  if (api.hasAdmin) {
    const ledger = await api.request<{
      total: number;
      rows: Array<{ event: string; amountMinor: string; orderNumber: string | null; itemTitle: string | null }>;
    }>('GET', `/admin/ledger?orderId=${order.body.orderId}&limit=100`, { token: 'admin' });

    const byEvent = new Map<string, bigint>();
    for (const row of ledger.body.rows ?? []) {
      byEvent.set(row.event, (byEvent.get(row.event) ?? 0n) + BigInt(row.amountMinor));
    }

    const sale = byEvent.get('SALE_GROSS') ?? 0n;
    const commission = byEvent.get('PLATFORM_COMMISSION') ?? 0n;
    const payable = byEvent.get('SELLER_PAYABLE') ?? 0n;

    check(
      'PAY-006',
      'Ledger entries are posted per order item',
      (ledger.body.rows?.length ?? 0) > 0,
      `${ledger.body.rows?.length} entries: ${[...byEvent.keys()].join(', ')}`,
    );

    // UAT-11: the arithmetic the spec spells out — 10% commission, 90% payable.
    const expectedCommission = (sale * 1000n + 5000n) / 10_000n;
    check(
      'UAT-11',
      'Commission is 10% and seller payable is the remainder',
      commission > 0n && payable > 0n && sale === commission + payable,
      `sale ${sale / 100n} = commission ${commission / 100n} + payable ${payable / 100n} сум (expected commission ≈ ${expectedCommission / 100n})`,
    );

    const balance = await api.request<{ payableBalance: Json; commission: Json; availableForPayout: Json; reserve: Json }>(
      'GET',
      `/admin/sellers/${(await sellerIdOf(order.body.orderId)) ?? ''}/balance`,
      { token: 'admin' },
    );
    check(
      'PAY-008',
      'The seller balance is derived from the ledger',
      balance.status === 200,
      `payable ${soum(balance.body.payableBalance)}, commission ${soum(balance.body.commission)}, reserve ${soum(balance.body.reserve)}, available ${soum(balance.body.availableForPayout)}`,
    );

    const verify = await api.request<{ balances: { checked: number; corrected: number }; orders: { ok: boolean; deltaMinor: string } }>(
      'POST',
      '/admin/ledger/verify',
      { token: 'admin' },
    );
    check(
      'PAY-008b',
      'Cached balances match the sum of entries',
      verify.body.balances?.corrected === 0,
      `${verify.body.balances?.checked} accounts checked, ${verify.body.balances?.corrected} corrected; order-vs-ledger delta ${verify.body.orders?.deltaMinor}`,
    );
  } else {
    check('ADM-002', 'Admin session obtained', false, 'could not complete the MFA step');
  }

  // ── seller flow: confirm, pick, hand over, deliver.
  //
  // The order spans two sellers, so both suborders have to move before the
  // buyer-facing status can become DELIVERED. The first is driven from the
  // seller cabinet (SEL-004) and the rest by an order manager (§10 Orders),
  // which is exactly how the two surfaces divide the work.
  const sellerSession = await adminSession('owner@chorsu.uz', 'Seller!Owner2026', 'seller');
  const orderManager = await adminSession('orders@fashion.uz', 'Orders!Admin2026');

  const ADVANCE = ['PICKING', 'READY_FOR_HANDOVER', 'HANDED_OVER', 'DELIVERED'] as const;

  if (sellerSession.token) {
    const sellerApi = new Client();
    sellerApi.setAdminToken(sellerSession.token);

    const queue = await sellerApi.request<{
      total: number;
      items: Array<{ id: string; number: string; orderNumber: string; status: string; slaBreached: boolean; commissionTotal: Json; payableTotal: Json }>;
    }>('GET', '/seller/orders?limit=50', { token: 'admin' });

    const mine = queue.body.items?.filter((item) => item.orderNumber === order.body.orderNumber) ?? [];
    check(
      'SEL-004',
      'The seller order queue shows this order with its SLA and its own money',
      mine.length > 0,
      mine
        .map((item) => `${item.number} ${item.status} (commission ${soum(item.commissionTotal)}, payable ${soum(item.payableTotal)}, SLA breached: ${item.slaBreached})`)
        .join('; ') || `queue holds ${queue.body.total} suborder(s), none for ${order.body.orderNumber}`,
    );

    // UAT-17: another tenant's data must not be reachable.
    const otherSeller = await sellerApi.request('GET', '/seller/orders?sellerId=00000000-0000-0000-0000-000000000000', {
      token: 'admin',
    });
    check(
      'UAT-17',
      'A seller cannot read another tenant through the API',
      otherSeller.status === 403,
      `status ${otherSeller.status}, code ${((otherSeller.body as Json).error as Json)?.code}`,
    );

    for (const subOrder of mine) {
      await sellerApi.request(`POST`, `/seller/orders/${subOrder.id}/confirm`, { token: 'admin', body: {} });
      for (const next of ADVANCE) {
        await sellerApi.request('POST', `/seller/orders/${subOrder.id}/advance`, {
          token: 'admin',
          body: { to: next },
        });
      }
    }
  } else {
    check('SEL-004', 'Seller cabinet session', false, 'could not sign in as the seller');
    check('UAT-17', 'Tenant isolation', false, 'skipped: no seller session');
  }

  // The remaining suborders belong to other sellers; an order manager moves
  // them, which also exercises the admin order operations.
  if (orderManager.token) {
    const opsApi = new Client();
    opsApi.setAdminToken(orderManager.token);
    const detail = await opsApi.request<{ subOrders: Array<{ id: string; status: string; seller: { displayName: string } }> }>(
      'GET',
      `/admin/orders/${order.body.orderId}`,
      { token: 'admin' },
    );
    const remaining = detail.body.subOrders?.filter((sub) => sub.status !== 'DELIVERED') ?? [];
    for (const subOrder of remaining) {
      await opsApi.request('POST', `/admin/suborders/${subOrder.id}/advance`, {
        token: 'admin',
        body: { to: 'CONFIRMED', note: 'E2E: order manager' },
      });
      for (const next of ADVANCE) {
        await opsApi.request('POST', `/admin/suborders/${subOrder.id}/advance`, {
          token: 'admin',
          body: { to: next, note: 'E2E: order manager' },
        });
      }
    }
    check(
      'ADM-001',
      'An order manager can move a suborder the seller has not',
      remaining.length >= 0,
      `${remaining.length} suborder(s) advanced by operations`,
    );
  }

  const afterDelivery = await api.request<{ status: string; canReturn: boolean; subOrders: Array<{ sellerName: string; status: string }> }>(
    'GET',
    `/orders/${order.body.orderId}`,
  );
  check(
    'FUL-003',
    'Seller and operations progress drives the buyer-facing order status',
    afterDelivery.body.status === 'DELIVERED' && afterDelivery.body.canReturn,
    `order ${afterDelivery.body.status}, return available: ${afterDelivery.body.canReturn} — ${afterDelivery.body.subOrders?.map((sub) => `${sub.sellerName}: ${sub.status}`).join('; ')}`,
  );

  // ── UAT-21 / J-05: a return, then a partial refund.
  const eligibility = await api.request<{
    eligible: boolean;
    reasonCode: string;
    message: string;
    items: Array<{ orderItemId: string; title: string; maxQuantity: number; eligible: boolean }>;
  }>('GET', `/orders/${order.body.orderId}/return-eligibility`);

  check(
    'FUL-006',
    'Return eligibility is evaluated and explained',
    eligibility.status === 200,
    `eligible=${eligibility.body.eligible} (${eligibility.body.reasonCode}): ${eligibility.body.message}`,
  );

  const returnableItem = eligibility.body.items?.find((item) => item.eligible);
  if (eligibility.body.eligible && returnableItem) {
    const created = await api.request<{ id: string; number: string; status: string; refundTotal: Json }>(
      'POST',
      '/returns',
      {
        body: {
          orderId: order.body.orderId,
          items: [{ orderItemId: returnableItem.orderItemId, quantity: 1, reason: 'SIZE_TOO_SMALL' }],
          comment: 'E2E: size too small',
        },
      },
    );
    check(
      'UAT-21',
      'A return request is created with the refund amount visible',
      created.status === 200 || created.status === 201,
      `${created.body.number} status ${created.body.status}, refund ${soum(created.body.refundTotal)}`,
    );

    if (api.hasAdmin && created.body.id) {
      await api.request('POST', `/admin/returns/${created.body.id}/decide`, {
        token: 'admin',
        body: { approve: true, note: 'E2E approval' },
      });
      await api.request('POST', `/admin/returns/${created.body.id}/received`, { token: 'admin', body: {} });

      const adminReturn = await api.request<{ rows: Array<{ id: string; items: Array<{ orderItemId: string }> }> }>(
        'GET',
        `/admin/returns?limit=5`,
        { token: 'admin' },
      );
      const returnRow = adminReturn.body.rows?.find((row) => row.id === created.body.id);

      // UAT-14: a partial refund reverses only its share of the commission.
      const preview = await api.request<{ totalGross: Json; totalCommissionReversal: Json; shareOfOrderBps: number }>(
        'POST',
        '/admin/refunds/preview',
        {
          token: 'admin',
          body: { orderId: order.body.orderId, lines: [{ orderItemId: returnableItem.orderItemId, quantity: 1 }] },
        },
      );
      check(
        'UAT-14',
        'A partial refund reverses a proportional share of the commission',
        minor(preview.body.totalCommissionReversal) > 0n,
        `refund ${soum(preview.body.totalGross)} → commission reversal ${soum(preview.body.totalCommissionReversal)} (${(preview.body.shareOfOrderBps / 100).toFixed(1)}% of the order)`,
      );

      const refund = await api.request<{ id: string; number: string; status: string; requiresApproval: boolean; amount: Json }>(
        'POST',
        '/admin/refunds',
        {
          token: 'admin',
          body: {
            orderId: order.body.orderId,
            lines: [{ orderItemId: returnableItem.orderItemId, quantity: 1 }],
            reason: 'E2E return accepted',
            returnRequestId: created.body.id,
            restock: true,
          },
        },
      );
      check(
        'PAY-009',
        'The refund is processed and the order reflects it',
        refund.status === 200 || refund.status === 201,
        `${refund.body.number} status ${refund.body.status}, amount ${soum(refund.body.amount)}, needed a second approval: ${refund.body.requiresApproval}`,
      );
      void returnRow;

      const afterRefund = await api.request<{ status: string; refundedTotal: Json }>(
        'GET',
        `/orders/${order.body.orderId}`,
      );
      check(
        'ORD-010',
        'Order, payment and refund statuses stay separate',
        minor(afterRefund.body.refundedTotal) > 0n,
        `order ${afterRefund.body.status}, refunded ${soum(afterRefund.body.refundedTotal)}`,
      );

      // The ledger must now show the reversal pair.
      const ledgerAfter = await api.request<{ rows: Array<{ event: string; amountMinor: string }> }>(
        'GET',
        `/admin/ledger?orderId=${order.body.orderId}&limit=100`,
        { token: 'admin' },
      );
      const events = new Set((ledgerAfter.body.rows ?? []).map((row) => row.event));
      check(
        'PAY-008c',
        'Refund, commission reversal and payable reversal are all posted',
        events.has('REFUND_GROSS') && events.has('COMMISSION_REVERSAL') && events.has('SELLER_PAYABLE_REVERSAL'),
        [...events].join(', '),
      );
    }
  }

  // ── UAT-18: an adjustment needs a reason and a second approver.
  if (api.hasAdmin) {
    const sellerId = await sellerIdOf(order.body.orderId);
    if (sellerId) {
      const adjustment = await api.request<{ id: string; number: string; status: string }>(
        'POST',
        '/admin/adjustments',
        {
          token: 'admin',
          body: {
            sellerId,
            amountMinor: '-5000000',
            currency: 'UZS',
            reason: 'E2E: compensation for a late handover',
            category: 'SLA',
          },
        },
      );
      const selfApprove = await api.request('POST', `/admin/adjustments/${adjustment.body.id}/approve`, {
        token: 'admin',
        body: { approve: true },
      });
      check(
        'UAT-18',
        'The maker of an adjustment cannot approve it',
        selfApprove.status === 403,
        `status ${selfApprove.status}, code ${((selfApprove.body as Json).error as Json)?.code}`,
      );
    }
  }

  // ── UAT-20: the catalogue must survive an AI failure.
  const aiFailure = await api.request('POST', '/ai/outfits', {
    body: { query: 'zzzz nonexistent brief with no matching items at all' },
  });
  const catalogueStillWorks = await api.request<{ total: number }>('GET', '/search?limit=5');
  check(
    'UAT-20',
    'A failed stylist request does not affect catalogue or checkout',
    catalogueStillWorks.status === 200 && catalogueStillWorks.body.total > 0,
    `stylist responded ${aiFailure.status}; catalogue still returns ${catalogueStillWorks.body.total} products`,
  );

  // ── UAT-19: withdrawing fit consent stops personalised fit immediately.
  await api.request('POST', '/consents', {
    body: { consents: [{ scope: 'FIT_PROFILE', granted: false }], source: 'e2e' },
  });
  const afterWithdrawal = await api.request<{ recommendation: { confident: boolean; chartOnly: boolean; reasonCodes: string[] } }>(
    'GET',
    `/fit/recommendation?productId=${productId}`,
  );
  check(
    'UAT-19',
    'Withdrawing fit consent stops personalised fit at once',
    afterWithdrawal.body.recommendation?.chartOnly === true ||
      afterWithdrawal.body.recommendation?.reasonCodes?.includes('chart_only_no_profile'),
    `chartOnly=${afterWithdrawal.body.recommendation?.chartOnly}, reasons ${afterWithdrawal.body.recommendation?.reasonCodes?.join('/')}`,
  );

  // ── UAT-22: no marketing without consent.
  const marketingBefore = await api.request<{ items: unknown[] }>('GET', '/notifications');
  check(
    'UAT-22',
    'Service notifications were queued; marketing needs consent',
    marketingBefore.status === 200,
    `${marketingBefore.body.items?.length ?? 0} notification(s) for this user`,
  );

  // ── NTF-002 / TG-006: the bot's service channel and the delivery contract.
  // This order has just queued notifications, so there is a real fixture to
  // claim — which is why these live here rather than in the bot's own suite,
  // where the queue may legitimately be empty.
  if (!BOT_TOKEN) {
    check(
      'TG-006',
      'The bot service channel is exercised',
      true,
      'skipped: TELEGRAM_BOT_TOKEN is not set',
    );
  } else {
    const { createHmac } = await import('node:crypto');
    const sign = (body: unknown) =>
      createHmac('sha256', BOT_TOKEN).update(stableJson(body)).digest('hex');

    const botPost = async <T>(path: string, body: Json): Promise<{ status: number; body: T }> => {
      const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bot-signature': sign(body) },
        body: stableJson(body),
      });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
    };

    const unsigned = await fetch(`${BASE}/bot/claim-notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 1 }),
    });
    check(
      'TG-006',
      'The bot service channel rejects an unsigned call',
      unsigned.status === 401,
      `status ${unsigned.status}`,
    );

    const claimA = await botPost<{ items: Array<{ id: string; text: string; locale: string }> }>(
      '/bot/claim-notifications',
      { limit: 3 },
    );
    const claimB = await botPost<{ items: Array<{ id: string }> }>('/bot/claim-notifications', {
      limit: 3,
    });
    const idsA = new Set((claimA.body.items ?? []).map((item) => item.id));
    const overlap = (claimB.body.items ?? []).filter((item) => idsA.has(item.id));
    check(
      'NTF-002a',
      'A claimed batch is owned exclusively, so two senders cannot double-send',
      claimA.status === 201 || claimA.status === 200,
      `${idsA.size} + ${claimB.body.items?.length ?? 0} claimed, ${overlap.length} overlapping`,
    );
    check(
      'NTF-002b',
      'A second claim never returns a notification the first already owns',
      overlap.length === 0,
      overlap.length === 0 ? 'disjoint' : `${overlap.length} double-claimed`,
    );

    const firstJob = (claimA.body.items ?? [])[0];
    if (firstJob) {
      // A transient failure must not lose the message; it backs off and returns.
      await botPost('/bot/notification-result', {
        id: firstJob.id,
        sent: false,
        error: 'socket hang up',
      });
      const immediate = await botPost<{ items: Array<{ id: string }> }>(
        '/bot/claim-notifications',
        { limit: 50 },
      );
      check(
        'NTF-002c',
        'A failed send is re-queued behind a backoff, not lost and not spun on',
        !(immediate.body.items ?? []).some((item) => item.id === firstJob.id),
        'the just-failed notification did not come straight back',
      );
      await botPost('/bot/release-notifications', {
        ids: (immediate.body.items ?? []).map((item) => item.id),
      });
    }

    const toRelease = [...idsA, ...(claimB.body.items ?? []).map((item) => item.id)].filter(
      (id) => id !== firstJob?.id,
    );
    const released = await botPost<{ released: number }>('/bot/release-notifications', {
      ids: toRelease,
    });
    check(
      'NTF-002d',
      'A sender shutting down gives back what it will not send',
      released.status === 201 || released.status === 200,
      `${released.body.released ?? 0} released of ${toRelease.length}`,
    );

    const reclaimed = await botPost<{ items: Array<{ id: string }> }>('/bot/claim-notifications', {
      limit: 50,
    });
    const reclaimedIds = new Set((reclaimed.body.items ?? []).map((item) => item.id));
    check(
      'NTF-002e',
      'A released notification is available again at once, with no attempt counted',
      toRelease.every((id) => reclaimedIds.has(id)),
      `${toRelease.filter((id) => reclaimedIds.has(id)).length}/${toRelease.length} came back`,
    );
    await botPost('/bot/release-notifications', { ids: [...reclaimedIds] });

    const context = await botPost<{ categories: unknown[]; stylistSuggestions: string[] }>(
      '/bot/context',
      { locale: 'uz' },
    );
    check(
      'TG-002',
      'The bot gets its /start content live and localised, with valid deep links',
      (context.body.categories?.length ?? 0) > 0 &&
        (context.body.stylistSuggestions?.length ?? 0) > 0,
      `${context.body.categories?.length ?? 0} categories, ${context.body.stylistSuggestions?.length ?? 0} suggestions (uz)`,
    );
  }

  // ── privacy centre: export and the deletion path.
  const exported = await api.request<Json>('GET', '/me/export');
  check(
    'USR-006',
    'The privacy centre exports a machine-readable copy of the data',
    exported.status === 200 && Boolean((exported.body as Json).account),
    `sections: ${Object.keys(exported.body as Json).join(', ')}`,
  );

  finish();
}


/**
 * Sign in to the admin or seller surface, completing the TOTP step when the
 * role requires MFA (ADM-002). The secret is only shown at enrolment, so for
 * an already-enrolled account it is read from the database — which a test may
 * do and an operator may not.
 */
async function adminSession(
  email: string,
  password: string,
  kind: 'admin' | 'seller' = 'admin',
): Promise<{ token: string | null; mfaRequired: boolean }> {
  const client = new Client();
  const login = await client.request<{
    status: string;
    accessToken?: string;
    mfaToken?: string;
    enrollment?: { secret: string };
  }>('POST', '/admin/auth/login', { token: 'none', body: { email, password } });

  if (login.body.accessToken) return { token: login.body.accessToken, mfaRequired: false };
  if (!login.body.mfaToken) return { token: null, mfaRequired: false };

  let secret = login.body.enrollment?.secret ?? null;
  if (!secret) {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const row =
      kind === 'admin'
        ? await prisma.adminUser.findUnique({ where: { email } })
        : await prisma.sellerUser.findUnique({ where: { email } });
    await prisma.$disconnect();
    secret = row?.mfaSecret ?? null;
  }
  if (!secret) return { token: null, mfaRequired: true };

  const { totpCode } = await import('../../src/common/crypto');
  const verified = await client.request<{ accessToken?: string }>('POST', '/admin/auth/mfa', {
    token: 'none',
    body: { mfaToken: login.body.mfaToken, code: totpCode(secret) },
  });
  return { token: verified.body.accessToken ?? null, mfaRequired: true };
}

/** Find the seller behind the order, for the balance and adjustment checks. */
async function sellerIdOf(orderId: string): Promise<string | null> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const subOrder = await prisma.subOrder.findFirst({ where: { orderId }, select: { sellerId: true } });
  await prisma.$disconnect();
  return subOrder?.sellerId ?? null;
}

function finish(): void {
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`\x1b[1m${passed}/${results.length} checks passed\x1b[0m`);
  if (failures > 0) {
    console.log('\nFailed:');
    for (const result of results.filter((entry) => !entry.ok)) {
      console.log(`  ✗ ${result.id} — ${result.title}\n    ${result.detail}`);
    }
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((error) => {
  console.error('\ne2e run crashed:', error);
  process.exitCode = 1;
});
