/**
 * Status presentation for the operator surface.
 *
 * The vocabularies come from @fashion/core, which owns the state machines, so
 * a status the panel offers is a status the API will accept. A hand-written
 * list here drifts the moment a machine gains a state, and the way that drift
 * shows up is an operator picking an option that 422s.
 *
 * Only the colour and the Russian label are decided here, and conservatively:
 * a status an operator must act on is the accent, a genuine failure is red,
 * and everything in flight is neutral or blue. Painting every in-flight status
 * green is how the one that needs attention becomes invisible.
 */

import {
  ORDER_STATUSES,
  PRODUCT_LIFECYCLE,
  RETURN_STATUSES,
  SUBORDER_STATUSES,
  type ProductLifecycle,
  type ReturnStatus,
} from '@fashion/core';
import type { Tone } from '@/components/ui';

/*
 * Order matters here. The option arrays below call the label helpers while the
 * module is evaluating, and those helpers read the label maps. A `const` is in
 * its temporal dead zone until its own initialiser runs, so the maps are
 * declared first — with them last, building the arrays threw
 * "Cannot access ... before initialization" at render time.
 */

/* ── Labels ──────────────────────────────────────────────────────────────── */

const LIFECYCLE_LABELS: Record<string, string> = {
  DRAFT: 'Черновик',
  IN_REVIEW: 'На модерации',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'В архиве',
  REJECTED: 'Отклонён',
};

export function lifecycleLabel(lifecycle: string): string {
  return LIFECYCLE_LABELS[lifecycle] ?? lifecycle;
}

const ONBOARDING_LABELS: Record<string, string> = {
  LEAD: 'Заявка',
  KYB_PENDING: 'Проверка документов',
  CONTRACT_PENDING: 'Подписание договора',
  ACTIVE: 'Активен',
  SUSPENDED: 'Приостановлен',
  OFFBOARDED: 'Отключён',
};

export function onboardingLabel(status: string): string {
  return ONBOARDING_LABELS[status] ?? status;
}

const RETURN_LABELS: Record<string, string> = {
  REQUESTED: 'Заявка',
  APPROVED: 'Одобрен',
  REJECTED: 'Отклонён',
  HANDED_OVER: 'Передан курьеру',
  RECEIVED: 'Получен',
  INSPECTED: 'Осмотрен',
  REFUND_PENDING: 'Возврат в оплате',
  REFUNDED: 'Деньги возвращены',
  CANCELLED: 'Отменён',
  DISPUTED: 'Спор',
};

export function returnLabel(status: string): string {
  return RETURN_LABELS[status] ?? status;
}

const PAYOUT_LABELS: Record<string, string> = {
  DRAFT: 'Черновик',
  PENDING_APPROVAL: 'На согласовании',
  APPROVED: 'Согласован',
  SENT: 'Отправлен в банк',
  SETTLED: 'Оплачен',
  REJECTED: 'Отклонён',
  FAILED: 'Ошибка',
};

export function payoutLabel(status: string): string {
  return PAYOUT_LABELS[status] ?? status;
}

/* ── Vocabularies ────────────────────────────────────────────────────────── */

export const ORDER_STATUS_OPTIONS = ORDER_STATUSES.map((value) => ({ value, label: value }));
export const SUBORDER_STATUS_OPTIONS = SUBORDER_STATUSES.map((value) => ({ value, label: value }));

export const RETURN_STATUS_OPTIONS: Array<{ value: ReturnStatus; label: string }> =
  RETURN_STATUSES.map((value) => ({ value, label: returnLabel(value) }));

export const LIFECYCLE_OPTIONS: Array<{ value: ProductLifecycle; label: string }> =
  PRODUCT_LIFECYCLE.map((value) => ({ value, label: lifecycleLabel(value) }));

/** The seller onboarding states, in the order a seller passes through them. */
export const SELLER_ONBOARDING_STATUSES = [
  'LEAD',
  'KYB_PENDING',
  'CONTRACT_PENDING',
  'ACTIVE',
  'SUSPENDED',
  'OFFBOARDED',
] as const;

export type SellerOnboardingStatus = (typeof SELLER_ONBOARDING_STATUSES)[number];

/** The payout batch states, from PayoutBatchStatus. */
export const PAYOUT_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'SETTLED',
  'REJECTED',
  'FAILED',
] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/* ── Tones ───────────────────────────────────────────────────────────────── */

export function orderTone(status: string): Tone {
  switch (status) {
    case 'DELIVERED':
    case 'COMPLETED':
      return 'success';
    case 'AWAITING_PAYMENT':
    case 'QUOTED':
      return 'accent';
    case 'PAYMENT_FAILED':
    case 'CANCELLED':
    case 'DISPUTED':
      return 'danger';
    case 'PARTIALLY_CANCELLED':
    case 'RETURN_REQUESTED':
    case 'RETURN_IN_TRANSIT':
    case 'REFUND_PENDING':
      return 'warn';
    case 'IN_TRANSIT':
    case 'READY_FOR_HANDOVER':
      return 'info';
    default:
      return 'neutral';
  }
}

export function subOrderTone(status: string): Tone {
  switch (status) {
    case 'DELIVERED':
    case 'COMPLETED':
      return 'success';
    case 'REJECTED':
    case 'CANCELLED':
      return 'danger';
    case 'PENDING_CONFIRMATION':
      return 'accent';
    case 'IN_TRANSIT':
    case 'READY_FOR_HANDOVER':
    case 'HANDED_OVER':
      return 'info';
    case 'PARTIALLY_CANCELLED':
    case 'RETURN_IN_PROGRESS':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function returnTone(status: string): Tone {
  switch (status) {
    case 'REFUNDED':
      return 'success';
    case 'REJECTED':
    case 'CANCELLED':
    case 'DISPUTED':
      return 'danger';
    case 'REQUESTED':
      return 'accent';
    case 'APPROVED':
    case 'HANDED_OVER':
    case 'RECEIVED':
    case 'INSPECTED':
      return 'info';
    case 'REFUND_PENDING':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function lifecycleTone(lifecycle: string): Tone {
  switch (lifecycle) {
    case 'PUBLISHED':
      return 'success';
    case 'REJECTED':
      return 'danger';
    case 'IN_REVIEW':
      return 'accent';
    case 'ARCHIVED':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function payoutTone(status: string): Tone {
  switch (status) {
    case 'SETTLED':
      return 'success';
    case 'FAILED':
    case 'REJECTED':
      return 'danger';
    case 'PENDING_APPROVAL':
      return 'accent';
    case 'APPROVED':
    case 'SENT':
      return 'info';
    default:
      return 'neutral';
  }
}

export function severityTone(severity: string): Tone {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      return 'danger';
    case 'ERROR':
      return 'danger';
    case 'WARNING':
    case 'WARN':
      return 'warn';
    case 'NOTICE':
      return 'accent';
    case 'INFO':
      return 'info';
    default:
      return 'neutral';
  }
}

export function onboardingTone(status: string): Tone {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'SUSPENDED':
      return 'danger';
    case 'OFFBOARDED':
      return 'dark';
    case 'KYB_PENDING':
    case 'CONTRACT_PENDING':
      return 'accent';
    default:
      return 'neutral';
  }
}
