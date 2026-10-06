/**
 * Commission engine — spec §8.2, PAY-006, PAY-007, PAY-009, PAY-014.
 *
 * The contractual rule this implements:
 *
 *   Platform commission = rate x (actually paid value of each order item,
 *                                after seller-funded discount, excluding delivery)
 *
 * Platform-funded discounts, PSP fees, taxes, refunds and adjustments are
 * deliberately NOT folded into the rate. They are separate ledger entries
 * (Appendix B), so the effective take rate stays explainable.
 *
 * Everything is computed per OrderItem and only then summed, so the sum of
 * item commissions always equals the order total with documented rounding
 * (PAY-006 acceptance criterion).
 */

import {
  type CurrencyCode,
  type Money,
  type RoundingMode,
  DEFAULT_ROUNDING,
  add,
  applyBps,
  compare,
  max,
  money,
  multiply,
  prorate,
  subtract,
  sum,
  toBigInt,
  zero,
} from './money.js';

/** Default platform rate: 10% expressed in basis points (spec: "Базовая комиссия 10%"). */
export const DEFAULT_COMMISSION_BPS = 1000;

export type DiscountFunding = 'SELLER' | 'PLATFORM' | 'SHARED';

export interface CommissionRuleSnapshot {
  /** Stable rule identifier stored on every OrderItem (PAY-007). */
  readonly ruleId: string;
  readonly version: number;
  readonly rateBps: number;
  /** PAY-014: delivery is out of the base by default, but the rule can include it. */
  readonly includesDelivery: boolean;
  /** Whether a seller-funded discount lowers the commission base. */
  readonly sellerDiscountReducesBase: boolean;
  /** Whether a platform-funded discount lowers the commission base. */
  readonly platformDiscountReducesBase: boolean;
  readonly rounding: RoundingMode;
  /** Optional floor/cap per item, in minor units, as agreed per contract. */
  readonly minFeeMinor?: string | null;
  readonly maxFeeMinor?: string | null;
}

export const DEFAULT_COMMISSION_RULE: CommissionRuleSnapshot = {
  ruleId: 'default-10pct',
  version: 1,
  rateBps: DEFAULT_COMMISSION_BPS,
  includesDelivery: false,
  sellerDiscountReducesBase: true,
  platformDiscountReducesBase: false,
  rounding: DEFAULT_ROUNDING,
  minFeeMinor: null,
  maxFeeMinor: null,
};

export interface CommissionInput {
  /** Catalogue price for one unit at the moment of order (snapshot). */
  readonly unitPrice: Money;
  readonly quantity: number;
  /** Discount funded by the seller, for the whole line. */
  readonly sellerFundedDiscount?: Money;
  /** Discount funded by the platform (a subsidy), for the whole line. */
  readonly platformFundedDiscount?: Money;
  /** Delivery allocated to this line. Excluded from base unless rule says otherwise. */
  readonly deliveryAmount?: Money;
  readonly rule?: CommissionRuleSnapshot;
}

export interface CommissionResult {
  readonly currency: CurrencyCode;
  /** unitPrice x quantity, before any discount. */
  readonly lineGross: Money;
  readonly sellerFundedDiscount: Money;
  readonly platformFundedDiscount: Money;
  readonly deliveryAmount: Money;
  /** What the buyer actually pays for the goods on this line. */
  readonly buyerPaidForGoods: Money;
  /** The agreed commission base after rule-driven inclusions/exclusions. */
  readonly commissionBase: Money;
  readonly commission: Money;
  /** Gross merchandise amount minus commission, before PSP fee/tax/adjustments. */
  readonly sellerPayableBeforeAdjustments: Money;
  readonly rule: CommissionRuleSnapshot;
  /** Human-auditable description of how the base was formed. */
  readonly baseExplanation: string;
}

export function computeItemCommission(input: CommissionInput): CommissionResult {
  const rule = input.rule ?? DEFAULT_COMMISSION_RULE;
  const currency = input.unitPrice.currency;
  const quantity = Math.trunc(input.quantity);
  if (quantity <= 0) throw new Error('Commission quantity must be a positive integer');

  const lineGross = multiply(input.unitPrice, quantity);
  const sellerDiscount = input.sellerFundedDiscount ?? zero(currency);
  const platformDiscount = input.platformFundedDiscount ?? zero(currency);
  const delivery = input.deliveryAmount ?? zero(currency);

  // What the buyer hands over for goods on this line: both discounts reduce it,
  // regardless of who funds them.
  const buyerPaidForGoods = max(
    subtract(subtract(lineGross, sellerDiscount), platformDiscount),
    zero(currency),
  );

  // The commission base follows the contract, not the buyer's receipt.
  let base = lineGross;
  const explanation: string[] = ['unit price x quantity'];
  if (rule.sellerDiscountReducesBase && toBigInt(sellerDiscount) !== 0n) {
    base = subtract(base, sellerDiscount);
    explanation.push('- seller-funded discount');
  }
  if (rule.platformDiscountReducesBase && toBigInt(platformDiscount) !== 0n) {
    base = subtract(base, platformDiscount);
    explanation.push('- platform-funded discount');
  }
  if (rule.includesDelivery && toBigInt(delivery) !== 0n) {
    base = add(base, delivery);
    explanation.push('+ delivery');
  } else if (toBigInt(delivery) !== 0n) {
    explanation.push('(delivery excluded)');
  }
  base = max(base, zero(currency));

  let commission = applyBps(base, rule.rateBps, rule.rounding);
  if (rule.minFeeMinor != null) {
    const floor = money(rule.minFeeMinor, currency);
    if (compare(commission, floor) < 0 && toBigInt(base) > 0n) commission = floor;
  }
  if (rule.maxFeeMinor != null) {
    const cap = money(rule.maxFeeMinor, currency);
    if (compare(commission, cap) > 0) commission = cap;
  }
  // The platform never claims more than the goods value on the line.
  if (compare(commission, base) > 0) commission = base;

  return {
    currency,
    lineGross,
    sellerFundedDiscount: sellerDiscount,
    platformFundedDiscount: platformDiscount,
    deliveryAmount: delivery,
    buyerPaidForGoods,
    commissionBase: base,
    commission,
    sellerPayableBeforeAdjustments: subtract(base, commission),
    rule,
    baseExplanation: explanation.join(' '),
  };
}

export interface OrderCommissionLine extends CommissionInput {
  readonly orderItemId: string;
  readonly sellerId: string;
}

export interface SellerCommissionTotals {
  readonly sellerId: string;
  readonly gross: Money;
  readonly commission: Money;
  readonly payable: Money;
  readonly itemCount: number;
}

export interface OrderCommissionBreakdown {
  readonly currency: CurrencyCode;
  readonly items: Array<CommissionResult & { orderItemId: string; sellerId: string }>;
  readonly bySeller: SellerCommissionTotals[];
  readonly totalGross: Money;
  readonly totalCommission: Money;
  readonly totalSellerPayable: Money;
  /** Effective take rate in basis points, derived — never used to compute money. */
  readonly effectiveTakeRateBps: number;
}

export function computeOrderCommission(
  lines: OrderCommissionLine[],
  currency: CurrencyCode = 'UZS',
): OrderCommissionBreakdown {
  const items = lines.map((line) => ({
    ...computeItemCommission(line),
    orderItemId: line.orderItemId,
    sellerId: line.sellerId,
  }));

  const sellerMap = new Map<string, { gross: Money; commission: Money; payable: Money; itemCount: number }>();
  for (const item of items) {
    const current =
      sellerMap.get(item.sellerId) ??
      { gross: zero(currency), commission: zero(currency), payable: zero(currency), itemCount: 0 };
    sellerMap.set(item.sellerId, {
      gross: add(current.gross, item.commissionBase),
      commission: add(current.commission, item.commission),
      payable: add(current.payable, item.sellerPayableBeforeAdjustments),
      itemCount: current.itemCount + 1,
    });
  }

  const totalGross = sum(items.map((i) => i.commissionBase), currency);
  const totalCommission = sum(items.map((i) => i.commission), currency);
  const totalSellerPayable = sum(items.map((i) => i.sellerPayableBeforeAdjustments), currency);
  const grossBig = toBigInt(totalGross);

  return {
    currency,
    items,
    bySeller: [...sellerMap.entries()].map(([sellerId, totals]) => ({ sellerId, ...totals })),
    totalGross,
    totalCommission,
    totalSellerPayable,
    effectiveTakeRateBps:
      grossBig === 0n ? 0 : Number((toBigInt(totalCommission) * 10_000n) / grossBig),
  };
}

export interface RefundReversalInput {
  /** The commission result produced when the item was sold. */
  readonly original: CommissionResult;
  /** Units being returned (<= original quantity). */
  readonly refundQuantity: number;
  readonly originalQuantity: number;
  /** For a partial-value refund (e.g. goodwill), override the refunded gross. */
  readonly refundGrossOverride?: Money;
}

export interface RefundReversalResult {
  readonly refundGross: Money;
  readonly commissionReversal: Money;
  readonly sellerPayableReversal: Money;
  readonly proportionBps: number;
}

/**
 * PAY-009: a partial refund reverses exactly its share of commission and
 * seller payable — no more, no less. Spec example: a 40% return on
 * 1 000 000 UZS reverses 40 000 commission and 360 000 seller payable.
 */
export function computeRefundReversal(input: RefundReversalInput): RefundReversalResult {
  const { original, originalQuantity } = input;
  const currency = original.currency;
  if (originalQuantity <= 0) throw new Error('originalQuantity must be > 0');

  const refundGross =
    input.refundGrossOverride ??
    prorate(original.commissionBase, input.refundQuantity, originalQuantity, original.rule.rounding);

  const baseBig = toBigInt(original.commissionBase);
  if (baseBig === 0n) {
    return {
      refundGross,
      commissionReversal: zero(currency),
      sellerPayableReversal: zero(currency),
      proportionBps: 0,
    };
  }

  const refundBig = toBigInt(refundGross);
  const commissionReversal = prorate(original.commission, refundBig, baseBig, original.rule.rounding);
  const sellerPayableReversal = subtract(refundGross, commissionReversal);

  return {
    refundGross,
    commissionReversal,
    sellerPayableReversal,
    proportionBps: Number((refundBig * 10_000n) / baseBig),
  };
}

/**
 * PSP fee allocation (PAY-015). The fee is a separate ledger entry and is
 * never hidden inside the 10%; this only decides which line carries which part.
 */
export function allocatePspFee(
  totalFee: Money,
  lineAmounts: Money[],
): Money[] {
  if (lineAmounts.length === 0) return [];
  return splitAcross(totalFee, lineAmounts);
}

function splitAcross(total: Money, weights: Money[]): Money[] {
  const weightValues = weights.map((w) => toBigInt(w));
  const weightSum = weightValues.reduce((acc, w) => acc + w, 0n);
  if (weightSum === 0n) {
    return weights.map(() => zero(total.currency));
  }
  const totalBig = toBigInt(total);
  const shares: bigint[] = [];
  let allocated = 0n;
  for (const weight of weightValues) {
    const share = (totalBig * weight) / weightSum;
    shares.push(share);
    allocated += share;
  }
  let drift = totalBig - allocated;
  const step = drift < 0n ? -1n : 1n;
  for (let i = 0; i < shares.length && drift !== 0n; i += 1) {
    shares[i] = shares[i]! + step;
    drift -= step;
  }
  return shares.map((amount) => ({ amount: amount.toString(), currency: total.currency }));
}
