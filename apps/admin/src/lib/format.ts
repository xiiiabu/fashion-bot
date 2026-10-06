/**
 * Display formatting for the operator panel.
 *
 * Money is always the server's `Money` object. A finance screen that parses an
 * amount into a Number eventually disagrees with the ledger by a tiyin, and
 * the person who finds that out is an accountant (CAT-005).
 */

import type { Locale, Money } from '@fashion/core';
import { formatMoney, toBigInt } from '@fashion/core';

/** Operators work in Russian; the shopper's locale is a per-record field. */
export const OPS_LOCALE: Locale = 'ru';

export function money(value: Money | null | undefined, locale: Locale = OPS_LOCALE): string {
  if (!value) return '—';
  return formatMoney(value, locale);
}

/** Without the currency suffix, for a column that already has one in its header. */
export function amount(value: Money | null | undefined): string {
  if (!value) return '—';
  return formatMoney(value, OPS_LOCALE, { withSymbol: false });
}

/** A signed ledger amount: the sign is the point, so it is never dropped. */
export function signedAmount(minor: string | null | undefined, currency = 'UZS'): string {
  if (minor === null || minor === undefined) return '—';
  const value = BigInt(minor);
  const text = formatMoney({ amount: (value < 0n ? -value : value).toString(), currency: currency as 'UZS' }, OPS_LOCALE, {
    withSymbol: false,
  });
  return value < 0n ? `−${text}` : value > 0n ? `+${text}` : text;
}

export function fromMinor(minor: string | null | undefined, currency = 'UZS'): Money | null {
  if (minor === null || minor === undefined) return null;
  return { amount: minor, currency: currency as 'UZS' };
}

export function majorUnits(value: Money | null | undefined): number | null {
  if (!value) return null;
  return Number(toBigInt(value) / 100n);
}

export function number(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('ru-RU').format(value);
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** A 0..1 ratio rendered as a percentage. */
export function ratio(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

/** "через 2 ч" / "3 ч назад" — what an SLA column actually needs. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '—';
  const deltaMs = target - Date.now();
  const absolute = Math.abs(deltaMs);
  const formatter = new Intl.RelativeTimeFormat('ru-RU', { numeric: 'auto' });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (absolute >= ms) return formatter.format(Math.round(deltaMs / ms), unit);
  }
  return formatter.format(Math.round(deltaMs / 1000), 'second');
}

/** Basis points as a human rate: 1000 -> "10%". */
export function bps(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
}

export function mediaUrl(url: string | null | undefined, apiBase: string): string | null {
  if (!url) return null;
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  return `${apiBase}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** A plain-text name out of whatever shape a relation came back as. */
export function nameOf(value: unknown): string {
  if (!value) return '—';
  if (typeof value === 'string') return value;
  const record = value as Record<string, unknown>;
  const candidate = record.displayName ?? record.name ?? record.title ?? record.slug;
  return typeof candidate === 'string' ? candidate : '—';
}
