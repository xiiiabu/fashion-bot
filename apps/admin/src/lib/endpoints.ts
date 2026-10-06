/**
 * Operator API surface.
 *
 * Every type here was read off the running API rather than inferred from the
 * spec, because the Mini App's first pass was written from memory and a dozen
 * screens silently broke on fields that did not exist. Where a shape is only
 * partially modelled, the parts that are modelled are the ones the UI reads.
 *
 * Money is `Money` everywhere — `{ amount: string, currency }` — and is never
 * parsed into a Number. A finance panel that rounds is a finance panel that
 * disagrees with the ledger.
 */

import type { Locale, Money, ProductLifecycle } from '@fashion/core';
import { idempotencyKey, request, session, type Principal } from './api';
import type { SellerOnboardingStatus } from './status';

/* ── Auth (ADM-002) ──────────────────────────────────────────────────────── */

export interface LoginResult {
  status: 'OK' | 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  accessToken?: string;
  expiresIn?: number;
  mfaToken?: string;
  /** Present on first login for a role that requires MFA. */
  enrollment?: { secret: string; uri: string };
  principal?: Principal;
}

export const auth = {
  login: (email: string, password: string) =>
    request<LoginResult>('/admin/auth/login', {
      method: 'POST',
      body: { email, password },
      anonymous: true,
    }),

  /** ADM-002: the second factor. `secret` is sent only while enrolling. */
  verifyMfa: (mfaToken: string, code: string, secret?: string) =>
    request<LoginResult>('/admin/auth/mfa', {
      method: 'POST',
      body: { mfaToken, code, ...(secret ? { secret } : {}) },
      anonymous: true,
    }),

  logout: async () => {
    await request('/admin/auth/logout', { method: 'POST' }).catch(() => {});
    session.clear();
  },

  me: () =>
    request<{
      kind: 'admin' | 'seller';
      id: string;
      email: string;
      roles: string[];
      permissions: string[];
      mfaVerified: boolean;
      sellerId?: string;
      sellerName?: string;
    }>('/admin/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/admin/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),

  sessions: () =>
    request<{ items: Array<{ id: string; createdAt: string; lastSeenAt: string; current: boolean }> }>(
      '/admin/auth/sessions',
    ),
};

/* ── Dashboard (§10 Dashboard, ANL-002) ──────────────────────────────────── */

export interface Dashboard {
  period: { from: string; to: string };
  sales: {
    gmv: Money;
    goods: Money;
    refunded: Money;
    paidOrders: number;
    averageOrderValue: Money;
    itemsPerOrder: number;
    activeSellers: number;
  };
  /** ANL-002: these come from the ledger, not recomputed from orders. */
  monetization: {
    commissionAccrued: Money;
    commissionReversed: Money;
    commissionNet: Money;
    effectiveTakeRatePercent: number;
    nominalRatePercent: number;
    platformDiscounts: Money;
    sellerDiscounts: Money;
    pspFees: Money;
    payouts: Money;
  };
  conversion: {
    steps: Record<string, number>;
    rates: Record<string, number>;
  };
  ai: {
    sessions: number;
    addWholeLookRate: number;
    purchaseRate: number;
    replacementsPerSession: number;
    aiOrders: number;
    aiItems: number;
    aiGmv: Money;
    aiGmvSharePercent: number;
  };
  operations: {
    stockRejections: number;
    stockRejectionRatePercent: number;
    medianConfirmHours: number | null;
    overdueConfirmations: number;
    shippedSubOrders: number;
    medianDeliveryDays: number | null;
    returnRequests: number;
  };
  payments: {
    providers: Array<{ provider: string; captured: number; failed: number; amount: Money }>;
    unmatchedRecords: number;
    medianRefundHours: number | null;
  };
  quality: {
    fitFeedback: Record<string, number>;
    returns: Record<string, number>;
    reviews: { count: number; average: number | null };
    lowConfidenceFitPurchases: number;
  };
  series: Array<{ date: string; gmv: Money; orders: number; commission: Money }>;
  topSellers: Array<{
    sellerId: string;
    name: string;
    qualityScore: number | null;
    subOrders: number;
    goods: Money;
    commission: Money;
  }>;
  alerts: Array<{ id: string; kind: string; severity: string; message: string; createdAt: string }>;
  pendingApprovals: number;
}

export const dashboard = {
  get: (from?: string, to?: string) => request<Dashboard>('/admin/dashboard', { query: { from, to } }),
};

/* ── Orders (§10.3) ──────────────────────────────────────────────────────── */

export interface AdminOrderRow {
  id: string;
  number: string;
  userId: string;
  status: string;
  goodsTotalMinor: string;
  deliveryTotalMinor: string;
  grandTotalMinor: string;
  refundedTotalMinor: string;
  commissionTotalMinor: string;
  currency: string;
  locale: Locale;
  placedAt?: string;
  createdAt?: string;
}

export interface Paged<T> {
  total: number;
  rows: T[];
  nextCursor?: string | null;
}

export const orders = {
  list: (params: { status?: string; q?: string; sellerId?: string; limit?: number; offset?: number }) =>
    request<Paged<AdminOrderRow>>('/admin/orders', { query: params }),
  get: (id: string) => request<Record<string, unknown>>(`/admin/orders/${id}`),
  overdue: () => request<{ items: Array<Record<string, unknown>> }>('/admin/orders-overdue'),
  /** ADM-001: operations can move a suborder the seller has not. */
  advanceSubOrder: (id: string, status: string, note?: string) =>
    request<Record<string, unknown>>(`/admin/suborders/${id}/advance`, {
      method: 'POST',
      body: { status, note },
      idempotencyKey: idempotencyKey(`advance:${id}:${status}`),
    }),
};

/* ── Catalogue moderation (§10.2, CAT-006) ───────────────────────────────── */

export interface ProductRow {
  id: string;
  slug: string;
  externalId: string | null;
  title: string;
  titleUz: string | null;
  brand: { id: string; name: string } | string | null;
  seller: { id: string; displayName: string } | string | null;
  category: { id: string; name: string } | string | null;
  lifecycle: string;
  version: number;
  imageUrl: string | null;
  skuCount: number;
  onHand: number;
  priceFrom: Money | null;
  publishedAt: string | null;
  updatedAt: string;
  /** ADM-011: whether every required locale is filled. */
  localeComplete: boolean;
}

/** The three numbers a stock update can set; each is optional on its own. */
export interface StockInput {
  onHand?: number;
  /** INV-004: units held back from sale, so the last one is never oversold. */
  safetyStock?: number;
  lowStockThreshold?: number;
}

export interface ImportReport {
  jobId: string;
  dryRun: boolean;
  summary: { total: number; created: number; updated: number; invalid: number };
  errors: Array<{ row?: number; message?: string; [extra: string]: unknown }>;
}

/** The states a seller may move their own suborder into (SEL-004). */
export type SellerAdvanceTarget =
  | 'PICKING'
  | 'READY_FOR_HANDOVER'
  | 'HANDED_OVER'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'COMPLETED';

/**
 * CAT-006 / ADM-011. `blockers` stop publication; `warnings` do not.
 * `localeCompleteness` names which locale each required field is missing, which
 * is the difference between "fill in the translations" and a usable instruction.
 */
export interface PublishCheck {
  ready: boolean;
  blockers: Array<{ code: string; message: string; field?: string }>;
  warnings: Array<{ code: string; message: string }>;
  localeCompleteness: Record<string, { complete: boolean; missing: Locale[] }>;
}

export const catalog = {
  products: (params: {
    q?: string;
    lifecycle?: string;
    sellerId?: string;
    limit?: number;
    offset?: number;
  }) => request<Paged<ProductRow>>('/admin/products', { query: params }),

  product: (id: string) => request<Record<string, unknown>>(`/admin/products/${id}`),

  /** CAT-006: the checklist that must pass before a product can be published. */
  publishCheck: (id: string) => request<PublishCheck>(`/admin/products/${id}/publish-check`),

  /** CAT-009: the target state, which the machine validates against the current one. */
  setLifecycle: (id: string, to: ProductLifecycle, note?: string) =>
    request<Record<string, unknown>>(`/admin/products/${id}/lifecycle`, {
      method: 'POST',
      body: { to, note },
      idempotencyKey: idempotencyKey(`lifecycle:${id}:${to}`),
    }),

  setStock: (skuId: string, body: StockInput) =>
    request<Record<string, unknown>>(`/admin/skus/${skuId}/stock`, { method: 'PATCH', body }),

  movements: (skuId: string) =>
    request<{ items: Array<Record<string, unknown>> }>(`/admin/skus/${skuId}/movements`),

  staleInventory: () => request<{ items: Array<Record<string, unknown>> }>('/admin/inventory/stale'),

  categories: () =>
    request<{
      items: Array<{
        id: string;
        slug: string;
        name: string;
        parent: { id: string; name: string } | null;
        slot: string | null;
        gender: string | null;
        isActive: boolean;
        productCount: number;
      }>;
    }>('/admin/categories'),

  reindex: () => request<{ ok: true; indexed?: number }>('/admin/catalog/reindex', { method: 'POST' }),

  importTemplate: () => request<Response>('/admin/products/import/template', { raw: true }),
  importJobs: () => request<{ items: Array<Record<string, unknown>> }>('/admin/products/import/jobs'),
  /** ADM-004: dry run first, then commit. */
  importCsv: (body: { fileName: string; content: string; sellerId: string; dryRun: boolean }) =>
    request<ImportReport>('/admin/products/import', { method: 'POST', body }),
};

/* ── Sellers (§10.1, SEL-001) ────────────────────────────────────────────── */

export interface SellerRow {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  onboardingStatus: string;
  verified: boolean;
  settlementMode: string;
  handlingDays: number;
  /** A 0…1 weighted mean of the quality factors; render as a percentage. */
  qualityScore: number | null;
  /** SEL-005: the amount withheld from payouts, not a boolean switch. */
  payoutHold: Money;
  returnReserveBps: number;
  counts: { products?: number; subOrders?: number; orderItems?: number };
  suspendedAt: string | null;
  createdAt: string;
}

export const sellers = {
  list: (params: { q?: string; status?: string; limit?: number; offset?: number } = {}) =>
    request<Paged<SellerRow>>('/admin/sellers', { query: params }),
  get: (id: string) => request<Record<string, unknown>>(`/admin/sellers/${id}`),
  update: (id: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/admin/sellers/${id}`, { method: 'PATCH', body }),
  setOnboarding: (id: string, status: SellerOnboardingStatus, note?: string) =>
    request<Record<string, unknown>>(`/admin/sellers/${id}/onboarding`, {
      method: 'POST',
      body: { status, note },
    }),
  quality: (id: string) => request<QualityScore>(`/admin/sellers/${id}/quality`),
  balance: (id: string) => request<SellerBalance>(`/admin/sellers/${id}/balance`),
  contracts: (id: string) => request<{ items: Array<Record<string, unknown>> }>(`/admin/sellers/${id}/contracts`),
};

/* ── Finance (§8, PAY-008 … PAY-013) ─────────────────────────────────────── */

export interface LedgerRow {
  id: string;
  /** PAY-008: the append-only sequence; a BigInt, so a decimal string here. */
  sequence: string;
  accountId: string;
  event: string;
  amountMinor: string;
  signedAmountMinor: string;
  currency: string;
  sellerId: string | null;
  orderId: string | null;
  orderItemId: string | null;
  paymentId: string | null;
  refundId: string | null;
  payoutBatchId: string | null;
  adjustmentId: string | null;
  commissionRuleId: string | null;
  memo: string | null;
  correlationId: string | null;
  dedupeKey?: string | null;
  createdAt?: string;
}

/** SEL-008: the quality score, broken into the factors that produced it. */
export interface QualityFactor {
  factor: string;
  value: number;
  weight: number;
  note: string;
}

export interface QualityScore {
  score: number | null;
  factors: QualityFactor[];
}

export interface LedgerVerification {
  balances: {
    checked: number;
    corrected: number;
    drifts: Array<{ accountId: string; cached: string; computed: string }>;
  };
  orders: {
    ok: boolean;
    orderCommissionMinor: string;
    ledgerCommissionMinor: string;
    deltaMinor: string;
  };
}

export interface PlatformTotals {
  salesGross: Money;
  refunds: Money;
  netSales: Money;
  commission: Money;
  commissionReversals: Money;
  netCommission: Money;
  platformDiscounts: Money;
  sellerDiscounts: Money;
  pspFees: Money;
  payouts: Money;
  adjustments: Money;
  /** Net commission over net sales, in basis points. Nominal is 1000 (10%). */
  effectiveTakeRateBps: number;
  entryCount: number;
}

export interface CommissionRule {
  id: string;
  code: string;
  version: number;
  /** Null means the rule applies platform-wide. */
  sellerId: string | null;
  categoryId: string | null;
  rateBps: number;
  includesDelivery: boolean;
  sellerDiscountReducesBase: boolean;
  platformDiscountReducesBase: boolean;
  rounding: 'HALF_UP' | 'FLOOR' | 'CEIL';
  minFeeMinor: string | null;
  maxFeeMinor: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isDefault: boolean;
  note: string | null;
  createdByAdminId: string | null;
  createdAt: string;
}

export type ReconciliationStatus =
  | 'MATCHED'
  | 'UNMATCHED_INTERNAL'
  | 'UNMATCHED_PROVIDER'
  | 'AMOUNT_MISMATCH'
  | 'RESOLVED';

export interface ReconciliationRow {
  id: string;
  provider: string;
  /** The settlement day, as YYYY-MM-DD. */
  periodDate: string;
  status: ReconciliationStatus;
  internalAmount: Money | null;
  providerAmount: Money | null;
  /** provider − internal; null when one of the two sides is missing. */
  delta: Money | null;
  providerReference: string | null;
  orderNumber: string | null;
  orderId: string | null;
  paymentStatus: string | null;
  ownerAdminId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface ReconciliationDay {
  date: string;
  matched: number;
  unmatchedInternal: number;
  unmatchedProvider: number;
  amountMismatch: number;
  resolved: number;
}

export interface ReconciliationRunSummary {
  periodDate: string;
  provider: string;
  matched: number;
  unmatchedInternal: number;
  unmatchedProvider: number;
  amountMismatch: number;
  internalTotalMinor: string;
  providerTotalMinor: string;
}

export interface RefundRow {
  id: string;
  number: string;
  orderNumber: string;
  status: string;
  amount: Money;
  commissionReversal: Money;
  reason: string | null;
  provider: string | null;
  requiresApproval: boolean;
  createdAt: string;
  items: Array<{ title: string; quantity: number; amount: Money }>;
}

export interface SellerBalance {
  sellerId: string;
  currency: string;
  salesGross: Money;
  commission: Money;
  discountsSellerFunded: Money;
  refunds: Money;
  commissionReversals: Money;
  adjustments: Money;
  paidOut: Money;
  payableBalance: Money;
  hold: Money;
  reserve: Money;
  availableForPayout: Money;
}

export const finance = {
  ledger: (params: { sellerId?: string; event?: string; orderId?: string; limit?: number; offset?: number } = {}) =>
    request<Paged<LedgerRow>>('/admin/ledger', { query: params }),

  /**
   * PAY-003: the effective take rate next to the nominal one. A divergence
   * from 1000 bps is refunds, platform-funded discounts or a per-seller rule —
   * all legitimate, and all worth seeing rather than averaging away.
   */
  platformTotals: (from?: string, to?: string) =>
    request<PlatformTotals>('/admin/ledger/platform-totals', { query: { from, to } }),

  /**
   * PAY-008: proves the money adds up, two ways at once.
   *
   * `balances` rebuilds every cached account balance from the entries and
   * corrects any that had drifted. `orders` checks the commission the orders
   * say was charged against the commission the ledger actually holds — the
   * two can agree internally and still disagree with each other, which is the
   * failure that matters.
   */
  verifyLedger: () => request<LedgerVerification>('/admin/ledger/verify', { method: 'POST' }),

  payoutsDue: () =>
    request<{ items: Array<{ sellerId: string; displayName: string; available: Money }> }>(
      '/admin/payouts/due',
    ),

  payouts: (params: { status?: string; sellerId?: string; limit?: number } = {}) =>
    request<Paged<Record<string, unknown>>>('/admin/payouts', { query: params }),

  payout: (id: string) => request<Record<string, unknown>>(`/admin/payouts/${id}`),

  createPayout: (body: { sellerIds?: string[]; periodFrom?: string; periodTo?: string; note?: string }) =>
    request<Record<string, unknown>>('/admin/payouts', {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey('payout:create'),
    }),

  submitPayout: (id: string) =>
    request<Record<string, unknown>>(`/admin/payouts/${id}/submit`, {
      method: 'POST',
      idempotencyKey: idempotencyKey(`payout:submit:${id}`),
    }),

  /** ADM-005: a payout needs a second pair of eyes. */
  approvePayout: (id: string, note?: string) =>
    request<Record<string, unknown>>(`/admin/payouts/${id}/approve`, {
      method: 'POST',
      body: { note },
      idempotencyKey: idempotencyKey(`payout:approve:${id}`),
    }),

  settlePayout: (id: string, reference: string) =>
    request<Record<string, unknown>>(`/admin/payouts/${id}/settle`, {
      method: 'POST',
      body: { reference },
      idempotencyKey: idempotencyKey(`payout:settle:${id}`),
    }),

  /**
   * PAY-011: by default only the unresolved records — the point of the queue
   * is what does not match, not the thousands that do.
   */
  reconciliation: (params: { status?: string; provider?: string; limit?: number; offset?: number } = {}) =>
    request<Paged<ReconciliationRow>>('/admin/reconciliation', { query: params }),

  reconciliationSummary: () =>
    request<{ items: ReconciliationDay[] }>('/admin/reconciliation/summary'),

  runReconciliation: (body: { date?: string; provider?: string } = {}) =>
    request<{ summaries: ReconciliationRunSummary[] }>('/admin/reconciliation/run', {
      method: 'POST',
      body,
    }),

  /** Resolving needs an explanation of at least 8 characters, and may release the payment. */
  resolveReconciliation: (id: string, body: { resolution: string; releasePayment?: boolean }) =>
    request<Record<string, unknown>>(`/admin/reconciliation/${id}/resolve`, { method: 'POST', body }),

  refundsPreview: (body: { orderId: string; items: Array<{ orderItemId: string; quantity: number }> }) =>
    request<Record<string, unknown>>('/admin/refunds/preview', { method: 'POST', body }),

  createRefund: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/admin/refunds', {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey('refund:create'),
    }),

  approveRefund: (id: string, note?: string) =>
    request<Record<string, unknown>>(`/admin/refunds/${id}/approve`, { method: 'POST', body: { note } }),

  refunds: (params: { status?: string; limit?: number } = {}) =>
    request<Paged<RefundRow>>('/admin/refunds', { query: params }),

  commissionRules: (code?: string) =>
    request<{ items: CommissionRule[] }>('/admin/commission-rules', { query: { code } }),

  /** PAY-002: a new rule is a new version; existing orders keep their own. */
  createCommissionRule: (body: {
    code: string;
    sellerId?: string | null;
    categoryId?: string | null;
    rateBps: number;
    includesDelivery?: boolean;
    sellerDiscountReducesBase?: boolean;
    platformDiscountReducesBase?: boolean;
    rounding?: 'HALF_UP' | 'FLOOR' | 'CEIL';
    minFeeMinor?: string | null;
    maxFeeMinor?: string | null;
    effectiveFrom?: string;
    note?: string;
    isDefault?: boolean;
  }) => request<CommissionRule>('/admin/commission-rules', { method: 'POST', body }),

  /**
   * PAY-009: an adjustment is the only way to move a balance outside the
   * normal flow of orders, so it needs a reason and a second approver.
   * `amountMinor` is signed: negative takes money off the seller's balance.
   */
  createAdjustment: (body: {
    sellerId: string;
    amountMinor: string;
    currency?: Money['currency'];
    reason: string;
    category?: string;
    orderId?: string | null;
  }) =>
    request<Record<string, unknown>>('/admin/adjustments', {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey('adjustment:create'),
    }),

  approveAdjustment: (id: string, note?: string) =>
    request<Record<string, unknown>>(`/admin/adjustments/${id}/approve`, {
      method: 'POST',
      body: { note },
    }),

  exportLedger: (params: { from?: string; to?: string; sellerId?: string } = {}) =>
    request<Response>('/admin/exports/ledger', { query: params, raw: true }),
};

/* ── Returns (§9) ────────────────────────────────────────────────────────── */

export interface ReturnRow {
  id: string;
  number: string;
  orderNumber: string;
  status: string;
  reason: string | null;
  comment: string | null;
  refundTotal: Money;
  createdAt: string;
  items: ReturnItemRow[];
  lastInspection: { outcome: string; classification: string | null; note: string | null } | null;
  evidenceCount: number;
}

export interface ReturnItemRow {
  /** The ReturnItem id — what `inspect` keys its verdicts by. */
  id: string;
  orderItemId: string;
  title: string;
  brandName: string | null;
  sizeLabel: string;
  quantity: number;
  reason: string;
  refundAmount: Money;
  imageUrl: string | null;
  skuId: string;
  inspectionResult: string | null;
  restocked: boolean;
}

export type InspectionOutcome = 'ACCEPTED' | 'REJECTED' | 'PARTIAL';

export interface InspectionInput {
  items: Array<{
    returnItemId: string;
    outcome: InspectionOutcome;
    restock: boolean;
    note?: string;
  }>;
  classification?: string;
  note?: string;
}

export const returns = {
  list: (params: { status?: string; sellerId?: string; limit?: number } = {}) =>
    request<Paged<ReturnRow>>('/admin/returns', { query: params }),
  decide: (id: string, approve: boolean, note?: string) =>
    request<Record<string, unknown>>(`/admin/returns/${id}/decide`, {
      method: 'POST',
      body: { approve, note },
    }),
  received: (id: string) => request<Record<string, unknown>>(`/admin/returns/${id}/received`, { method: 'POST' }),
  /** RET-006: each returned unit gets its own verdict and restock decision. */
  inspect: (id: string, body: InspectionInput) =>
    request<Record<string, unknown>>(`/admin/returns/${id}/inspect`, { method: 'POST', body }),
  refundPending: (id: string) =>
    request<Record<string, unknown>>(`/admin/returns/${id}/refund-pending`, { method: 'POST' }),
  /** RET-009: the size-driven return rate is the number the catalogue is judged on. */
  stats: () =>
    request<{
      total: number;
      bySizeReason: number;
      reasons: Array<{ reason: string; count: number; share: number; sellerFault: boolean }>;
    }>('/admin/returns/stats'),
};

/* ── CMS (ADM-009) ───────────────────────────────────────────────────────── */

export interface CmsBlock {
  id: string;
  key: string;
  kind: CmsBlockKind;
  titleRu: string | null;
  titleUz: string | null;
  titleEn: string | null;
  subtitleRu: string | null;
  subtitleUz: string | null;
  subtitleEn: string | null;
  ctaLabelRu: string | null;
  ctaLabelUz: string | null;
  ctaLabelEn: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  config: Record<string, unknown>;
  sortOrder: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** ADM-011: the locales this block claims to be translated into. */
  locales: Locale[];
}

export type CmsBlockKind =
  | 'HERO'
  | 'BANNER'
  | 'PRODUCT_RAIL'
  | 'BRAND_RAIL'
  | 'CATEGORY_GRID'
  | 'LOOK_RAIL'
  | 'EDITORIAL'
  | 'AI_PROMPT'
  | 'SALE_RAIL';

export interface CmsPreviewBlock {
  key: string;
  kind: CmsBlockKind;
  isActive: boolean;
  title: string | null;
  subtitle: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  scheduled: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface ContentPageRow {
  id: string;
  slug: string;
  locale: Locale;
  title: string;
  body: string;
  kind: string;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const cms = {
  blocks: () => request<{ items: CmsBlock[] }>('/admin/cms/blocks'),
  saveBlock: (body: Partial<CmsBlock> & { key: string; kind: CmsBlockKind }) =>
    request<CmsBlock>('/admin/cms/blocks', { method: 'POST', body }),
  deleteBlock: (key: string) => request<void>(`/admin/cms/blocks/${key}`, { method: 'DELETE' }),
  /** CNT-002: what the Mini App would render for a locale at a point in time. */
  preview: (locale: Locale, at?: string) =>
    request<{ items: CmsPreviewBlock[] }>('/admin/cms/preview', { query: { locale, at } }),

  pages: () => request<{ items: ContentPageRow[] }>('/admin/cms/pages'),

  savePage: (body: {
    slug: string;
    locale: Locale;
    title: string;
    body: string;
    kind?: string;
    publish?: boolean;
  }) => request<ContentPageRow>('/admin/cms/pages', { method: 'POST', body }),
};

/* ── Support, IAM, audit, settings ───────────────────────────────────────── */

export type TicketStatus =
  | 'OPEN'
  | 'WAITING_CUSTOMER'
  | 'WAITING_SELLER'
  | 'ESCALATED'
  | 'RESOLVED'
  | 'CLOSED';

/** ADM-007: name, phone and address arrive masked unless the role may see PII. */
export interface TicketRow {
  id: string;
  number: string;
  subject: string;
  status: TicketStatus;
  category: string;
  priority: string;
  customer: { id: string; name: string; phone: string | null };
  order: { id: string; number: string; status: string } | null;
  messageCount: number;
  assignedAdminId: string | null;
  createdAt: string;
  firstResponseAt: string | null;
}

export interface TicketDetail {
  id: string;
  number: string;
  subject: string;
  status: TicketStatus;
  category: string;
  priority: string;
  customer: {
    id: string;
    name: string;
    phone: string | null;
    locale: Locale;
    addresses: Array<{ id: string; city: string; street: string | null; building: string | null }>;
  };
  order: {
    id: string;
    number: string;
    status: string;
    grandTotalMinor: string;
    currency: string;
    addressSnapshot: unknown;
  } | null;
  messages: Array<{
    id: string;
    author: 'USER' | 'AGENT' | 'SYSTEM';
    authorId: string | null;
    body: string;
    isInternal: boolean;
    createdAt: string;
  }>;
  createdAt: string;
}

export const support = {
  tickets: (params: { status?: string; search?: string; limit?: number; offset?: number } = {}) =>
    request<Paged<TicketRow>>('/admin/tickets', { query: params }),

  ticket: (id: string) => request<TicketDetail>(`/admin/tickets/${id}`),

  /**
   * A reply moves the ticket: answering a customer puts it in
   * WAITING_CUSTOMER unless the agent says otherwise, and an internal note is
   * never sent to the customer.
   */
  reply: (id: string, body: { body: string; isInternal?: boolean; status?: TicketStatus }) =>
    request<{ ok: true }>(`/admin/tickets/${id}/reply`, { method: 'POST', body }),
};

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  roles: string[];
  mfaEnabledAt: string | null;
  lastLoginAt: string | null;
  disabledAt: string | null;
  createdAt: string;
}

export const iam = {
  admins: () => request<{ items: AdminUserRow[]; roles: string[] }>('/admin/iam/admins'),
  createAdmin: (body: { email: string; name: string; password: string; roles: string[] }) =>
    request<AdminUserRow>('/admin/iam/admins', { method: 'POST', body }),
  setRoles: (id: string, roles: string[]) =>
    request<AdminUserRow>(`/admin/iam/admins/${id}/roles`, { method: 'PATCH', body: { roles } }),
  setDisabled: (id: string, disabled: boolean) =>
    request<AdminUserRow>(`/admin/iam/admins/${id}/disabled`, { method: 'PATCH', body: { disabled } }),
  createSellerUser: (sellerId: string, body: { email: string; name: string; password: string; role: string }) =>
    request<Record<string, unknown>>(`/admin/sellers/${sellerId}/users`, { method: 'POST', body }),
};

/** ADM-005: an action parked until a second operator signs it off. */
export interface ApprovalRow {
  id: string;
  action: string;
  objectType: string;
  objectId: string;
  payload: unknown;
  makerEmail: string | null;
  createdAt: string;
  expiresAt: string | null;
  /** False when the viewer is the maker — they may not be their own checker. */
  canApprove: boolean;
}

export interface AlertRow {
  id: string;
  kind: string;
  severity: string;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt?: string | null;
  resolution?: string | null;
  context?: unknown;
}

export interface PrivacyRequestRow {
  id: string;
  kind: string;
  status: string;
  userId: string;
  requestedAt: string;
  dueAt: string | null;
  resolution: string | null;
  processedAt: string | null;
  [extra: string]: unknown;
}

export interface AuditRow {
  id: string;
  /** A BigInt on the server, so it arrives as a decimal string. */
  sequence: string;
  actorType: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  objectType: string | null;
  objectId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  sessionId: string | null;
  /** ADM-009: the IP is stored hashed, never in the clear. */
  ipHash: string | null;
  userAgent: string | null;
  correlationId: string | null;
  severity: string;
  createdAt: string;
}

export const governance = {
  audit: (params: { action?: string; actorId?: string; objectId?: string; limit?: number; offset?: number } = {}) =>
    request<Paged<AuditRow>>('/admin/audit', { query: params }),

  /** ADM-005: what is waiting for a second approver. */
  approvals: () => request<{ items: ApprovalRow[] }>('/admin/approvals'),

  alerts: (params: { status?: string; severity?: string } = {}) =>
    request<{ items: AlertRow[] }>('/admin/alerts', { query: params }),

  acknowledgeAlert: (id: string) =>
    request<Record<string, unknown>>(`/admin/alerts/${id}/acknowledge`, { method: 'POST' }),

  /** Resolving an alert requires saying what was done about it. */
  resolveAlert: (id: string, resolution: string) =>
    request<Record<string, unknown>>(`/admin/alerts/${id}/resolve`, {
      method: 'POST',
      body: { resolution },
    }),

  featureFlags: () =>
    request<{
      items: Array<{
        id: string;
        key: string;
        description: string | null;
        enabled: boolean;
        rolloutPercent: number;
        allowUserIds: string[];
        updatedAt: string;
      }>;
    }>('/admin/feature-flags'),

  saveFeatureFlag: (body: { key: string; enabled: boolean; rolloutPercent?: number; description?: string }) =>
    request<Record<string, unknown>>('/admin/feature-flags', { method: 'POST', body }),

  settings: () =>
    request<{
      items: Array<{
      key: string;
      value: unknown;
      description: string | null;
      updatedByAdminId: string | null;
      updatedAt: string | null;
    }>;
    }>('/admin/settings'),

  saveSetting: (key: string, value: unknown, description?: string) =>
    request<Record<string, unknown>>('/admin/settings', {
      method: 'POST',
      body: { key, value, description },
    }),

  /** O'RQ-547: the data-subject requests the law gives a deadline for. */
  privacyRequests: () => request<{ items: PrivacyRequestRow[] }>('/admin/privacy-requests'),

  processPrivacyRequest: (
    id: string,
    body: { status: 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED'; resolution?: string },
  ) => request<Record<string, unknown>>(`/admin/privacy-requests/${id}/process`, { method: 'POST', body }),

  aiOverview: () =>
    request<{
      templates: Array<{ key: string; title: string; slots: string[]; styles: string[]; occasions: string[] }>;
      suggestions: string[];
      engine: { version: string; rulesVersion: string };
    }>('/admin/ai/overview'),

  /** ANL-002: every event seen, and whether the taxonomy documents it. */
  analyticsEvents: (params: { name?: string; limit?: number } = {}) =>
    request<{ items: Array<{ name: string; count: number; documented: boolean }> }>(
      '/admin/analytics/events',
      { query: params },
    ),
};

/* ── Seller cabinet (§11) ────────────────────────────────────────────────── */

export interface SellerOverview {
  seller: {
    id: string;
    displayName: string;
    legalName: string;
    onboardingStatus: string;
    settlementMode: string;
    handlingDays: number;
    cutoffLocalTime: string | null;
    payoutScheduleDays: number[];
    /** SEL-001: what is still missing before this seller can trade. */
    checklist: Array<{ key: string; label: string; done: boolean }>;
    checklistComplete: boolean;
  };
  finance: SellerBalance;
  pendingOrders: number;
  pendingReturns: number;
  productCount: number;
  quality: QualityScore;
}

export interface SellerOrderRow {
  id: string;
  number: string;
  orderNumber: string;
  status: string;
  placedAt: string;
  confirmDueAt: string | null;
  /** SEL-003: whether the confirmation SLA has been missed. */
  slaBreached: boolean;
  goodsTotal: Money;
  payableTotal: Money;
  commissionTotal: Money;
  deliveryName: string | null;
  itemCount: number;
  items: Array<{
    id: string;
    title: string;
    sizeLabel: string;
    colorName: string;
    quantity: number;
    unitPrice: Money;
    imageUrl: string | null;
  }>;
  shipment: Record<string, unknown> | null;
}

export const seller = {
  overview: () => request<SellerOverview>('/seller/overview'),

  products: (params: { q?: string; lifecycle?: string; limit?: number; offset?: number } = {}) =>
    request<Paged<ProductRow>>('/seller/products', { query: params }),

  product: (id: string) => request<Record<string, unknown>>(`/seller/products/${id}`),

  publishCheck: (id: string) => request<PublishCheck>(`/seller/products/${id}/publish-check`),

  submitProduct: (id: string) =>
    request<Record<string, unknown>>(`/seller/products/${id}/submit`, { method: 'POST' }),

  setStock: (skuId: string, body: StockInput) =>
    request<Record<string, unknown>>(`/seller/skus/${skuId}/stock`, { method: 'PATCH', body }),

  movements: (skuId: string) =>
    request<{ items: Array<Record<string, unknown>> }>(`/seller/skus/${skuId}/movements`),

  orders: (params: { status?: string; limit?: number } = {}) =>
    request<{ total: number; items: SellerOrderRow[] }>('/seller/orders', { query: params }),

  confirmOrder: (id: string) =>
    request<Record<string, unknown>>(`/seller/orders/${id}/confirm`, {
      method: 'POST',
      idempotencyKey: idempotencyKey(`confirm:${id}`),
    }),

  /**
   * SEL-003: a rejection needs a reason and drives the quality score. Naming
   * `itemIds` rejects only those lines, leaving the rest of the suborder live.
   */
  rejectOrder: (id: string, body: { reason: string; itemIds?: string[] }) =>
    request<Record<string, unknown>>(`/seller/orders/${id}/reject`, { method: 'POST', body }),

  advanceOrder: (id: string, to: SellerAdvanceTarget, note?: string) =>
    request<Record<string, unknown>>(`/seller/orders/${id}/advance`, {
      method: 'POST',
      body: { to, note },
      idempotencyKey: idempotencyKey(`advance:${id}:${to}`),
    }),

  returns: (params: { status?: string; limit?: number } = {}) =>
    request<Paged<ReturnRow>>('/seller/returns', { query: params }),

  returnReceived: (id: string) =>
    request<Record<string, unknown>>(`/seller/returns/${id}/received`, { method: 'POST' }),

  inspectReturn: (id: string, body: InspectionInput) =>
    request<Record<string, unknown>>(`/seller/returns/${id}/inspect`, { method: 'POST', body }),

  balance: () => request<SellerBalance>('/seller/finance/balance'),

  ledger: (params: { event?: string; limit?: number; offset?: number } = {}) =>
    request<Paged<LedgerRow>>('/seller/finance/ledger', { query: params }),

  payouts: (params: { limit?: number } = {}) =>
    request<Paged<Record<string, unknown>>>('/seller/finance/payouts', { query: params }),

  payout: (id: string) => request<Record<string, unknown>>(`/seller/finance/payouts/${id}`),

  financeExport: (params: { from?: string; to?: string } = {}) =>
    request<Response>('/seller/finance/export', { query: params, raw: true }),

  analytics: (params: { from?: string; to?: string } = {}) =>
    request<{
      totals: {
        orderCount: number;
        goods: Money;
        discounts: Money;
        delivery: Money;
        gmv: Money;
        commission: Money;
        refunded: Money;
        averageOrderValue: Money;
        itemCount: number;
        itemsPerOrder: number;
      };
      returns: { total: number; bySizeReason: number; reasons: Record<string, number> };
      quality: QualityScore;
    }>('/seller/analytics', { query: params }),

  users: () =>
    request<{
      items: Array<{
        id: string;
        email: string;
        name: string;
        role: string;
        mfaEnabledAt: string | null;
        lastLoginAt: string | null;
        disabledAt: string | null;
      }>;
      roles: string[];
    }>('/seller/users'),

  createUser: (body: { email: string; name: string; password: string; role: string }) =>
    request<Record<string, unknown>>('/seller/users', { method: 'POST', body }),

  contracts: () => request<{ items: Array<Record<string, unknown>> }>('/seller/contracts'),

  saveDeliveryMethod: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/seller/delivery-methods', { method: 'POST', body }),

  saveReturnPolicy: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/seller/return-policies', { method: 'POST', body }),

  importCsv: (body: { fileName: string; content: string; dryRun: boolean }) =>
    request<ImportReport>('/seller/products/import', { method: 'POST', body }),

  importTemplate: () => request<Response>('/seller/products/import/template', { raw: true }),
  importJobs: () => request<{ items: Array<Record<string, unknown>> }>('/seller/products/import/jobs'),
};
