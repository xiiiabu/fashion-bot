/**
 * Transport contracts shared by the API, the Mini App, the admin panel and the
 * bot — spec §14.3 (stable error codes, cursor pagination, correlation IDs).
 */

import type { Money } from './money.js';
import type { Locale } from './i18n.js';
import type { OrderStatus, PaymentStatus, ReturnStatus, SubOrderStatus } from './state-machine.js';
import type {
  ColorFamily,
  FitPreference,
  FormalityLevel,
  Occasion,
  OutfitSlot,
  Season,
  Silhouette,
  StyleTag,
  WarmthLevel,
} from './taxonomy.js';
import type { FitRecommendation, SizeChart } from './fit.js';

/** §14.3: every error carries a stable code, a localised message and a correlation id. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'OUT_OF_STOCK',
  'RESERVATION_EXPIRED',
  'QUOTE_EXPIRED',
  'ILLEGAL_STATE_TRANSITION',
  'PAYMENT_UNAVAILABLE',
  'AMOUNT_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'CONSENT_REQUIRED',
  'FEATURE_DISABLED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  readonly code: ErrorCode | string;
  readonly message: string;
  readonly correlationId: string;
  readonly details?: Record<string, unknown>;
  /** Present on 409s caused by a state machine rejection. */
  readonly allowedTransitions?: string[];
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly total?: number;
}

export interface MediaRef {
  readonly id: string;
  readonly url: string;
  readonly kind: 'IMAGE' | 'VIDEO';
  readonly role: 'MAIN' | 'FRONT' | 'BACK' | 'DETAIL' | 'MODEL' | 'FLATLAY' | 'VIDEO';
  readonly alt: string;
  readonly width: number | null;
  readonly height: number | null;
  /** Average colour, so the UI can show a tinted placeholder before load. */
  readonly placeholder?: string | null;
}

export interface BrandSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly verified: boolean;
  readonly productCount?: number;
}

export interface SellerSummary {
  readonly id: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly verified: boolean;
  readonly qualityScore: number | null;
  readonly handlingDays: number;
}

export interface CategorySummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly parentSlug: string | null;
  readonly slot: OutfitSlot | null;
  readonly imageUrl: string | null;
  readonly productCount?: number;
}

/** BUY-004: the product card. Price and availability are always current. */
export interface ProductCard {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly brand: BrandSummary;
  readonly price: Money;
  readonly compareAtPrice: Money | null;
  readonly discountPercent: number | null;
  readonly media: MediaRef[];
  readonly colorFamily: ColorFamily;
  readonly colorName: string;
  readonly availableSizes: string[];
  readonly inStock: boolean;
  readonly isWishlisted: boolean;
  readonly styleTags: StyleTag[];
  readonly categorySlug: string;
  readonly badges: Array<'NEW' | 'SALE' | 'LAST_ITEMS' | 'VERIFIED_BRAND' | 'AI_PICK'>;
  readonly rating: { average: number; count: number } | null;
}

export interface SkuDetail {
  readonly id: string;
  readonly sizeLabel: string;
  readonly colorName: string;
  readonly colorFamily: ColorFamily;
  readonly price: Money;
  readonly compareAtPrice: Money | null;
  readonly available: number;
  readonly barcode: string | null;
  readonly sellerSku: string | null;
  /** §5.1: flat measurements of this exact size, in millimetres. */
  readonly measurements: Record<string, number> | null;
  readonly lowStock: boolean;
}

/** BUY-005: everything the PDP must show before a purchase is possible. */
export interface ProductDetail extends Omit<ProductCard, 'availableSizes'> {
  readonly description: string;
  readonly seller: SellerSummary;
  readonly composition: string;
  readonly care: string;
  readonly countryOfOrigin: string | null;
  readonly skus: SkuDetail[];
  readonly sizeChart: SizeChart | null;
  readonly fitNotes: string | null;
  readonly silhouette: Silhouette | null;
  readonly formality: FormalityLevel;
  readonly warmth: WarmthLevel;
  readonly season: Season;
  readonly occasions: Occasion[];
  readonly materials: string[];
  readonly delivery: DeliveryEstimate[];
  readonly returnPolicy: ReturnPolicySnapshot;
  readonly authenticity: string | null;
  readonly fit: FitRecommendation | null;
  readonly relatedProductIds: string[];
  readonly completeTheLook: ProductCard[];
}

export interface DeliveryEstimate {
  readonly methodCode: string;
  readonly name: string;
  readonly price: Money;
  /** FUL-002: a range, never false precision. */
  readonly minDays: number;
  readonly maxDays: number;
  readonly cutoffLocalTime: string | null;
  readonly zoneName: string | null;
}

export interface ReturnPolicySnapshot {
  readonly windowDays: number;
  readonly conditions: string;
  readonly whoPaysReturn: 'BUYER' | 'SELLER' | 'PLATFORM';
  readonly nonReturnableReasons: string[];
}

export interface CartItemView {
  readonly id: string;
  readonly skuId: string;
  readonly productId: string;
  readonly title: string;
  readonly brandName: string;
  readonly sellerId: string;
  readonly sellerName: string;
  readonly sizeLabel: string;
  readonly colorName: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
  readonly compareAtUnitPrice: Money | null;
  readonly imageUrl: string | null;
  readonly available: number;
  readonly issue: 'NONE' | 'OUT_OF_STOCK' | 'PRICE_CHANGED' | 'UNPUBLISHED' | 'QUANTITY_REDUCED';
  readonly addedFromAi: boolean;
  readonly fitConfidence: number | null;
}

/** ORD-001: the cart is grouped by seller so delivery terms stay legible. */
export interface CartSellerGroup {
  readonly sellerId: string;
  readonly sellerName: string;
  readonly items: CartItemView[];
  readonly subtotal: Money;
  readonly deliveryOptions: DeliveryEstimate[];
  readonly handlingDays: number;
}

export interface CartView {
  readonly id: string;
  readonly groups: CartSellerGroup[];
  readonly itemCount: number;
  readonly subtotal: Money;
  readonly estimatedDelivery: Money;
  readonly estimatedTotal: Money;
  readonly currency: string;
  readonly hasIssues: boolean;
  readonly updatedAt: string;
}

/** ORD-002: the quote is produced by the backend; the client never sums. */
export interface CheckoutQuote {
  readonly id: string;
  readonly cartId: string;
  readonly lines: Array<{
    readonly cartItemId: string;
    readonly skuId: string;
    readonly title: string;
    readonly sellerId: string;
    readonly quantity: number;
    readonly unitPrice: Money;
    readonly lineTotal: Money;
    readonly sellerFundedDiscount: Money;
    readonly platformFundedDiscount: Money;
  }>;
  readonly groups: Array<{
    readonly sellerId: string;
    readonly sellerName: string;
    readonly goodsTotal: Money;
    readonly deliveryMethodCode: string;
    readonly deliveryName: string;
    readonly deliveryPrice: Money;
    readonly minDays: number;
    readonly maxDays: number;
  }>;
  readonly goodsTotal: Money;
  readonly discountTotal: Money;
  readonly deliveryTotal: Money;
  readonly grandTotal: Money;
  readonly currency: string;
  /** CAT-008: when the stock hold behind this quote lapses. */
  readonly reservationExpiresAt: string;
  readonly expiresAt: string;
  readonly addressId: string | null;
  readonly warnings: Array<{ code: string; message: string; skuId?: string }>;
  readonly fiscal: { receiptRequired: boolean; sellerOfRecord: string } | null;
}

export interface OrderItemView {
  readonly id: string;
  readonly skuId: string;
  readonly productId: string;
  readonly title: string;
  readonly brandName: string;
  readonly sizeLabel: string;
  readonly colorName: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
  readonly imageUrl: string | null;
  readonly refundedQuantity: number;
  readonly returnable: boolean;
  readonly returnableUntil: string | null;
}

export interface SubOrderView {
  readonly id: string;
  readonly number: string;
  readonly sellerId: string;
  readonly sellerName: string;
  readonly status: SubOrderStatus;
  readonly items: OrderItemView[];
  readonly goodsTotal: Money;
  readonly deliveryPrice: Money;
  readonly deliveryName: string;
  readonly estimatedDelivery: { minDays: number; maxDays: number; from: string; to: string } | null;
  readonly shipment: {
    readonly id: string;
    readonly status: string;
    readonly carrier: string | null;
    readonly trackingNumber: string | null;
    readonly trackingUrl: string | null;
  } | null;
}

export interface OrderView {
  readonly id: string;
  readonly number: string;
  readonly status: OrderStatus;
  readonly phase: string;
  readonly paymentStatus: PaymentStatus;
  readonly placedAt: string;
  readonly subOrders: SubOrderView[];
  readonly goodsTotal: Money;
  readonly discountTotal: Money;
  readonly deliveryTotal: Money;
  readonly grandTotal: Money;
  readonly refundedTotal: Money;
  readonly currency: string;
  readonly address: AddressView | null;
  readonly returnPolicy: ReturnPolicySnapshot;
  readonly canCancel: boolean;
  readonly canReturn: boolean;
  readonly timeline: Array<{ status: string; at: string; note: string | null }>;
  readonly fiscalReceiptUrl: string | null;
}

export interface AddressView {
  readonly id: string;
  readonly label: string;
  readonly recipientName: string;
  readonly phone: string;
  readonly city: string;
  readonly district: string | null;
  readonly street: string;
  readonly building: string;
  readonly apartment: string | null;
  readonly landmark: string | null;
  readonly postalCode: string | null;
  readonly isDefault: boolean;
  readonly lat: number | null;
  readonly lng: number | null;
}

export interface ReturnRequestView {
  readonly id: string;
  readonly number: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: ReturnStatus;
  readonly createdAt: string;
  readonly items: Array<{
    readonly orderItemId: string;
    readonly title: string;
    readonly sizeLabel: string;
    readonly quantity: number;
    readonly reason: string;
    readonly refundAmount: Money;
    readonly imageUrl: string | null;
  }>;
  readonly refundTotal: Money;
  readonly timeline: Array<{ status: string; at: string; note: string | null }>;
  readonly dropOffInstructions: string | null;
}

export interface MeView {
  readonly id: string;
  readonly telegramId: string | null;
  readonly firstName: string | null;
  readonly username: string | null;
  readonly photoUrl: string | null;
  readonly locale: Locale;
  readonly phone: string | null;
  readonly consents: Record<string, { granted: boolean; version: string; at: string }>;
  readonly styleProfile: StyleProfileView | null;
  readonly fitProfile: FitProfileView | null;
  readonly personalizationEnabled: boolean;
  readonly isNewUser: boolean;
  readonly stats: { orders: number; wishlist: number; cartItems: number };
}

export interface StyleProfileView {
  readonly styles: StyleTag[];
  readonly colors: ColorFamily[];
  readonly dislikedColors: ColorFamily[];
  readonly favouriteBrandIds: string[];
  readonly budgetPerItem: Money | null;
  readonly preferredFit: FitPreference | null;
  readonly sizes: Record<string, string>;
  readonly completedAt: string | null;
}

export interface FitProfileView {
  readonly heightMm: number | null;
  readonly weightGrams: number | null;
  readonly measurements: Record<string, number>;
  readonly preferredFit: FitPreference | null;
  readonly usualSizes: Record<string, string>;
  readonly consentPersonalizedFit: boolean;
  readonly updatedAt: string | null;
}

export interface OutfitItemView {
  readonly slot: OutfitSlot;
  readonly product: ProductCard;
  readonly skuId: string;
  readonly sizeLabel: string;
  readonly price: Money;
  readonly fit: FitRecommendation | null;
  readonly reasons: string[];
  readonly alternativesCount: number;
  readonly locked: boolean;
}

export interface OutfitView {
  readonly id: string;
  readonly title: string;
  readonly items: OutfitItemView[];
  readonly total: Money;
  readonly budget: Money | null;
  readonly withinBudget: boolean;
  readonly score: number;
  readonly explanation: string[];
  readonly narrative: string | null;
  readonly intent: {
    readonly styles: StyleTag[];
    readonly occasions: Occasion[];
    readonly season: Season | null;
    readonly colors: ColorFamily[];
    readonly budget: Money | null;
    readonly rawQuery: string;
  };
  readonly unfilledSlots: Array<{ slot: OutfitSlot; required: boolean; reason: string }>;
  readonly sellerCount: number;
  readonly generatedAt: string;
  /** AI-009: the exact engine version that produced this, for audit. */
  readonly engine: { version: string; model: string | null; rulesVersion: string };
}

export interface HomeBlock {
  readonly id: string;
  readonly kind:
    | 'HERO'
    | 'BANNER'
    | 'PRODUCT_RAIL'
    | 'BRAND_RAIL'
    | 'CATEGORY_GRID'
    | 'LOOK_RAIL'
    | 'EDITORIAL'
    | 'AI_PROMPT'
    | 'SALE_RAIL';
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly ctaLabel: string | null;
  readonly ctaHref: string | null;
  readonly imageUrl: string | null;
  readonly products?: ProductCard[];
  readonly brands?: BrandSummary[];
  readonly categories?: CategorySummary[];
  readonly looks?: Array<{
    readonly id: string;
    readonly title: string;
    readonly imageUrl: string | null;
    readonly total: Money;
    readonly itemCount: number;
    readonly products: ProductCard[];
  }>;
  readonly prompts?: string[];
}

export interface SearchFacets {
  readonly brands: Array<{ id: string; name: string; count: number }>;
  readonly categories: Array<{ slug: string; name: string; count: number }>;
  readonly sizes: Array<{ label: string; count: number }>;
  readonly colors: Array<{ family: ColorFamily; count: number }>;
  readonly materials: Array<{ value: string; count: number }>;
  readonly styles: Array<{ value: StyleTag; count: number }>;
  readonly seasons: Array<{ value: Season; count: number }>;
  readonly fits: Array<{ value: FitPreference; count: number }>;
  readonly priceRange: { min: Money; max: Money };
}

export interface SearchResult {
  readonly items: ProductCard[];
  readonly facets: SearchFacets;
  readonly total: number;
  readonly nextCursor: string | null;
  readonly query: string | null;
  readonly didYouMean: string | null;
  readonly appliedFilters: Record<string, string[]>;
}
