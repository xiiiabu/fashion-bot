/**
 * Ledger events in the words the person reading them uses.
 *
 * A seller looking at their balance should not have to decode
 * SELLER_PAYABLE_REVERSAL. The map is keyed on core's `LedgerEvent`, so adding
 * an event to the machine without a label here fails to compile rather than
 * leaking an enum name into a shopkeeper's statement — which is what happened
 * when four of these were written from memory and none of the four existed.
 *
 * The platform side keeps the raw event names on its own ledger screen on
 * purpose: an operator reconciling against the database wants the identifier,
 * not a translation of it.
 */

import { type LedgerEvent } from '@fashion/core';

export const SELLER_EVENT_LABELS: Record<LedgerEvent, string> = {
  SALE_GROSS: 'Продажа',
  PLATFORM_COMMISSION: 'Комиссия платформы',
  SELLER_PAYABLE: 'Начислено к выплате',
  DISCOUNT_SELLER: 'Скидка за ваш счёт',
  DISCOUNT_PLATFORM: 'Скидка за счёт платформы',
  PSP_FEE: 'Эквайринг (за счёт платформы)',
  REFUND_GROSS: 'Возврат покупателю',
  COMMISSION_REVERSAL: 'Возврат комиссии',
  SELLER_PAYABLE_REVERSAL: 'Снято при возврате',
  PAYOUT: 'Выплата',
  ADJUSTMENT: 'Корректировка',
};

export function sellerEventLabel(event: string): string {
  return SELLER_EVENT_LABELS[event as LedgerEvent] ?? event;
}

/**
 * The colour says what the entry does to the seller's balance: money in, money
 * out, a reversal of either. It is not a judgement — a refund is normal
 * business, not a failure.
 */
export type EventTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info';

export function sellerEventTone(event: string): EventTone {
  switch (event as LedgerEvent) {
    case 'SALE_GROSS':
    case 'SELLER_PAYABLE':
      return 'success';
    case 'PLATFORM_COMMISSION':
    case 'PSP_FEE':
    case 'DISCOUNT_SELLER':
    case 'DISCOUNT_PLATFORM':
      return 'accent';
    case 'REFUND_GROSS':
    case 'SELLER_PAYABLE_REVERSAL':
    case 'COMMISSION_REVERSAL':
      return 'warn';
    case 'PAYOUT':
      return 'info';
    case 'ADJUSTMENT':
      return 'danger';
    default:
      return 'neutral';
  }
}

/**
 * The memo as a seller should read it.
 *
 * The API writes operational text — "SELLER_PAYABLE_REVERSAL for refund
 * RF-2026-00011" — which is right for an operator grepping the database and
 * wrong on a shopkeeper's statement: it shouts an enum name that the event
 * column already says, in English, next to a Russian label.
 *
 * So the enum prefix is dropped, and when the memo carries a document
 * reference (an order, refund or adjustment number) that reference is what is
 * shown, because it is the one part a seller can actually look up.
 */
export function sellerMemo(memo: string | null | undefined): string | null {
  if (!memo) return null;

  const reference = /\b((?:FM|RF|RT|ADJ|PO)-[\dA-Z-]+)\b/.exec(memo);
  if (reference) return reference[1];

  // Drop a leading SCREAMING_CASE token; it duplicates the event column.
  const withoutEnum = memo.replace(/^[A-Z][A-Z_]{3,}\s*/, '').trim();
  return withoutEnum.length > 0 ? withoutEnum : null;
}
