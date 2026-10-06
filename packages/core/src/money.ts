/**
 * Money primitives.
 *
 * Spec CAT-005 / §14.3: money is stored as an integer amount in minor units
 * plus an ISO-4217 currency code. Never a float, never a locale string.
 * All arithmetic in this file is BigInt so totals cannot silently lose
 * precision or overflow once GMV grows past 2^31 tiyin.
 */

export type CurrencyCode = 'UZS' | 'USD' | 'EUR' | 'RUB';

export interface Money {
  /** Integer amount in minor units, serialised as a decimal string. */
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export interface CurrencyMeta {
  readonly code: CurrencyCode;
  /** Number of decimal digits in the minor unit (ISO 4217 "E"). */
  readonly exponent: number;
  readonly symbol: string;
  /** UZS prices are quoted in whole soums; tiyin are not in circulation. */
  readonly displayDecimals: number;
}

export const CURRENCIES: Record<CurrencyCode, CurrencyMeta> = {
  UZS: { code: 'UZS', exponent: 2, symbol: "so'm", displayDecimals: 0 },
  USD: { code: 'USD', exponent: 2, symbol: '$', displayDecimals: 2 },
  EUR: { code: 'EUR', exponent: 2, symbol: '€', displayDecimals: 2 },
  RUB: { code: 'RUB', exponent: 2, symbol: '₽', displayDecimals: 2 },
};

export const DEFAULT_CURRENCY: CurrencyCode = 'UZS';

/**
 * The soum is written differently in each of our languages, so the symbol
 * follows the reader rather than the currency: a Russian price saying "so'm"
 * is as wrong as an Uzbek one saying "сум". `CURRENCIES[].symbol` stays as the
 * neutral default for anything that has no locale to hand.
 *
 * Only UZS varies; $, € and ₽ are the same glyph everywhere.
 */
const LOCALIZED_SYMBOLS: Record<string, Partial<Record<CurrencyCode, string>>> = {
  ru: { UZS: 'сум' },
  uz: { UZS: "so'm" },
  en: { UZS: 'UZS' },
};

/** The currency symbol as the given locale writes it. */
export function currencySymbol(currency: CurrencyCode, locale?: string): string {
  const language = (locale ?? '').slice(0, 2).toLowerCase();
  return LOCALIZED_SYMBOLS[language]?.[currency] ?? CURRENCIES[currency].symbol;
}

export class MoneyError extends Error {}

export function money(amount: bigint | number | string, currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  return { amount: toBigInt(amount).toString(), currency };
}

export function zero(currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  return { amount: '0', currency };
}

/** Build Money from a major-unit value (e.g. 1_000_000 soum -> 100_000_000 tiyin). */
export function fromMajor(major: number | string, currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  const meta = CURRENCIES[currency];
  const text = String(major).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new MoneyError(`Not a numeric major amount: ${major}`);
  const negative = text.startsWith('-');
  const [intPart, fracPart = ''] = text.replace('-', '').split('.');
  const frac = (fracPart + '0'.repeat(meta.exponent)).slice(0, meta.exponent);
  const minor = BigInt(intPart + frac);
  return { amount: (negative ? -minor : minor).toString(), currency };
}

export function toBigInt(value: bigint | number | string | Money): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new MoneyError(`Minor units must be integers, got ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value.trim())) throw new MoneyError(`Not an integer minor amount: ${value}`);
    return BigInt(value.trim());
  }
  return BigInt(value.amount);
}

/** Convert to a JS number of minor units. Safe for display-sized values only. */
export function toNumber(value: Money | bigint | string): number {
  const big = toBigInt(value);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError('Amount exceeds Number.MAX_SAFE_INTEGER; keep it as BigInt');
  }
  return Number(big);
}

function assertSame(a: Money, b: Money): CurrencyCode {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return a.currency;
}

export function add(a: Money, b: Money): Money {
  const currency = assertSame(a, b);
  return { amount: (toBigInt(a) + toBigInt(b)).toString(), currency };
}

export function subtract(a: Money, b: Money): Money {
  const currency = assertSame(a, b);
  return { amount: (toBigInt(a) - toBigInt(b)).toString(), currency };
}

export function sum(items: Money[], currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  if (items.length === 0) return zero(currency);
  return items.reduce((acc, item) => add(acc, item), zero(items[0]!.currency));
}

export function multiply(value: Money, factor: number | bigint): Money {
  if (typeof factor === 'number' && !Number.isInteger(factor)) {
    throw new MoneyError('Use percentOf/applyBps for fractional factors so rounding stays explicit');
  }
  return { amount: (toBigInt(value) * BigInt(factor)).toString(), currency: value.currency };
}

export function negate(value: Money): Money {
  return { amount: (-toBigInt(value)).toString(), currency: value.currency };
}

export function abs(value: Money): Money {
  const big = toBigInt(value);
  return { amount: (big < 0n ? -big : big).toString(), currency: value.currency };
}

export function isZero(value: Money): boolean {
  return toBigInt(value) === 0n;
}

export function isNegative(value: Money): boolean {
  return toBigInt(value) < 0n;
}

export function isPositive(value: Money): boolean {
  return toBigInt(value) > 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b);
  const left = toBigInt(a);
  const right = toBigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function lte(a: Money, b: Money): boolean {
  return compare(a, b) <= 0;
}

export function gte(a: Money, b: Money): boolean {
  return compare(a, b) >= 0;
}

/**
 * Rounding mode used by every commission and tax calculation.
 * HALF_UP on the absolute value keeps -x symmetric with +x, which is what the
 * seller contract means by "round(gross x 10%)" (spec 8.2) and keeps a refund
 * reversal exactly equal to the commission it reverses.
 */
export type RoundingMode = 'HALF_UP' | 'FLOOR' | 'CEIL';

export const DEFAULT_ROUNDING: RoundingMode = 'HALF_UP';

function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new MoneyError('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  let result: bigint;
  switch (mode) {
    case 'FLOOR':
      result = quotient;
      break;
    case 'CEIL':
      result = remainder === 0n ? quotient : quotient + 1n;
      break;
    case 'HALF_UP':
    default:
      result = remainder * 2n >= absDen ? quotient + 1n : quotient;
      break;
  }
  return negative ? -result : result;
}

/** Apply a rate expressed in basis points (1000 bps = 10%). */
export function applyBps(value: Money, bps: number, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  if (!Number.isInteger(bps)) throw new MoneyError(`Basis points must be an integer, got ${bps}`);
  const result = divideRounded(toBigInt(value) * BigInt(bps), 10_000n, mode);
  return { amount: result.toString(), currency: value.currency };
}

/** Pro-rate `value` by `numerator/denominator` (used for partial refunds). */
export function prorate(
  value: Money,
  numerator: bigint | number,
  denominator: bigint | number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  const result = divideRounded(toBigInt(value) * BigInt(numerator), BigInt(denominator), mode);
  return { amount: result.toString(), currency: value.currency };
}

/**
 * Split `value` into `parts` shares that sum exactly back to `value`.
 * Remainder tiyin go to the earliest parts (largest-remainder free, but
 * deterministic, which is what reconciliation needs).
 */
export function splitEvenly(value: Money, parts: number): Money[] {
  if (parts <= 0) throw new MoneyError('parts must be > 0');
  const total = toBigInt(value);
  const base = total / BigInt(parts);
  let remainder = total - base * BigInt(parts);
  const step = remainder < 0n ? -1n : 1n;
  const out: Money[] = [];
  for (let i = 0; i < parts; i += 1) {
    let share = base;
    if (remainder !== 0n) {
      share += step;
      remainder -= step;
    }
    out.push({ amount: share.toString(), currency: value.currency });
  }
  return out;
}

/**
 * Split `value` across weights so the shares sum exactly to `value`.
 * Used to allocate an order-level discount or PSP fee down to OrderItems.
 */
export function splitByWeights(value: Money, weights: Array<bigint | number>): Money[] {
  const total = toBigInt(value);
  const bigWeights = weights.map((w) => BigInt(w));
  const weightSum = bigWeights.reduce((acc, w) => acc + w, 0n);
  if (weightSum === 0n) return splitEvenly(value, Math.max(weights.length, 1));
  const shares: bigint[] = [];
  let allocated = 0n;
  for (const weight of bigWeights) {
    const share = divideRounded(total * weight, weightSum, 'FLOOR');
    shares.push(share);
    allocated += share;
  }
  let drift = total - allocated;
  const step = drift < 0n ? -1n : 1n;
  for (let i = 0; i < shares.length && drift !== 0n; i += 1) {
    shares[i] = shares[i]! + step;
    drift -= step;
  }
  return shares.map((amount) => ({ amount: amount.toString(), currency: value.currency }));
}

/** Format for UI. Uzbek/Russian locales group with a narrow no-break space. */
/**
 * Formats an amount for display. `locale` selects how the currency is written
 * (see currencySymbol); the digit grouping is a plain space in every locale we
 * ship, which is correct for ru, uz and en-GB alike.
 */
export function formatMoney(
  value: Money,
  locale: string = 'ru',
  options: { withSymbol?: boolean; compact?: boolean } = {},
): string {
  const { withSymbol = true, compact = false } = options;
  const meta = CURRENCIES[value.currency];
  const big = toBigInt(value);
  const negative = big < 0n;
  const absolute = negative ? -big : big;
  const divisor = 10n ** BigInt(meta.exponent);
  const majorUnits = absolute / divisor;
  const minorRemainder = absolute % divisor;

  let numeric: string;
  if (compact && majorUnits >= 1_000_000n) {
    numeric = `${(Number(majorUnits) / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  } else if (compact && majorUnits >= 1_000n) {
    numeric = `${(Number(majorUnits) / 1_000).toFixed(0)}K`;
  } else {
    const grouped = groupDigits(majorUnits.toString());
    if (meta.displayDecimals > 0) {
      const frac = minorRemainder.toString().padStart(meta.exponent, '0').slice(0, meta.displayDecimals);
      numeric = `${grouped}${frac ? `,${frac}` : ''}`;
    } else {
      numeric = grouped;
    }
  }
  const signed = negative ? `−${numeric}` : numeric;
  if (!withSymbol) return signed;
  const symbol = currencySymbol(value.currency, locale);
  // The soum follows the number; the Western symbols precede it.
  return value.currency === 'UZS' ? `${signed} ${symbol}` : `${symbol}${signed}`;
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Parse what a human typed in an admin price field (major units). */
export function parseMajorInput(input: string, currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  const cleaned = input.replace(/[\s  ']/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-') return zero(currency);
  return fromMajor(cleaned, currency);
}

/** Major-unit number, for charts and analytics only — never for arithmetic. */
export function toMajorNumber(value: Money): number {
  const meta = CURRENCIES[value.currency];
  return Number(toBigInt(value)) / 10 ** meta.exponent;
}
