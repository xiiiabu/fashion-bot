/**
 * Mini App deep links — spec TG-002 and TG-004.
 *
 * Kept separate from initData verification because this half is pure string
 * handling that the Mini App and the bot both need in the browser, while
 * verification needs node:crypto and belongs on the server only. Bundling the
 * two together would drag a Node builtin into the browser bundle, so the split
 * is a hard boundary rather than a tidiness preference.
 */

/**
 * TG-004: deep links. `startapp` carries a compact payload that survives
 * Telegram's base64url-ish restrictions (A-Z a-z 0-9 _ -).
 */
export type DeepLinkTarget =
  | { kind: 'product'; id: string }
  | { kind: 'collection'; slug: string }
  | { kind: 'look'; id: string }
  | { kind: 'order'; id: string }
  | { kind: 'campaign'; slug: string }
  | { kind: 'category'; slug: string }
  | { kind: 'brand'; slug: string }
  | { kind: 'stylist'; prompt?: string }
  | { kind: 'home' };

const PREFIXES: Record<string, DeepLinkTarget['kind']> = {
  p: 'product',
  c: 'collection',
  l: 'look',
  o: 'order',
  m: 'campaign',
  g: 'category',
  b: 'brand',
  s: 'stylist',
};

const KINDS: Record<DeepLinkTarget['kind'], string> = {
  product: 'p',
  collection: 'c',
  look: 'l',
  order: 'o',
  campaign: 'm',
  category: 'g',
  brand: 'b',
  stylist: 's',
  home: 'h',
};

export function encodeDeepLink(target: DeepLinkTarget): string {
  switch (target.kind) {
    case 'home':
      return 'h';
    case 'product':
      return `${KINDS.product}_${compact(target.id)}`;
    case 'collection':
      return `${KINDS.collection}_${compact(target.slug)}`;
    case 'look':
      return `${KINDS.look}_${compact(target.id)}`;
    case 'order':
      return `${KINDS.order}_${compact(target.id)}`;
    case 'campaign':
      return `${KINDS.campaign}_${compact(target.slug)}`;
    case 'category':
      return `${KINDS.category}_${compact(target.slug)}`;
    case 'brand':
      return `${KINDS.brand}_${compact(target.slug)}`;
    case 'stylist':
      return target.prompt
        ? `${KINDS.stylist}_${Buffer.from(target.prompt, 'utf8').toString('base64url')}`
        : KINDS.stylist;
  }
}

export function decodeDeepLink(param: string | null | undefined): DeepLinkTarget {
  if (!param || param === 'h') return { kind: 'home' };
  const separator = param.indexOf('_');
  const prefix = separator === -1 ? param : param.slice(0, separator);
  const rest = separator === -1 ? '' : param.slice(separator + 1);
  const kind = PREFIXES[prefix];
  if (!kind) return { kind: 'home' };
  switch (kind) {
    case 'product':
      return { kind: 'product', id: rest };
    case 'collection':
      return { kind: 'collection', slug: rest };
    case 'look':
      return { kind: 'look', id: rest };
    case 'order':
      return { kind: 'order', id: rest };
    case 'campaign':
      return { kind: 'campaign', slug: rest };
    case 'category':
      return { kind: 'category', slug: rest };
    case 'brand':
      return { kind: 'brand', slug: rest };
    case 'stylist':
      if (!rest) return { kind: 'stylist' };
      try {
        return { kind: 'stylist', prompt: Buffer.from(rest, 'base64url').toString('utf8') };
      } catch {
        return { kind: 'stylist' };
      }
    default:
      return { kind: 'home' };
  }
}

/** The in-app route a deep link should land on after authentication. */
export function deepLinkToRoute(target: DeepLinkTarget): string {
  switch (target.kind) {
    case 'product':
      return `/product/${encodeURIComponent(target.id)}`;
    case 'collection':
      return `/collection/${encodeURIComponent(target.slug)}`;
    case 'look':
      return `/stylist/look/${encodeURIComponent(target.id)}`;
    case 'order':
      return `/orders/${encodeURIComponent(target.id)}`;
    case 'campaign':
      return `/campaign/${encodeURIComponent(target.slug)}`;
    case 'category':
      return `/catalog?category=${encodeURIComponent(target.slug)}`;
    case 'brand':
      return `/catalog?brand=${encodeURIComponent(target.slug)}`;
    case 'stylist':
      return target.prompt ? `/stylist?q=${encodeURIComponent(target.prompt)}` : '/stylist';
    case 'home':
    default:
      return '/';
  }
}

function compact(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '');
}

export function buildMiniAppLink(botUsername: string, target: DeepLinkTarget): string {
  const payload = encodeDeepLink(target);
  return `https://t.me/${botUsername}/app?startapp=${payload}`;
}

export function buildBotLink(botUsername: string, target: DeepLinkTarget): string {
  return `https://t.me/${botUsername}?start=${encodeDeepLink(target)}`;
}
