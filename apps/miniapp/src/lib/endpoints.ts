/**
 * One function per API operation the Mini App uses, so a screen never builds a
 * URL or remembers a request shape. The return types come from @fashion/core,
 * which is the same module the API serialises from — if the backend contract
 * changes, this file stops compiling rather than failing at runtime.
 */

import type { AnalyticsEventName, ApiError } from '@fashion/core';
import type { FitProfileView, StyleProfileView } from '@fashion/core';
import { scrubEventProperties } from '@fashion/core';
import type {
  AddressView,
  BrandSummary,
  CartView,
  CategorySummary,
  CheckoutQuote,
  ColorFamily,
  FitPreference,
  FitRecommendation,
  HomeBlock,
  Locale,
  MeView,
  Money,
  Occasion,
  OrderView,
  OutfitSlot,
  OutfitView,
  Page,
  ProductCard,
  ProductDetail,
  ReturnRequestView,
  SearchResult,
  Season,
  StyleTag,
} from '@fashion/core';
import { ApiRequestError, idempotencyKey, request, tokens } from './api';

/* ── Auth ────────────────────────────────────────────────────────────────── */

export interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  userId: string;
  isNewUser: boolean;
  locale: Locale;
  startRoute: string | null;
  consentVersions?: Record<string, string>;
}

export interface AuthConfig {
  telegramConfigured: boolean;
  devAuthEnabled: boolean;
  botUsername: string | null;
  locales: Locale[];
  defaultCurrency: string;
  consentVersions: Record<string, string>;
  paymentsLive: boolean;
  paymentProviders: string[];
}

export const auth = {
  config: () => request<AuthConfig>('/auth/config', { anonymous: true }),

  /** TG-001: the signed payload is verified server-side; we only forward it. */
  telegram: (initData: string, platform: string) =>
    request<SessionResponse>('/auth/telegram', {
      method: 'POST',
      body: { initData, platform },
      anonymous: true,
    }),

  /**
   * Browser-only sign-in for development. It posts to this app's own route
   * handler rather than to the API, because that is where the shared secret
   * lives — see src/app/api/dev-session/route.ts. The API refuses dev sign-in
   * in production regardless.
   */
  dev: async (locale?: Locale): Promise<SessionResponse> => {
    const response = await fetch('/api/dev-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale }),
      cache: 'no-store',
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiRequestError(response.status, (payload ?? {}) as Partial<ApiError>);
    }
    return payload as SessionResponse;
  },

  logout: async () => {
    const refreshToken = tokens.refresh();
    if (refreshToken) {
      await request('/auth/logout', { method: 'POST', body: { refreshToken } }).catch(() => {});
    }
    tokens.clear();
  },
};

/* ── Profile ─────────────────────────────────────────────────────────────── */

export interface SessionListItem {
  id: string;
  platform: string | null;
  userAgent: string | null;
  issuedAt: string;
  lastUsedAt: string;
}

/**
 * Only /me and POST /consents return the whole profile. Every other mutation
 * answers with just the part it changed, and they are typed that way here.
 *
 * This is not pedantry. They were all typed as MeView first, and the language
 * switcher fed PATCH /me/locale's `{ locale }` straight into the user state —
 * which erased `consents`, so the app decided the shopper had not accepted the
 * terms and sent them back to the onboarding screen for changing their
 * language. Callers now re-read /me, which is the only response that carries
 * the whole view.
 */
export const me = {
  get: () => request<MeView>('/me'),
  sessions: () => request<{ items: SessionListItem[] }>('/me/sessions'),
  setLocale: (locale: Locale) =>
    request<{ locale: Locale }>('/me/locale', { method: 'PATCH', body: { locale } }),
  setPhone: (phone: string) =>
    request<{ phone: string }>('/me/phone', { method: 'PATCH', body: { phone } }),

  consentVersions: () => request<{ versions: Record<string, string> }>('/consents/versions'),

  /** USR-003: every scope is independently grantable and revocable. */
  setConsents: (
    consents: Array<{
      scope:
        | 'TERMS'
        | 'PRIVACY'
        | 'PERSONALIZATION'
        | 'FIT_PROFILE'
        | 'MARKETING'
        | 'PHOTO_ANALYSIS'
        | 'ANALYTICS';
      granted: boolean;
    }>,
  ) => request<MeView>('/consents', { method: 'POST', body: { consents, source: 'miniapp' } }),

  putStyleProfile: (body: {
    styles?: StyleTag[];
    colors?: ColorFamily[];
    dislikedColors?: ColorFamily[];
    favouriteBrandIds?: string[];
    budgetPerItemMinor?: string | null;
    preferredFit?: FitPreference | null;
    sizes?: Record<string, string>;
    occasions?: Occasion[];
    completed?: boolean;
  }) => request<StyleProfileView>('/me/style-profile', { method: 'PUT', body }),

  deleteStyleProfile: () => request<void>('/me/style-profile', { method: 'DELETE' }),

  putFitProfile: (body: {
    heightMm?: number | null;
    weightGrams?: number | null;
    measurements?: Record<string, number | null>;
    preferredFit?: FitPreference | null;
    usualSizes?: Record<string, string>;
    consentPersonalizedFit?: boolean;
  }) => request<FitProfileView>('/me/fit-profile', { method: 'PUT', body }),

  deleteFitProfile: () => request<void>('/me/fit-profile', { method: 'DELETE' }),

  setPersonalization: (enabled: boolean) =>
    request<{ personalizationEnabled: boolean }>('/me/personalization', {
      method: 'PATCH',
      body: { enabled },
    }),

  /** USR-006: a machine-readable copy of everything we hold. */
  exportData: () => request<Record<string, unknown>>('/me/export'),

  requestDeletion: (reason?: string) =>
    request<{ id: string; status: string }>('/me/delete', { method: 'POST', body: { reason } }),

  privacyRequests: () =>
    request<{ items: Array<{ id: string; kind: string; status: string; createdAt: string }> }>(
      '/privacy-requests',
    ),

  createPrivacyRequest: (
    kind: 'ACCESS' | 'CORRECTION' | 'DELETION' | 'ANONYMIZATION' | 'CONSENT_WITHDRAWAL' | 'PROCESSING_INFO',
    details?: string,
  ) => request<{ id: string; status: string }>('/privacy-requests', { method: 'POST', body: { kind, details } }),
};

/* ── Addresses ───────────────────────────────────────────────────────────── */

export interface AddressInput {
  label?: string;
  recipientName: string;
  phone: string;
  city: string;
  district?: string | null;
  street: string;
  building: string;
  apartment?: string | null;
  entrance?: string | null;
  floor?: string | null;
  landmark?: string | null;
  postalCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  geoConsent?: boolean;
  isDefault?: boolean;
}

export const addresses = {
  list: () => request<{ items: AddressView[] }>('/addresses'),
  create: (body: AddressInput) => request<AddressView>('/addresses', { method: 'POST', body }),
  update: (id: string, body: Partial<AddressInput>) =>
    request<AddressView>(`/addresses/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => request<void>(`/addresses/${id}`, { method: 'DELETE' }),
};

/* ── Catalogue ───────────────────────────────────────────────────────────── */

export interface SearchParams {
  q?: string;
  category?: string[];
  brand?: string[];
  brandSlug?: string[];
  seller?: string[];
  size?: string[];
  color?: ColorFamily[];
  material?: string[];
  style?: StyleTag[];
  season?: Season[];
  fit?: FitPreference[];
  occasion?: Occasion[];
  gender?: 'WOMEN' | 'MEN' | 'UNISEX' | 'KIDS';
  priceMin?: string;
  priceMax?: string;
  discount?: 'true' | 'false';
  inStock?: 'true' | 'false';
  collection?: string;
  sort?: 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'discount' | 'popular';
  limit?: number;
  cursor?: string;
}

export interface LookSummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  total: Money;
  itemCount: number;
  /** ADM-010: a paid placement has to be labelled as one. */
  isSponsored: boolean;
  styleTags: StyleTag[];
  products: ProductCard[];
}

export const catalog = {
  home: () => request<{ blocks: HomeBlock[]; locale: Locale }>('/home'),
  categories: () => request<{ items: CategorySummary[] }>('/categories'),
  brands: (limit = 60) => request<{ items: BrandSummary[] }>('/brands', { query: { limit } }),
  /** The brand's own record. Its products come from /search?brandSlug=. */
  brand: (slug: string) =>
    request<
      BrandSummary & {
        coverUrl: string | null;
        description: string | null;
        country: string | null;
        locale: Locale;
      }
    >(`/brands/${slug}`),
  collections: () =>
    request<{
      items: Array<{
        id: string;
        slug: string;
        title: string;
        subtitle: string | null;
        description: string | null;
        coverUrl: string | null;
        itemCount: number;
        endsAt: string | null;
      }>;
    }>('/collections'),
  looks: (limit = 20) => request<{ items: LookSummary[] }>('/looks', { query: { limit } }),
  look: (idOrSlug: string) => request<LookSummary>(`/looks/${idOrSlug}`),
  search: (params: SearchParams) =>
    request<SearchResult>('/search', { query: params as Record<string, never> }),
  product: (idOrSlug: string) => request<ProductDetail>(`/products/${idOrSlug}`),
  reviews: (productId: string, cursor?: string) =>
    request<
      Page<{
        id: string;
        rating: number;
        title: string | null;
        body: string;
        authorName: string;
        createdAt: string;
        sizePurchased: string | null;
        fitVerdict: string | null;
        verifiedPurchase: boolean;
      }>
    >(`/products/${productId}/reviews`, { query: { cursor } }),
  createReview: (body: { productId: string; rating: number; title?: string; body: string; fitVerdict?: string }) =>
    request<{ id: string }>('/reviews', { method: 'POST', body }),
  deliveryZones: () =>
    request<{
      items: Array<{ id: string; code: string; name: string; city: string; districts: string[] }>;
    }>('/delivery/zones'),
  /** §12.1. `body` is Markdown; the page renderer handles it as such. */
  page: (slug: string) =>
    request<{ slug: string; locale: Locale; title: string; body: string; updatedAt: string }>(
      `/pages/${slug}`,
    ),
};

/* ── Fit ─────────────────────────────────────────────────────────────────── */

export const fit = {
  /** FIT-003: size + confidence + reason, or an explicit "we cannot say". */
  recommendation: (productId: string) =>
    request<{
      recommendation: FitRecommendation | null;
      communitySignal: {
        verdict: string;
        sampleSize: number;
        /** FIT-005: the share of each verdict, so the UI can show the split. */
        shares: { runsSmall: number; runsTrue: number; runsLarge: number };
      } | null;
    }>('/fit/recommendation', { query: { productId } }),

  feedback: (body: { orderItemId: string; verdict: 'runs_small' | 'true_to_size' | 'runs_large' }) =>
    request<{ ok: true }>('/fit/feedback', { method: 'POST', body }),
};

/* ── Wishlist & stock alerts ─────────────────────────────────────────────── */

export const wishlist = {
  list: () => request<{ items: ProductCard[] }>('/wishlist'),
  add: (productId: string, skuId?: string | null) =>
    request<{ ok: true }>('/wishlist', { method: 'POST', body: { productId, skuId } }),
  remove: (productId: string) => request<void>(`/wishlist/${productId}`, { method: 'DELETE' }),
  subscribeStock: (skuId: string) =>
    request<{ ok: true }>('/stock-subscriptions', { method: 'POST', body: { skuId } }),
  unsubscribeStock: (skuId: string) =>
    request<void>(`/stock-subscriptions/${skuId}`, { method: 'DELETE' }),
};

/* ── Cart ────────────────────────────────────────────────────────────────── */

export const cart = {
  get: () => request<CartView>('/cart'),
  count: () => request<{ count: number }>('/cart/count'),
  addItem: (body: {
    skuId: string;
    quantity?: number;
    addedFromAi?: boolean;
    outfitSessionId?: string | null;
    fitConfidence?: number | null;
  }) => request<CartView>('/cart/items', { method: 'POST', body }),
  addLook: (body: {
    items: Array<{ skuId: string; quantity?: number; fitConfidence?: number | null }>;
    outfitSessionId?: string | null;
  }) => request<CartView>('/cart/look', { method: 'POST', body }),
  setQuantity: (itemId: string, quantity: number) =>
    request<CartView>(`/cart/items/${itemId}`, { method: 'PATCH', body: { quantity } }),
  removeItem: (itemId: string) => request<CartView>(`/cart/items/${itemId}`, { method: 'DELETE' }),
  clear: () => request<CartView>('/cart', { method: 'DELETE' }),
  applyPromotion: (code: string | null) =>
    request<CartView>('/cart/promotion', { method: 'POST', body: { code } }),
};

/* ── Checkout ────────────────────────────────────────────────────────────── */

export const checkout = {
  /** ORD-002: the server computes every total; the client only displays them. */
  quote: (body: { addressId?: string | null; deliveryChoices?: Record<string, string> }) =>
    request<CheckoutQuote>('/checkout/quote', { method: 'POST', body }),
  getQuote: (id: string) => request<CheckoutQuote>(`/checkout/quote/${id}`),
  confirm: (body: { quoteId: string; addressId?: string | null; customerNote?: string | null }) =>
    request<OrderView>('/checkout/confirm', {
      method: 'POST',
      body,
      // ORD-006: the same tap twice must return the same order, not a second one.
      idempotencyKey: idempotencyKey(`confirm:${body.quoteId}`),
    }),
};

/* ── Payments ────────────────────────────────────────────────────────────── */

/**
 * A payment provider and the instruments it offers. `live` is false for every
 * provider in this release: §8.4 gates real money behind the PSP decisions and
 * certification, so the sandbox provider runs the full contract while moving
 * nothing.
 */
export interface PaymentProvider {
  code: string;
  name: string;
  enabled: boolean;
  live: boolean;
  methods: string[];
  /** Whether the provider can split a payment across sellers natively. */
  nativeSplit: boolean;
}

export interface PaymentSession {
  id: string;
  status: string;
  provider: string;
  amount: Money;
  /** Where to send the shopper to complete the payment. */
  redirectUrl: string | null;
  expiresAt: string | null;
  live: boolean;
}

export const payments = {
  methods: (orderId?: string) =>
    request<{ providers: PaymentProvider[]; live: boolean; notice: string | null }>(
      '/payments/methods',
      { query: { orderId } },
    ),
  init: (body: { orderId: string; provider?: string; returnUrl?: string }) =>
    request<PaymentSession>('/payments/init', {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey(`pay:${body.orderId}`),
    }),
  get: (id: string) => request<PaymentSession>(`/payments/${id}`),
  sync: (id: string) => request<PaymentSession>(`/payments/${id}/sync`, { method: 'POST' }),
};

/* ── Orders & returns ────────────────────────────────────────────────────── */

export const orders = {
  list: (scope?: 'active' | 'completed' | 'all', cursor?: string) =>
    request<Page<OrderView>>('/orders', { query: { scope, cursor } }),
  get: (id: string) => request<OrderView>(`/orders/${id}`),
  cancel: (id: string, reason?: string) =>
    request<OrderView>(`/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
  pendingFeedback: () =>
    request<{
      items: Array<{
        orderItemId: string;
        productId: string;
        title: string;
        imageUrl: string | null;
        sizeLabel: string;
      }>;
    }>('/orders/feedback/pending'),
  returnEligibility: (id: string) =>
    request<{
      eligible: boolean;
      code: string;
      message: string;
      windowEndsAt: string | null;
      items: Array<{
        orderItemId: string;
        title: string;
        sizeLabel: string;
        quantity: number;
        returnableQuantity: number;
        refundPerUnit: Money;
        imageUrl: string | null;
        blockedReason: string | null;
      }>;
    }>(`/orders/${id}/return-eligibility`),
};

export type ReturnReason =
  | 'SIZE_TOO_SMALL'
  | 'SIZE_TOO_LARGE'
  | 'NOT_AS_DESCRIBED'
  | 'QUALITY_ISSUE'
  | 'WRONG_ITEM'
  | 'DAMAGED'
  | 'CHANGED_MIND'
  | 'LATE_DELIVERY'
  | 'OTHER';

export const returns = {
  list: () => request<{ items: ReturnRequestView[] }>('/returns'),
  get: (id: string) => request<ReturnRequestView>(`/returns/${id}`),
  create: (body: {
    orderId: string;
    items: Array<{ orderItemId: string; quantity: number; reason: ReturnReason }>;
    comment?: string;
  }) =>
    request<ReturnRequestView>('/returns', {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey(`return:${body.orderId}`),
    }),
  handover: (id: string) => request<ReturnRequestView>(`/returns/${id}/handover`, { method: 'POST' }),
  cancel: (id: string) => request<ReturnRequestView>(`/returns/${id}/cancel`, { method: 'POST' }),
};

/* ── AI stylist ──────────────────────────────────────────────────────────── */

export interface StylistOverrides {
  styles?: StyleTag[];
  occasions?: Occasion[];
  season?: Season | null;
  preferredColors?: ColorFamily[];
  avoidColors?: ColorFamily[];
  requiredSlots?: OutfitSlot[];
  excludedSlots?: OutfitSlot[];
  excludedBrandIds?: string[];
  preferredBrandIds?: string[];
  gender?: 'women' | 'men' | 'unisex' | null;
  /** Soum, because that is how the shopper states a budget. */
  budgetMajor?: number | null;
}

export interface StylistFailure {
  ok: false;
  reason: 'EMPTY_SLOTS' | 'BUDGET_TOO_LOW' | 'NO_COMPATIBLE_COMBINATION' | 'DISABLED' | string;
  message: string;
  suggestions: string[];
  /** What the engine did manage to find, so the UI is not simply empty. */
  nearestBudget?: Money | null;
  slots?: Array<{ slot: OutfitSlot; candidateCount: number }>;
}

export interface StylistSuccess {
  ok: true;
  outfit: OutfitView;
}

export interface StylistTemplate {
  key: string;
  title: string;
  slots: OutfitSlot[];
  styles: StyleTag[];
  occasions: Occasion[];
}

export interface AiConfig {
  /** The rules engine always works; only the LLM rewording is optional. */
  available: boolean;
  llmEnabled: boolean;
  llmModel: string | null;
  fitConfidenceThreshold: number;
  suggestions: string[];
  templates: StylistTemplate[];
}

/**
 * AI-003: the engine refuses with an HTTP error carrying a structured reason,
 * not a 200 with `ok: false`. This is that reason, lifted out of the error
 * envelope so a screen can explain the refusal instead of showing a generic
 * failure.
 */
export interface StylistRefusal {
  code: 'BUDGET_TOO_LOW' | 'EMPTY_SLOTS' | 'NO_COMPATIBLE_COMBINATION' | string;
  detail: string;
  emptySlots: OutfitSlot[];
  /** Minor units: the cheapest combination the engine could actually build. */
  minimumBudget: string | null;
  suggestions: string[];
}

export const ai = {
  config: () => request<AiConfig>('/ai/config'),

  parseIntent: (query: string, overrides?: StylistOverrides) =>
    request<{
      styles: StyleTag[];
      occasions: Occasion[];
      season: Season | null;
      colors: ColorFamily[];
      avoidColors: ColorFamily[];
      budget: Money | null;
      recognised: string[];
      unrecognised: string[];
    }>('/ai/style-intent', { method: 'POST', body: { query, overrides } }),

  /** AI-002: a complete look built from real in-stock SKUs. */
  generate: (query: string, overrides?: StylistOverrides, templateKey?: string | null) =>
    request<OutfitView>('/ai/outfits', {
      method: 'POST',
      body: { query, overrides, templateKey },
    }),

  outfit: (id: string) => request<OutfitView>(`/ai/outfits/${id}`),

  /** AI-004: swap one slot, keep the rest of the look. */
  replaceItem: (id: string, slot: OutfitSlot, skuId?: string | null) =>
    request<OutfitView>(`/ai/outfits/${id}/replace-item`, {
      method: 'POST',
      body: { slot, skuId },
    }),

  alternatives: (id: string, slot: OutfitSlot) =>
    request<{
      items: Array<{ skuId: string; sizeLabel: string; product: ProductCard; score: number }>;
    }>(`/ai/outfits/${id}/alternatives`, { query: { slot } }),

  addToCart: (id: string) =>
    request<CartView>(`/ai/outfits/${id}/add-to-cart`, {
      method: 'POST',
      idempotencyKey: idempotencyKey(`outfit:${id}`),
    }),

  /** AI-005: the shopper's saved looks, newest first. */
  history: () =>
    request<{
      items: Array<{
        id: string;
        query: string;
        /** Null when the session never produced a priced look. */
        total: Money | null;
        score: number | null;
        createdAt: string;
        addedToCart: boolean;
        replacements: number;
        itemCount: number;
        thumbnails: string[];
      }>;
    }>('/ai/history'),
};

/**
 * Reads the stylist's structured refusal out of a thrown ApiRequestError.
 * Returns null when the failure was something else entirely (a network drop, a
 * rate limit), which the caller should report as an error rather than as "no
 * look could be built".
 */
export function stylistRefusal(error: unknown): StylistRefusal | null {
  if (!(error instanceof ApiRequestError)) return null;
  const details = error.details as
    | {
        reason?: { code?: string; detail?: string; emptySlots?: OutfitSlot[]; minimumBudget?: string };
        suggestions?: string[];
      }
    | undefined;
  const reason = details?.reason;
  if (!reason?.code) return null;
  return {
    code: reason.code,
    detail: reason.detail ?? '',
    emptySlots: reason.emptySlots ?? [],
    minimumBudget: reason.minimumBudget ?? null,
    suggestions: details?.suggestions ?? [],
  };
}

/* ── Support & notifications ─────────────────────────────────────────────── */

export const support = {
  faq: (locale?: Locale) =>
    request<{
      entries: Array<{ id: string; category: string; question: string; answer: string }>;
      escalation: string | null;
    }>('/support/faq', { query: { locale } }),
  tickets: () =>
    request<{
      items: Array<{
        id: string;
        number: string;
        subject: string;
        status: string;
        updatedAt: string;
        unread: number;
      }>;
    }>('/support/tickets'),
  ticket: (id: string) =>
    request<{
      id: string;
      number: string;
      subject: string;
      status: string;
      messages: Array<{ id: string; body: string; authorRole: string; createdAt: string }>;
    }>(`/support/tickets/${id}`),
  createTicket: (body: { subject: string; body: string; orderId?: string; category?: string }) =>
    request<{ id: string; number: string }>('/support/tickets', { method: 'POST', body }),
  reply: (id: string, body: string) =>
    request<{ ok: true }>(`/support/tickets/${id}/reply`, { method: 'POST', body: { body } }),
};

export const notifications = {
  list: () =>
    request<{
      items: Array<{
        id: string;
        kind: string;
        title: string;
        body: string;
        createdAt: string;
        readAt: string | null;
        deepLink: string | null;
      }>;
      unread: number;
    }>('/notifications'),
  markRead: (ids: string[]) => request<{ ok: true }>('/notifications/read', { method: 'POST', body: { ids } }),
};

/* ── Analytics ───────────────────────────────────────────────────────────── */

/**
 * ANL-001. The name is typed against the shared taxonomy, so an invented event
 * fails to compile rather than being silently rejected by the API — which is
 * what happened first time round: the client sent `home_viewed` and
 * `product_viewed`, the server dropped every one of them, and nothing said so.
 *
 * ANL-004: properties are scrubbed of personal keys before they leave the
 * device. The server scrubs again; this is so an accident never travels.
 *
 * Fire-and-forget by design: a dropped event must never block a tap.
 */
export function track(
  name: AnalyticsEventName,
  properties?: Record<string, unknown>,
): void {
  void request('/events', {
    method: 'POST',
    body: {
      events: [
        {
          name,
          properties: scrubEventProperties(properties),
          source: 'miniapp',
          occurredAt: new Date().toISOString(),
        },
      ],
    },
  }).catch(() => {});
}

/** The one event every screen sends on entry. */
export function trackScreen(screen: string, properties?: Record<string, unknown>): void {
  track('screen_view', { screen, ...properties });
}
