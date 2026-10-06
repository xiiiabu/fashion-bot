/**
 * Status presentation. The words come from @fashion/core's catalogue so every
 * surface agrees; only the colour is decided here.
 *
 * The mapping is deliberately conservative: only a genuine failure is red, and
 * a status the shopper has to act on is the accent. Painting every in-flight
 * status green makes the one that needs attention invisible.
 */

import type { OrderStatus, ReturnStatus, SubOrderStatus } from '@fashion/core';

type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'dark';

export function orderTone(status: OrderStatus | string): Tone {
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
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
    case 'RETURNED':
      return 'neutral';
    case 'PAID':
    case 'CONFIRMED':
    case 'PICKING':
      return 'dark';
    default:
      return 'neutral';
  }
}

export function subOrderTone(status: SubOrderStatus | string): Tone {
  switch (status) {
    case 'DELIVERED':
    case 'COMPLETED':
      return 'success';
    case 'REJECTED':
    case 'CANCELLED':
      return 'danger';
    case 'IN_TRANSIT':
    case 'READY_FOR_HANDOVER':
      return 'info';
    case 'PENDING_CONFIRMATION':
      return 'accent';
    case 'PARTIALLY_CANCELLED':
      return 'warn';
    default:
      return 'dark';
  }
}

export function returnTone(status: ReturnStatus | string): Tone {
  switch (status) {
    case 'REFUNDED':
    case 'COMPLETED':
      return 'success';
    case 'REJECTED':
    case 'CANCELLED':
    case 'DISPUTED':
      return 'danger';
    case 'REQUESTED':
      return 'accent';
    case 'APPROVED':
    case 'IN_TRANSIT':
    case 'RECEIVED':
    case 'INSPECTING':
      return 'info';
    case 'REFUND_PENDING':
      return 'warn';
    default:
      return 'neutral';
  }
}
