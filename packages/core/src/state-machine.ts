/**
 * Order / payment / shipment / return state machines.
 *
 * Spec ORD-010 ("statuses are separate, never one ambiguous status"),
 * ORD-011 ("all transitions go through a state machine and audit"),
 * §7.1 (the recommended status set) and FUL-007 (return statuses).
 *
 * Keep these as pure data + pure functions: the API, the admin panel, the
 * seller cabinet and the tests all agree on legality from one source.
 */

export const ORDER_STATUSES = [
  'DRAFT',
  'QUOTED',
  'AWAITING_PAYMENT',
  'PAID',
  'CONFIRMED',
  'PICKING',
  'READY_FOR_HANDOVER',
  'IN_TRANSIT',
  'DELIVERED',
  'PAYMENT_FAILED',
  'CANCELLED',
  'PARTIALLY_CANCELLED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED',
  'COMPLETED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses from which nothing further can happen without manual intervention. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  'CANCELLED',
  'REFUNDED',
  'COMPLETED',
];

const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ['QUOTED', 'CANCELLED'],
  QUOTED: ['AWAITING_PAYMENT', 'DRAFT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_FAILED: ['AWAITING_PAYMENT', 'CANCELLED'],
  PAID: ['CONFIRMED', 'PARTIALLY_CANCELLED', 'CANCELLED', 'REFUND_PENDING', 'DISPUTED'],
  CONFIRMED: ['PICKING', 'PARTIALLY_CANCELLED', 'CANCELLED', 'REFUND_PENDING', 'DISPUTED'],
  PICKING: ['READY_FOR_HANDOVER', 'PARTIALLY_CANCELLED', 'CANCELLED', 'DISPUTED'],
  READY_FOR_HANDOVER: ['IN_TRANSIT', 'PARTIALLY_CANCELLED', 'CANCELLED', 'DISPUTED'],
  IN_TRANSIT: ['DELIVERED', 'RETURN_REQUESTED', 'DISPUTED', 'PARTIALLY_CANCELLED'],
  DELIVERED: ['RETURN_REQUESTED', 'COMPLETED', 'DISPUTED'],
  PARTIALLY_CANCELLED: [
    'CONFIRMED',
    'PICKING',
    'READY_FOR_HANDOVER',
    'IN_TRANSIT',
    'DELIVERED',
    'REFUND_PENDING',
    'PARTIALLY_REFUNDED',
    'CANCELLED',
    'DISPUTED',
  ],
  RETURN_REQUESTED: ['RETURN_IN_TRANSIT', 'DELIVERED', 'REFUND_PENDING', 'DISPUTED'],
  RETURN_IN_TRANSIT: ['RETURNED', 'DISPUTED'],
  RETURNED: ['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'],
  REFUND_PENDING: ['REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'],
  PARTIALLY_REFUNDED: ['REFUND_PENDING', 'REFUNDED', 'RETURN_REQUESTED', 'COMPLETED', 'DISPUTED'],
  REFUNDED: ['DISPUTED'],
  DISPUTED: ['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DELIVERED', 'CANCELLED', 'COMPLETED'],
  CANCELLED: [],
  COMPLETED: ['RETURN_REQUESTED', 'DISPUTED'],
};

export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CHARGEBACK',
  'RECONCILIATION_HOLD',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ['PENDING', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PENDING: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED', 'RECONCILIATION_HOLD'],
  AUTHORIZED: ['CAPTURED', 'CANCELLED', 'FAILED', 'EXPIRED', 'RECONCILIATION_HOLD'],
  // PAY-005: an amount mismatch parks the payment instead of marking the order paid.
  RECONCILIATION_HOLD: ['CAPTURED', 'FAILED', 'CANCELLED'],
  CAPTURED: ['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CHARGEBACK'],
  REFUND_PENDING: ['PARTIALLY_REFUNDED', 'REFUNDED', 'CAPTURED'],
  PARTIALLY_REFUNDED: ['REFUND_PENDING', 'REFUNDED', 'CHARGEBACK'],
  REFUNDED: ['CHARGEBACK'],
  CHARGEBACK: ['CAPTURED', 'REFUNDED'],
  FAILED: ['PENDING'],
  CANCELLED: [],
  EXPIRED: [],
};

export const SHIPMENT_STATUSES = [
  'PENDING',
  'LABEL_CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED_ATTEMPT',
  'RETURNED_TO_SELLER',
  'CANCELLED',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  PENDING: ['LABEL_CREATED', 'CANCELLED'],
  LABEL_CREATED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT', 'RETURNED_TO_SELLER', 'CANCELLED'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'RETURNED_TO_SELLER'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'FAILED_ATTEMPT'],
  FAILED_ATTEMPT: ['OUT_FOR_DELIVERY', 'IN_TRANSIT', 'RETURNED_TO_SELLER'],
  DELIVERED: [],
  RETURNED_TO_SELLER: [],
  CANCELLED: [],
};

/** FUL-007: requested -> approved/rejected -> handed over -> received -> inspected -> refunded. */
export const RETURN_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'HANDED_OVER',
  'RECEIVED',
  'INSPECTED',
  'REFUND_PENDING',
  'REFUNDED',
  'CANCELLED',
  'DISPUTED',
] as const;

export type ReturnStatus = (typeof RETURN_STATUSES)[number];

const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['HANDED_OVER', 'CANCELLED', 'DISPUTED'],
  REJECTED: ['DISPUTED'],
  HANDED_OVER: ['RECEIVED', 'DISPUTED'],
  RECEIVED: ['INSPECTED', 'DISPUTED'],
  INSPECTED: ['REFUND_PENDING', 'REJECTED', 'DISPUTED'],
  REFUND_PENDING: ['REFUNDED', 'DISPUTED'],
  REFUNDED: ['DISPUTED'],
  CANCELLED: [],
  DISPUTED: ['APPROVED', 'REJECTED', 'REFUND_PENDING', 'REFUNDED'],
};

export const SUBORDER_STATUSES = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'REJECTED',
  'PICKING',
  'READY_FOR_HANDOVER',
  'HANDED_OVER',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
  'PARTIALLY_CANCELLED',
  'RETURN_IN_PROGRESS',
  'RETURNED',
  'COMPLETED',
] as const;

export type SubOrderStatus = (typeof SUBORDER_STATUSES)[number];

const SUBORDER_TRANSITIONS: Record<SubOrderStatus, readonly SubOrderStatus[]> = {
  PENDING_CONFIRMATION: ['CONFIRMED', 'REJECTED', 'CANCELLED', 'PARTIALLY_CANCELLED'],
  CONFIRMED: ['PICKING', 'CANCELLED', 'PARTIALLY_CANCELLED'],
  PICKING: ['READY_FOR_HANDOVER', 'PARTIALLY_CANCELLED', 'CANCELLED'],
  READY_FOR_HANDOVER: ['HANDED_OVER', 'PARTIALLY_CANCELLED', 'CANCELLED'],
  HANDED_OVER: ['IN_TRANSIT', 'DELIVERED'],
  IN_TRANSIT: ['DELIVERED', 'RETURN_IN_PROGRESS'],
  DELIVERED: ['RETURN_IN_PROGRESS', 'COMPLETED'],
  PARTIALLY_CANCELLED: [
    'PICKING',
    'READY_FOR_HANDOVER',
    'HANDED_OVER',
    'IN_TRANSIT',
    'DELIVERED',
    'CANCELLED',
    'COMPLETED',
  ],
  RETURN_IN_PROGRESS: ['RETURNED', 'DELIVERED', 'COMPLETED'],
  RETURNED: ['COMPLETED'],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: ['RETURN_IN_PROGRESS'],
};

export const PRODUCT_LIFECYCLE = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'] as const;
export type ProductLifecycle = (typeof PRODUCT_LIFECYCLE)[number];

/** CAT-009: draft -> review -> published -> archived. Production only sees PUBLISHED. */
const PRODUCT_TRANSITIONS: Record<ProductLifecycle, readonly ProductLifecycle[]> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['PUBLISHED', 'REJECTED', 'DRAFT'],
  REJECTED: ['DRAFT', 'IN_REVIEW', 'ARCHIVED'],
  PUBLISHED: ['IN_REVIEW', 'ARCHIVED', 'DRAFT'],
  ARCHIVED: ['DRAFT'],
};

export type MachineName = 'order' | 'suborder' | 'payment' | 'shipment' | 'return' | 'product';

const MACHINES: Record<MachineName, Record<string, readonly string[]>> = {
  order: ORDER_TRANSITIONS,
  suborder: SUBORDER_TRANSITIONS,
  payment: PAYMENT_TRANSITIONS,
  shipment: SHIPMENT_TRANSITIONS,
  return: RETURN_TRANSITIONS,
  product: PRODUCT_TRANSITIONS,
};

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_STATE_TRANSITION';
  constructor(
    readonly machine: MachineName,
    readonly from: string,
    readonly to: string,
    readonly allowed: readonly string[],
  ) {
    super(
      `Illegal ${machine} transition ${from} -> ${to}. Allowed from ${from}: ${
        allowed.length ? allowed.join(', ') : '(terminal)'
      }`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function allowedTransitions(machine: MachineName, from: string): readonly string[] {
  return MACHINES[machine][from] ?? [];
}

export function canTransition(machine: MachineName, from: string, to: string): boolean {
  if (from === to) return true; // idempotent re-application of the same status
  return allowedTransitions(machine, from).includes(to);
}

/** Throws IllegalTransitionError, which the API maps to HTTP 409. */
export function assertTransition(machine: MachineName, from: string, to: string): void {
  if (!canTransition(machine, from, to)) {
    throw new IllegalTransitionError(machine, from, to, allowedTransitions(machine, from));
  }
}

export function isTerminal(machine: MachineName, status: string): boolean {
  return allowedTransitions(machine, status).length === 0;
}

/**
 * Statuses that may be a destination but never a waypoint.
 *
 * Each of these asserts something specific and consequential — money was
 * refunded, a seller cancelled lines, the order is in dispute. Routing
 * through one on the way somewhere else would write a false statement into
 * OrderStatusHistory, which ORD-011 and ADM-006 exist to prevent. Without
 * this, the shortest route from PAID to DELIVERED runs through
 * PARTIALLY_CANCELLED in two hops instead of the documented five.
 */
const NEVER_A_WAYPOINT: Readonly<Record<MachineName, readonly string[]>> = {
  order: [
    'CANCELLED',
    'PARTIALLY_CANCELLED',
    'PAYMENT_FAILED',
    'DISPUTED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'RETURNED',
    'RETURN_IN_TRANSIT',
    'COMPLETED',
    'DRAFT',
  ],
  suborder: ['CANCELLED', 'PARTIALLY_CANCELLED', 'REJECTED', 'RETURNED', 'COMPLETED'],
  payment: ['CANCELLED', 'EXPIRED', 'FAILED', 'CHARGEBACK', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  shipment: ['CANCELLED', 'RETURNED_TO_SELLER', 'FAILED_ATTEMPT'],
  return: ['CANCELLED', 'REJECTED', 'DISPUTED', 'REFUNDED'],
  product: ['ARCHIVED', 'REJECTED'],
};

/**
 * Shortest legal route from `from` to `to`, inclusive of `to`.
 *
 * Needed because a derived status is not always one hop away. Two sellers
 * working at different speeds can leave the master order at PAID while the
 * derivation already says PICKING; applying PAID -> PICKING directly would be
 * rejected and the order would stick. Walking CONFIRMED then PICKING keeps
 * ORD-011 intact — every step is validated and every step is recorded —
 * instead of forcing an illegal jump.
 *
 * Returns an empty array when `to` is unreachable without passing through a
 * status that would be untrue; the caller then leaves the status alone and
 * logs it rather than inventing a route.
 */
export function shortestPath(machine: MachineName, from: string, to: string): string[] {
  if (from === to) return [];
  const direct = allowedTransitions(machine, from);
  if (direct.includes(to)) return [to];

  const forbidden = new Set(NEVER_A_WAYPOINT[machine]);
  const queue: Array<{ status: string; path: string[] }> = [{ status: from, path: [] }];
  const seen = new Set<string>([from]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of allowedTransitions(machine, current.status)) {
      if (seen.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      // The destination may be an exception status; a waypoint may not.
      if (forbidden.has(next)) continue;
      seen.add(next);
      queue.push({ status: next, path });
    }
  }
  return [];
}

/**
 * Derive the customer-facing master order status from its suborders.
 * The client sees one order (ORD-003) while operations work on suborders.
 */
export function deriveOrderStatus(
  subStatuses: SubOrderStatus[],
  paymentStatus: PaymentStatus,
): OrderStatus {
  if (subStatuses.length === 0) return paymentStatus === 'CAPTURED' ? 'PAID' : 'AWAITING_PAYMENT';

  if (paymentStatus === 'FAILED') return 'PAYMENT_FAILED';
  if (paymentStatus === 'REFUNDED') return 'REFUNDED';
  if (paymentStatus === 'PARTIALLY_REFUNDED') return 'PARTIALLY_REFUNDED';
  if (paymentStatus === 'REFUND_PENDING') return 'REFUND_PENDING';
  if (paymentStatus === 'CHARGEBACK') return 'DISPUTED';
  if (paymentStatus !== 'CAPTURED') return 'AWAITING_PAYMENT';

  const unique = new Set(subStatuses);
  const every = (...candidates: SubOrderStatus[]) =>
    subStatuses.every((status) => candidates.includes(status));
  const some = (...candidates: SubOrderStatus[]) =>
    subStatuses.some((status) => candidates.includes(status));

  if (every('CANCELLED', 'REJECTED')) return 'CANCELLED';
  if (some('RETURN_IN_PROGRESS')) return 'RETURN_REQUESTED';
  if (every('RETURNED')) return 'RETURNED';
  if (every('COMPLETED', 'RETURNED', 'CANCELLED', 'REJECTED')) return 'COMPLETED';
  if (every('DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'RETURNED')) return 'DELIVERED';
  if (some('IN_TRANSIT', 'HANDED_OVER')) return 'IN_TRANSIT';
  if (some('READY_FOR_HANDOVER')) return 'READY_FOR_HANDOVER';
  if (some('PICKING')) return 'PICKING';
  if (some('CANCELLED', 'REJECTED', 'PARTIALLY_CANCELLED') && unique.size > 1) {
    return 'PARTIALLY_CANCELLED';
  }
  if (every('CONFIRMED')) return 'CONFIRMED';
  return 'PAID';
}

/** Buyer-visible grouping, so the Mini App does not leak operational detail. */
export type OrderPhase = 'placed' | 'preparing' | 'shipping' | 'delivered' | 'returning' | 'closed' | 'problem';

export function orderPhase(status: OrderStatus): OrderPhase {
  switch (status) {
    case 'DRAFT':
    case 'QUOTED':
    case 'AWAITING_PAYMENT':
      return 'placed';
    case 'PAID':
    case 'CONFIRMED':
    case 'PICKING':
    case 'READY_FOR_HANDOVER':
      return 'preparing';
    case 'IN_TRANSIT':
      return 'shipping';
    case 'DELIVERED':
      return 'delivered';
    case 'RETURN_REQUESTED':
    case 'RETURN_IN_TRANSIT':
    case 'RETURNED':
    case 'REFUND_PENDING':
      return 'returning';
    case 'COMPLETED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
    case 'CANCELLED':
    case 'PARTIALLY_CANCELLED':
      return 'closed';
    case 'PAYMENT_FAILED':
    case 'DISPUTED':
      return 'problem';
    default:
      return 'placed';
  }
}

/** Whether the buyer may still cancel without talking to support (ORD-009). */
export function buyerCanCancel(status: OrderStatus): boolean {
  return (['QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_FAILED', 'PAID', 'CONFIRMED'] as OrderStatus[]).includes(
    status,
  );
}

/** Whether a return may be opened against the order at all (eligibility gate 1). */
export function returnableStatus(status: OrderStatus): boolean {
  return (['DELIVERED', 'COMPLETED', 'PARTIALLY_REFUNDED'] as OrderStatus[]).includes(status);
}
