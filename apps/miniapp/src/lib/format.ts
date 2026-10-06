/**
 * Display formatting. Every function takes the server's `Money` object and
 * never a Number: UZS amounts at GMV scale exceed Number.MAX_SAFE_INTEGER in
 * tiyin, and a price silently rounded in the UI is a price the shopper was
 * quoted wrongly (CAT-005).
 */

import type { Locale, Money } from '@fashion/core';
import { formatMoney, toBigInt } from '@fashion/core';

const LOCALE_TAGS: Record<Locale, string> = {
  ru: 'ru-RU',
  uz: 'uz-UZ',
  en: 'en-GB',
};

export function money(value: Money | null | undefined, locale: Locale = 'ru'): string {
  if (!value) return '—';
  return formatMoney(value, locale);
}

/** Shortened for a tight rail card: "1,65 млн" instead of "1 650 000 сум". */
export function moneyCompact(value: Money | null | undefined, locale: Locale = 'ru'): string {
  if (!value) return '—';
  const minor = toBigInt(value);
  const major = minor / 100n;
  if (major < 1_000_000n) return money(value, locale);
  const millions = Number(major) / 1_000_000;
  const unit = locale === 'ru' ? 'млн' : locale === 'uz' ? 'mln' : 'M';
  const rounded = millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10;
  return `${new Intl.NumberFormat(LOCALE_TAGS[locale], { maximumFractionDigits: 1 }).format(rounded)} ${unit}`;
}

/** Soum, for an input the shopper types into. Minor units never reach a field. */
export function majorUnits(value: Money | null | undefined): number | null {
  if (!value) return null;
  return Number(toBigInt(value) / 100n);
}

export function minorFromMajor(major: number): string {
  return String(BigInt(Math.round(major)) * 100n);
}

export function percent(value: number, locale: Locale = 'ru'): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], { style: 'percent', maximumFractionDigits: 0 }).format(
    value,
  );
}

export function number(value: number, locale: Locale = 'ru'): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale]).format(value);
}

export function date(iso: string | null | undefined, locale: Locale = 'ru'): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    day: 'numeric',
    month: 'long',
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(parsed);
}

export function dateTime(iso: string | null | undefined, locale: Locale = 'ru'): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

export function time(iso: string | null | undefined, locale: Locale = 'ru'): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { hour: '2-digit', minute: '2-digit' }).format(parsed);
}

/** "Still 7 min" for a reservation countdown. Returns null once it has lapsed. */
export function minutesLeft(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Math.ceil(ms / 60_000);
}

/** FUL-002: a delivery range, never a single false-precision day. */
export function deliveryRange(minDays: number, maxDays: number, locale: Locale = 'ru'): string {
  const unit = locale === 'ru' ? 'дн.' : locale === 'uz' ? 'kun' : 'days';
  if (minDays === maxDays) return `${minDays} ${unit}`;
  return `${minDays}–${maxDays} ${unit}`;
}

/** Millimetres are the storage unit; centimetres are what a tape measure says. */
export function mmToCm(mm: number | null | undefined): string {
  if (mm === null || mm === undefined) return '';
  const cm = mm / 10;
  return Number.isInteger(cm) ? String(cm) : cm.toFixed(1);
}

export function cmToMm(cm: number): number {
  return Math.round(cm * 10);
}

export function gramsToKg(grams: number | null | undefined): string {
  if (grams === null || grams === undefined) return '';
  const kg = grams / 1000;
  return Number.isInteger(kg) ? String(kg) : kg.toFixed(1);
}

export function kgToGrams(kg: number): number {
  return Math.round(kg * 1000);
}

/** Absolute URL for media the API serves from /media. */
export function mediaUrl(url: string | null | undefined, apiBase: string): string | null {
  if (!url) return null;
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  return `${apiBase}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Russian and Uzbek plural forms, which `Intl.PluralRules` gets right. */
export function plural(
  locale: Locale,
  count: number,
  forms: { one: string; few?: string; many: string },
): string {
  const rules = new Intl.PluralRules(LOCALE_TAGS[locale]);
  const category = rules.select(count);
  if (category === 'one') return forms.one;
  if (category === 'few' && forms.few) return forms.few;
  return forms.many;
}
