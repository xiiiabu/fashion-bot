/**
 * Analytics event taxonomy — spec ANL-001: "the event taxonomy is documented
 * and machine-readable", and ANL-004: no personal data in event properties.
 *
 * This lives in the shared package rather than in the API because the taxonomy
 * is a contract between the surfaces that emit events (Mini App, bot, admin)
 * and the one that stores them. It was previously duplicated in two places
 * inside the API and kept in step by a test; a single exported constant that
 * every client types against removes the drift, and an invented event name now
 * fails to compile instead of being silently rejected at runtime.
 *
 * Adding an event means adding it here. Deliberately not open-ended: a funnel
 * built on ad-hoc names cannot be read six months later.
 */

export const ANALYTICS_EVENTS = [
  /* Session and navigation */
  'app_open',
  'screen_view',

  /* Catalogue */
  'product_view',
  'product_card_click',
  'search_performed',
  'filter_applied',

  /* Size and fit */
  'size_selected',
  'size_chart_opened',
  'fit_recommendation_shown',
  'fit_feedback_submitted',

  /* Cart and wishlist */
  'add_to_cart',
  'add_whole_look',
  'remove_from_cart',
  'wishlist_add',

  /* Checkout and payment */
  'checkout_started',
  'quote_created',
  'payment_initiated',
  'order_paid',

  /* AI stylist */
  'ai_session_started',
  'ai_look_generated',
  'ai_item_replaced',
  'ai_look_added_to_cart',

  /* After the sale */
  'return_requested',

  /* Consent */
  'consent_updated',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/**
 * ANL-001: the taxonomy is versioned as a whole. The previous shape mapped
 * each name to its own version number and every one of them was 1, which
 * suggested a per-event versioning scheme that did not exist. Bump this when
 * the meaning of an existing event changes, so a dashboard can tell which
 * definition a stored row was written under.
 */
export const ANALYTICS_TAXONOMY_VERSION = 1;

const EVENT_SET: ReadonlySet<string> = new Set(ANALYTICS_EVENTS);

export function isAnalyticsEvent(name: string): name is AnalyticsEventName {
  return EVENT_SET.has(name);
}

/**
 * ANL-004: property keys that must never reach analytics. Enforced on the
 * server, and listed here so a client can avoid sending them in the first
 * place rather than having them stripped after the fact.
 */
export const FORBIDDEN_EVENT_PROPERTIES: readonly string[] = [
  'phone',
  'email',
  'address',
  'street',
  'building',
  'apartment',
  'recipientName',
  'recipient_name',
  'fullName',
  'full_name',
  'firstName',
  'first_name',
  'lastName',
  'last_name',
  'username',
  'telegramId',
  'telegram_id',
  'passport',
  'cardNumber',
  'card_number',
  'pan',
  'lat',
  'lng',
  'ip',
  'measurements',
  'heightMm',
  'weightGrams',
  'chest',
  'waist',
  'hips',
];

/**
 * Drops any forbidden key before a client sends an event. Shallow by design:
 * the server does the authoritative scrub, including nested objects. This is
 * the client-side guard that keeps an accident from leaving the device.
 */
export function scrubEventProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!properties) return undefined;
  const forbidden = new Set(FORBIDDEN_EVENT_PROPERTIES.map((key) => key.toLowerCase()));
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (forbidden.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}
