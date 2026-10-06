/**
 * Unit tests for the rules engines — spec §18.1 (state transitions, fit rules,
 * promotions) plus the AI guardrails from §6.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type OutfitCandidate,
  type StyleIntent,
  DEFAULT_OUTFIT_TEMPLATES,
  IllegalTransitionError,
  LEDGER_EVENT_META,
  assembleOutfit,
  assertTransition,
  buildRefundEntries,
  buildSaleEntries,
  buyerCanCancel,
  canTransition,
  checkCandidateHardRules,
  checkPairHardRules,
  deriveOrderStatus,
  expandQuery,
  foldLatin,
  foldEntries,
  fromMajor,
  localeCompleteness,
  money,
  normalizeForSearch,
  orderPhase,
  parseStyleIntent,
  recommendSize,
  replaceItem,
  resolveLocale,
  searchVariants,
  shortestPath,
  signedAmount,
  templateForIntent,
  translate,
} from '../src/index.js';

const uzs = (major: number) => fromMajor(major, 'UZS');

describe('order state machine — ORD-010, ORD-011, §7.1', () => {
  it('walks the documented happy path', () => {
    const path = [
      'DRAFT',
      'QUOTED',
      'AWAITING_PAYMENT',
      'PAID',
      'CONFIRMED',
      'PICKING',
      'READY_FOR_HANDOVER',
      'IN_TRANSIT',
      'DELIVERED',
    ];
    for (let index = 0; index < path.length - 1; index += 1) {
      assert.ok(
        canTransition('order', path[index]!, path[index + 1]!),
        `${path[index]} -> ${path[index + 1]} should be legal`,
      );
    }
  });

  it('rejects an illegal jump and names what is allowed', () => {
    assert.throws(
      () => assertTransition('order', 'DRAFT', 'DELIVERED'),
      (error: unknown) => {
        assert.ok(error instanceof IllegalTransitionError);
        assert.equal(error.code, 'ILLEGAL_STATE_TRANSITION');
        assert.ok(error.allowed.includes('QUOTED'));
        return true;
      },
    );
  });

  it('treats a repeated status as a no-op rather than an error', () => {
    assert.ok(canTransition('order', 'PAID', 'PAID'));
  });

  it('never lets a cancelled order come back to life', () => {
    assert.equal(canTransition('order', 'CANCELLED', 'PAID'), false);
    assert.equal(shortestPath('order', 'CANCELLED', 'PAID').length, 0);
  });

  it('finds a legal route when the target is an end state, not a next hop', () => {
    // The case that bit the refund path: a return in flight gets refunded.
    const path = shortestPath('order', 'RETURN_REQUESTED', 'PARTIALLY_REFUNDED');
    assert.ok(path.length > 0);
    let current = 'RETURN_REQUESTED';
    for (const step of path) {
      assert.ok(canTransition('order', current, step), `${current} -> ${step}`);
      current = step;
    }
    assert.equal(current, 'PARTIALLY_REFUNDED');
  });

  it('routes PAID to a far delivery state through the documented chain', () => {
    const path = shortestPath('order', 'PAID', 'DELIVERED');
    assert.deepEqual(path, ['CONFIRMED', 'PICKING', 'READY_FOR_HANDOVER', 'IN_TRANSIT', 'DELIVERED']);
  });

  it('derives the master status from the suborders', () => {
    assert.equal(deriveOrderStatus(['CONFIRMED', 'CONFIRMED'], 'CAPTURED'), 'CONFIRMED');
    assert.equal(deriveOrderStatus(['DELIVERED', 'DELIVERED'], 'CAPTURED'), 'DELIVERED');
    assert.equal(deriveOrderStatus(['IN_TRANSIT', 'CONFIRMED'], 'CAPTURED'), 'IN_TRANSIT');
    assert.equal(deriveOrderStatus(['REJECTED', 'REJECTED'], 'CAPTURED'), 'CANCELLED');
    assert.equal(deriveOrderStatus(['RETURN_IN_PROGRESS', 'DELIVERED'], 'CAPTURED'), 'RETURN_REQUESTED');
    // One seller confirmed and one has not: nothing stronger than PAID is true yet.
    assert.equal(deriveOrderStatus(['CONFIRMED', 'PENDING_CONFIRMATION'], 'CAPTURED'), 'PAID');
  });

  it('lets the payment status override the fulfilment view', () => {
    assert.equal(deriveOrderStatus(['CONFIRMED'], 'FAILED'), 'PAYMENT_FAILED');
    assert.equal(deriveOrderStatus(['DELIVERED'], 'REFUNDED'), 'REFUNDED');
    assert.equal(deriveOrderStatus(['DELIVERED'], 'PENDING'), 'AWAITING_PAYMENT');
    assert.equal(deriveOrderStatus(['DELIVERED'], 'CHARGEBACK'), 'DISPUTED');
  });

  it('keeps payment and refund machines separate (ORD-010)', () => {
    assert.ok(canTransition('payment', 'PENDING', 'RECONCILIATION_HOLD'));
    assert.equal(canTransition('payment', 'CAPTURED', 'PENDING'), false);
    assert.ok(canTransition('return', 'INSPECTED', 'REFUND_PENDING'));
    assert.equal(canTransition('return', 'REQUESTED', 'REFUNDED'), false);
  });

  it('maps a status to a buyer-facing phase and cancel right', () => {
    assert.equal(orderPhase('PICKING'), 'preparing');
    assert.equal(orderPhase('IN_TRANSIT'), 'shipping');
    assert.equal(orderPhase('PAYMENT_FAILED'), 'problem');
    assert.ok(buyerCanCancel('PAID'));
    assert.equal(buyerCanCancel('IN_TRANSIT'), false);
  });

  it('enforces the catalogue publish workflow (CAT-009)', () => {
    assert.ok(canTransition('product', 'DRAFT', 'IN_REVIEW'));
    assert.ok(canTransition('product', 'IN_REVIEW', 'PUBLISHED'));
    assert.equal(canTransition('product', 'DRAFT', 'PUBLISHED'), false);
  });
});

describe('ledger vocabulary — PAY-008, Appendix B', () => {
  it('signs each event the way Appendix B does', () => {
    assert.equal(signedAmount('PLATFORM_COMMISSION', money(1000)).amount, '1000');
    assert.equal(signedAmount('REFUND_GROSS', money(1000)).amount, '-1000');
    assert.equal(signedAmount('PAYOUT', money(1000)).amount, '-1000');
    assert.equal(LEDGER_EVENT_META.SELLER_PAYABLE.affectsSellerBalance, true);
    assert.equal(LEDGER_EVENT_META.PLATFORM_COMMISSION.affectsPlatformRevenue, true);
  });

  it('rebuilds a seller balance from the entries alone', () => {
    const sale = buildSaleEntries({
      orderId: 'o1',
      orderItemId: 'i1',
      sellerId: 'S1',
      commissionRuleId: 'default-10pct',
      buyerPaidForGoods: uzs(1_000_000),
      commission: uzs(100_000),
      sellerPayable: uzs(900_000),
    });
    const refund = buildRefundEntries({
      orderId: 'o1',
      orderItemId: 'i1',
      sellerId: 'S1',
      refundId: 'r1',
      commissionRuleId: 'default-10pct',
      refundGross: uzs(400_000),
      commissionReversal: uzs(40_000),
      sellerPayableReversal: uzs(360_000),
    });

    const balances = foldEntries([...sale, ...refund]);
    // 900 000 owed, 360 000 reversed -> 540 000 still owed.
    assert.equal(balances.sellerPayable.get('S1')!.amount, uzs(540_000).amount);
    // 100 000 earned, 40 000 reversed -> 60 000 net revenue.
    assert.equal(balances.platformRevenue.amount, uzs(60_000).amount);
    assert.equal(balances.buyerSettlement.amount, uzs(600_000).amount);
  });

  it('nets a payout out of the seller balance', () => {
    const entries = [
      ...buildSaleEntries({
        orderId: 'o1',
        orderItemId: 'i1',
        sellerId: 'S1',
        commissionRuleId: 'r',
        buyerPaidForGoods: uzs(1_000_000),
        commission: uzs(100_000),
        sellerPayable: uzs(900_000),
      }),
      { event: 'PAYOUT' as const, amount: uzs(900_000), sellerId: 'S1' },
    ];
    assert.equal(foldEntries(entries).sellerPayable.get('S1')!.amount, '0');
  });
});

describe('size and fit — §6.2', () => {
  const chart = {
    id: 'c1',
    brandId: 'b1',
    categorySlug: 'shirts',
    system: 'letter',
    rows: [
      { sizeLabel: 'S', order: 1, body: { chest: 900, shoulder: 435 }, garment: { chest: 1020, shoulder: 445 } },
      { sizeLabel: 'M', order: 2, body: { chest: 960, shoulder: 450 }, garment: { chest: 1080, shoulder: 460 } },
      { sizeLabel: 'L', order: 3, body: { chest: 1020, shoulder: 465 }, garment: { chest: 1140, shoulder: 475 } },
    ],
    note: null,
  };
  const candidates = [
    { sizeLabel: 'S', inStock: true, order: 1 },
    { sizeLabel: 'M', inStock: true, order: 2 },
    { sizeLabel: 'L', inStock: true, order: 3 },
  ];

  it('returns no size and says so when there is no chart (FIT-001)', () => {
    const result = recommendSize({ chart: null, candidates, categorySlug: 'shirts' });
    assert.equal(result.recommendedSize, null);
    assert.equal(result.confident, false);
    assert.ok(result.chartOnly);
    assert.deepEqual(result.reasonCodes, ['no_chart_available']);
  });

  it('shows the chart rather than a guess when there is no profile (FIT-004)', () => {
    const result = recommendSize({ chart, candidates, categorySlug: 'shirts' });
    assert.equal(result.recommendedSize, null);
    assert.equal(result.confident, false);
    assert.ok(result.improveWith.includes('chest'));
  });

  it('matches measurements to a size with a reason (FIT-003)', () => {
    const result = recommendSize({
      chart,
      candidates,
      categorySlug: 'shirts',
      profile: {
        body: { chest: 960, shoulder: 450 },
        preferredFit: 'regular',
        consentPersonalizedFit: true,
      },
    });
    assert.equal(result.recommendedSize, 'M');
    assert.ok(result.reasonCodes.includes('body_measurements_match'));
    assert.ok(result.confidence > 0);
  });

  it('ignores the profile when consent is withdrawn (FIT-002, UAT-19)', () => {
    const result = recommendSize({
      chart,
      candidates,
      categorySlug: 'shirts',
      profile: {
        body: { chest: 960, shoulder: 450 },
        preferredFit: 'regular',
        consentPersonalizedFit: false,
      },
    });
    assert.equal(result.recommendedSize, null);
    assert.ok(result.chartOnly);
  });

  it('gives a different answer for the same body with a different preferred fit (FIT-006)', () => {
    const base = {
      chart,
      candidates,
      categorySlug: 'shirts',
      profile: { body: { chest: 960 }, consentPersonalizedFit: true },
    };
    const slim = recommendSize({ ...base, profile: { ...base.profile, preferredFit: 'slim' } });
    const oversized = recommendSize({ ...base, profile: { ...base.profile, preferredFit: 'oversized' } });
    assert.notEqual(slim.recommendedSize, oversized.recommendedSize);
  });

  it('caps confidence for a height/weight estimate', () => {
    const result = recommendSize({
      chart,
      candidates,
      categorySlug: 'shirts',
      profile: { heightMm: 1800, weightGrams: 80_000, consentPersonalizedFit: true },
    });
    assert.ok(result.confidence <= 0.6);
    assert.ok(result.reasonCodes.includes('height_weight_estimate'));
  });

  it('never recommends a size that is out of stock', () => {
    const result = recommendSize({
      chart,
      candidates: [
        { sizeLabel: 'S', inStock: true, order: 1 },
        { sizeLabel: 'M', inStock: false, order: 2 },
        { sizeLabel: 'L', inStock: true, order: 3 },
      ],
      categorySlug: 'shirts',
      profile: { body: { chest: 960, shoulder: 450 }, consentPersonalizedFit: true },
    });
    assert.notEqual(result.recommendedSize, 'M');
    assert.ok(result.reasonCodes.includes('out_of_stock_fallback'));
    assert.ok(result.confidence <= 0.5);
  });

  it('shifts by at most one size on strong community feedback (FIT-005)', () => {
    const feedback = { runsSmall: 30, runsTrue: 5, runsLarge: 1, sampleSize: 36 };
    const result = recommendSize({
      chart,
      candidates,
      categorySlug: 'shirts',
      profile: { body: { chest: 960, shoulder: 450 }, consentPersonalizedFit: true },
      feedback,
    });
    assert.equal(result.verdict, 'runs_small');
    assert.ok(['M', 'L'].includes(result.recommendedSize!));
  });

  it('ignores a feedback sample too small to mean anything', () => {
    const result = recommendSize({
      chart,
      candidates,
      categorySlug: 'shirts',
      profile: { body: { chest: 960 }, consentPersonalizedFit: true },
      feedback: { runsSmall: 2, runsTrue: 0, runsLarge: 0, sampleSize: 2 },
    });
    assert.equal(result.verdict, 'unknown');
  });

  it('never promises a fit in its explanation copy (FIT-003, AI-006)', () => {
    // The explanations shown *as* the recommendation must not speak of a
    // guarantee at all — a promise is exactly what FIT-003 forbids.
    const explanationKeys = [
      'fit.measurements_match',
      'fit.estimate',
      'fit.preferred_fit',
      'fit.usual_size',
      'fit.between_sizes',
      'fit.feedback_adjusted',
      'fit.low_confidence',
      'fit.out_of_stock_fallback',
      'fit.chart_only',
      'fit.no_chart',
      'fit.no_sizes',
    ];
    for (const locale of ['ru', 'uz', 'en'] as const) {
      for (const key of explanationKeys) {
        const text = translate(locale, key).toLowerCase();
        assert.ok(text.length > 0, `${locale}/${key} is empty`);
        assert.ok(!/guarantee|гарант|kafolat/u.test(text), `${locale}/${key} promises a fit`);
      }
    }

    // The disclaimer is the one place the word belongs, and only negated: a
    // disclaimer that avoided the word entirely would not be a disclaimer.
    const negated: Record<'ru' | 'uz' | 'en', RegExp> = {
      ru: /(?:не|а не)\s+гарант/u,
      uz: /kafolat\w*\s+emas/u,
      en: /not a guarantee/u,
    };
    for (const locale of ['ru', 'uz', 'en'] as const) {
      const text = translate(locale, 'fit.disclaimer').toLowerCase();
      assert.ok(text.length > 0);
      assert.match(text, negated[locale], `${locale} disclaimer must negate the guarantee`);
    }
  });
});

describe('intent parsing — AI-001', () => {
  it('parses the spec’s own example brief', () => {
    const intent = parseStyleIntent('Собери old money образ для офиса до 4 000 000 UZS');
    assert.ok(intent.styles.includes('old_money'));
    assert.ok(intent.occasions.includes('office'));
    assert.equal(intent.budget?.amount, uzs(4_000_000).amount);
    assert.equal(intent.language, 'ru');
  });

  it('parses the same brief in Uzbek', () => {
    const intent = parseStyleIntent('Ofis uchun old money uslubida kiyim, 4 mln so‘mgacha');
    assert.ok(intent.styles.includes('old_money'));
    assert.ok(intent.occasions.includes('office'));
    assert.equal(intent.budget?.amount, uzs(4_000_000).amount);
    assert.equal(intent.language, 'uz');
  });

  it('understands "млн" and "тыс" shorthands', () => {
    assert.equal(parseStyleIntent('образ до 6 млн').budget?.amount, uzs(6_000_000).amount);
    assert.equal(parseStyleIntent('образ до 800 тыс').budget?.amount, uzs(800_000).amount);
  });

  it('reads a negated colour as an exclusion, not a preference', () => {
    const intent = parseStyleIntent('Тёплый зимний комплект, без красного');
    assert.ok(intent.avoidColors.includes('red'));
    assert.ok(!intent.preferredColors.includes('red'));
    assert.equal(intent.season, 'WINTER');
  });

  it('does not mistake a small number for a budget', () => {
    assert.equal(parseStyleIntent('подбери 2 вещи на лето').budget, null);
  });

  it('lets UI chips override the parsed text', () => {
    const intent = parseStyleIntent('что-нибудь на вечер', {
      overrides: { budget: uzs(1_500_000), styles: ['minimal'] },
    });
    assert.equal(intent.budget?.amount, uzs(1_500_000).amount);
    assert.deepEqual(intent.styles, ['minimal']);
  });

  it('picks a template that matches the brief', () => {
    assert.equal(templateForIntent(['old_money'], ['office'], null).key, 'office-layered');
    assert.equal(templateForIntent(['sporty'], ['sport'], null).key, 'sport-active');
    assert.equal(templateForIntent(['evening'], ['wedding_guest'], null).key, 'evening');
    assert.equal(templateForIntent([], [], 'WINTER').key, 'winter-layered');
  });
});

describe('search normalisation — BUY-002', () => {
  it('folds the Uzbek apostrophe so both spellings match', () => {
    assert.equal(foldLatin('ko‘ylak'), foldLatin('koylak'));
    assert.equal(foldLatin("ko'ylak"), foldLatin('koylak'));
  });

  it('expands a Cyrillic query into its Latin form and back', () => {
    assert.ok(searchVariants('пиджак').some((variant) => variant.includes('pidjak')));
    assert.ok(expandQuery('pidjak').length > 1);
  });

  it('normalises case, punctuation and ё', () => {
    assert.equal(normalizeForSearch('Чёрный, Шёлк!'), 'черныи шелк');
  });
});

describe('outfit compatibility — AI-004', () => {
  const candidate = (overrides: Partial<OutfitCandidate>): OutfitCandidate => ({
    skuId: 's1',
    productId: 'p1',
    sellerId: 'seller1',
    brandId: 'brand1',
    brandName: 'Brand',
    title: 'Item',
    categorySlug: 'shirts',
    slot: 'TOP',
    price: uzs(500_000),
    compareAtPrice: null,
    sizeLabel: 'M',
    available: 5,
    styleTags: ['minimal'],
    colorFamily: 'white',
    silhouette: 'straight',
    formality: 3,
    warmth: 2,
    season: 'ALL_SEASON',
    imageUrl: null,
    ...overrides,
  });

  const intent: StyleIntent = {
    styles: ['old_money'],
    occasions: ['office'],
    season: null,
    budget: uzs(4_000_000),
    preferredColors: [],
    avoidColors: [],
    preferredBrandIds: [],
    excludedBrandIds: [],
    requiredSlots: [],
    excludedSlots: [],
  };

  it('blocks a candidate that is out of stock (AI-002)', () => {
    assert.equal(
      checkCandidateHardRules(candidate({ available: 0 }), intent),
      'out_of_stock',
    );
  });

  it('blocks a colour the shopper asked to avoid', () => {
    assert.equal(
      checkCandidateHardRules(candidate({ colorFamily: 'red' }), { ...intent, avoidColors: ['red'] }),
      'color_clash',
    );
  });

  it('blocks a formality gap wider than two levels', () => {
    assert.equal(
      checkPairHardRules(
        candidate({ formality: 5, slot: 'TOP' }),
        candidate({ productId: 'p2', formality: 1, slot: 'FOOTWEAR' }),
      ),
      'formality_spread',
    );
  });

  it('blocks a conflicting style pair, e.g. business formal with sportswear', () => {
    assert.equal(
      checkPairHardRules(
        candidate({ styleTags: ['business_formal'], slot: 'TOP' }),
        candidate({ productId: 'p2', styleTags: ['sporty'], slot: 'FOOTWEAR', formality: 4 }),
      ),
      'style_conflict',
    );
  });

  it('blocks the same product appearing twice', () => {
    assert.equal(
      checkPairHardRules(candidate({ slot: 'TOP' }), candidate({ slot: 'MID_LAYER' })),
      'duplicate_product',
    );
  });

  it('honours a declared incompatibility from the catalogue', () => {
    assert.equal(
      checkPairHardRules(
        candidate({ slot: 'TOP', incompatibleWithSlots: ['FOOTWEAR'] }),
        candidate({ productId: 'p2', slot: 'FOOTWEAR' }),
      ),
      'declared_incompatibility',
    );
  });

  it('assembles a look inside the budget and reports the exact total (AI-005)', () => {
    const template = DEFAULT_OUTFIT_TEMPLATES.find((entry) => entry.key === 'office-layered')!;
    const bySlot = new Map([
      ['TOP' as const, [candidate({ productId: 'top', skuId: 'top-m', price: uzs(520_000), styleTags: ['old_money'] })]],
      ['BOTTOM' as const, [candidate({ productId: 'bottom', skuId: 'bot-50', slot: 'BOTTOM', price: uzs(890_000), styleTags: ['old_money'], colorFamily: 'grey' })]],
      ['FOOTWEAR' as const, [candidate({ productId: 'shoes', skuId: 'sh-42', slot: 'FOOTWEAR', price: uzs(1_180_000), styleTags: ['old_money'], colorFamily: 'brown', formality: 4 })]],
    ]);

    const outfit = assembleOutfit({ template, intent, candidatesBySlot: bySlot });
    assert.ok(outfit);
    assert.equal(outfit!.items.length, 3);
    assert.ok(outfit!.withinBudget);
    assert.equal(outfit!.total.amount, uzs(2_590_000).amount);
  });

  it('returns nothing rather than exceeding the budget', () => {
    const template = DEFAULT_OUTFIT_TEMPLATES.find((entry) => entry.key === 'office-layered')!;
    const bySlot = new Map([
      ['TOP' as const, [candidate({ productId: 'top', price: uzs(3_000_000) })]],
      ['BOTTOM' as const, [candidate({ productId: 'bottom', slot: 'BOTTOM', price: uzs(3_000_000) })]],
      ['FOOTWEAR' as const, [candidate({ productId: 'shoes', slot: 'FOOTWEAR', price: uzs(3_000_000) })]],
    ]);
    const outfit = assembleOutfit({
      template,
      intent: { ...intent, budget: uzs(1_000_000) },
      candidatesBySlot: bySlot,
    });
    assert.equal(outfit, null);
  });

  it('keeps the intent and the budget when one item is replaced (AI-007)', () => {
    const template = DEFAULT_OUTFIT_TEMPLATES.find((entry) => entry.key === 'office-layered')!;
    const bySlot = new Map([
      ['TOP' as const, [candidate({ productId: 'top', price: uzs(520_000), styleTags: ['old_money'] })]],
      ['BOTTOM' as const, [candidate({ productId: 'bottom', slot: 'BOTTOM', price: uzs(890_000), styleTags: ['old_money'] })]],
      ['FOOTWEAR' as const, [candidate({ productId: 'shoes', skuId: 'sh-1', slot: 'FOOTWEAR', price: uzs(1_180_000), styleTags: ['old_money'], formality: 4 })]],
    ]);
    const outfit = assembleOutfit({ template, intent, candidatesBySlot: bySlot })!;

    const alternatives = replaceItem(outfit, 'FOOTWEAR', {
      intent,
      candidates: [
        candidate({ productId: 'shoes2', skuId: 'sh-2', slot: 'FOOTWEAR', price: uzs(940_000), styleTags: ['old_money'], formality: 3 }),
        // Over budget once the other items are counted: must be flagged.
        candidate({ productId: 'shoes3', skuId: 'sh-3', slot: 'FOOTWEAR', price: uzs(9_000_000), styleTags: ['old_money'], formality: 3 }),
      ],
      excludeSkuIds: new Set(['sh-1']),
    });

    assert.ok(alternatives.length >= 1);
    assert.equal(alternatives[0]!.candidate.skuId, 'sh-2');
    assert.ok(alternatives[0]!.withinBudget);
    assert.ok(alternatives.some((entry) => entry.withinBudget === false));
  });
});

describe('localisation — USR-001, ADM-011, NFR-008', () => {
  it('reports which required locales a field is missing', () => {
    assert.deepEqual(localeCompleteness({ ru: 'Пальто' }).missing, ['uz']);
    assert.ok(localeCompleteness({ ru: 'Пальто', uz: 'Palto' }).complete);
    assert.deepEqual(localeCompleteness({ ru: '  ', uz: '' }).missing, ['ru', 'uz']);
  });

  it('translates every order status into all three locales', () => {
    for (const locale of ['ru', 'uz', 'en'] as const) {
      for (const status of ['PAID', 'IN_TRANSIT', 'REFUNDED', 'PARTIALLY_CANCELLED']) {
        const text = translate(locale, `order.status.${status}`);
        assert.notEqual(text, `order.status.${status}`, `${locale}/${status} is untranslated`);
      }
    }
  });

  it('interpolates parameters', () => {
    assert.match(translate('ru', 'notify.payment_received', { orderNumber: 'FM-1' }), /FM-1/);
  });

  it('defaults an unknown client locale to Russian, the market lingua franca', () => {
    assert.equal(resolveLocale('kk-KZ'), 'ru');
    assert.equal(resolveLocale('uz-Latn'), 'uz');
    assert.equal(resolveLocale(null), 'ru');
  });
});
