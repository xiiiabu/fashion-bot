/**
 * Bridge between the database (BigInt minor units + a currency string) and the
 * transport `Money` object (CAT-005, §14.3).
 */

import { type CurrencyCode, type Money, money as makeMoney, toBigInt } from '@fashion/core';
import { loadConfig } from './config';

export function defaultCurrency(): CurrencyCode {
  return loadConfig().DEFAULT_CURRENCY as CurrencyCode;
}

/** DB row -> transport Money. */
export function toMoney(minor: bigint | number | null | undefined, currency?: string | null): Money {
  return makeMoney(minor ?? 0n, (currency as CurrencyCode) ?? defaultCurrency());
}

/** Transport Money (or raw minor units) -> DB BigInt. */
export function toMinor(value: Money | bigint | number | string | null | undefined): bigint {
  if (value == null) return 0n;
  return toBigInt(value as Money | bigint | number | string);
}

export function nullableMoney(
  minor: bigint | number | null | undefined,
  currency?: string | null,
): Money | null {
  if (minor == null) return null;
  return toMoney(minor, currency);
}

/** Discount percentage for a badge; derived, never used in arithmetic. */
export function discountPercent(
  priceMinor: bigint | number,
  compareAtMinor: bigint | number | null | undefined,
): number | null {
  if (compareAtMinor == null) return null;
  const price = BigInt(priceMinor);
  const compareAt = BigInt(compareAtMinor);
  if (compareAt <= price || compareAt === 0n) return null;
  return Number(((compareAt - price) * 100n) / compareAt);
}
