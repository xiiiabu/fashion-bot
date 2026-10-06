/**
 * Append-only ledger vocabulary — spec PAY-008 and Appendix B.
 *
 * Nothing in the ledger is ever updated or deleted. A mistake is corrected by
 * a compensating entry (ADJUSTMENT) with reason, role and approval (PAY-017).
 * Any balance in the admin panel or a seller statement must be reproducible by
 * replaying entries, which is what `foldEntries` exists to prove.
 */

import { type CurrencyCode, type Money, add, money, toBigInt, zero } from './money.js';

/** Appendix B event vocabulary, in the document's order. */
export const LEDGER_EVENTS = [
  'SALE_GROSS',
  'PLATFORM_COMMISSION',
  'SELLER_PAYABLE',
  'DISCOUNT_SELLER',
  'DISCOUNT_PLATFORM',
  'PSP_FEE',
  'REFUND_GROSS',
  'COMMISSION_REVERSAL',
  'SELLER_PAYABLE_REVERSAL',
  'PAYOUT',
  'ADJUSTMENT',
] as const;

export type LedgerEvent = (typeof LEDGER_EVENTS)[number];

/** Which book an entry lands in. */
export const LEDGER_ACCOUNTS = [
  'PLATFORM_REVENUE',
  'SELLER_PAYABLE',
  'PSP_CLEARING',
  'BUYER_SETTLEMENT',
  'PLATFORM_PROMO_EXPENSE',
  'PLATFORM_CASH',
] as const;

export type LedgerAccountKind = (typeof LEDGER_ACCOUNTS)[number];

export interface LedgerEventMeta {
  readonly event: LedgerEvent;
  /** Natural sign of the entry, matching the Appendix B "Знак" column. */
  readonly sign: 1 | -1;
  readonly account: LedgerAccountKind;
  /** Does this event move the seller's payable balance? */
  readonly affectsSellerBalance: boolean;
  /** Does it move recognised platform revenue? */
  readonly affectsPlatformRevenue: boolean;
  readonly description: string;
}

export const LEDGER_EVENT_META: Record<LedgerEvent, LedgerEventMeta> = {
  SALE_GROSS: {
    event: 'SALE_GROSS',
    sign: 1,
    account: 'BUYER_SETTLEMENT',
    affectsSellerBalance: false,
    affectsPlatformRevenue: false,
    description: 'Paid value of an order item',
  },
  PLATFORM_COMMISSION: {
    event: 'PLATFORM_COMMISSION',
    sign: 1,
    account: 'PLATFORM_REVENUE',
    affectsSellerBalance: false,
    affectsPlatformRevenue: true,
    description: 'Platform claim under the applied commission rule',
  },
  SELLER_PAYABLE: {
    event: 'SELLER_PAYABLE',
    sign: 1,
    account: 'SELLER_PAYABLE',
    affectsSellerBalance: true,
    affectsPlatformRevenue: false,
    description: 'Obligation to the seller before payout',
  },
  DISCOUNT_SELLER: {
    event: 'DISCOUNT_SELLER',
    sign: -1,
    account: 'SELLER_PAYABLE',
    affectsSellerBalance: true,
    affectsPlatformRevenue: false,
    description: 'Discount funded by the seller',
  },
  DISCOUNT_PLATFORM: {
    event: 'DISCOUNT_PLATFORM',
    sign: -1,
    account: 'PLATFORM_PROMO_EXPENSE',
    affectsSellerBalance: false,
    affectsPlatformRevenue: true,
    description: 'Platform subsidy',
  },
  PSP_FEE: {
    event: 'PSP_FEE',
    sign: -1,
    account: 'PSP_CLEARING',
    affectsSellerBalance: false,
    affectsPlatformRevenue: true,
    description: 'Provider fee; bearer is defined by contract',
  },
  REFUND_GROSS: {
    event: 'REFUND_GROSS',
    sign: -1,
    account: 'BUYER_SETTLEMENT',
    affectsSellerBalance: false,
    affectsPlatformRevenue: false,
    description: 'Refund to the buyer',
  },
  COMMISSION_REVERSAL: {
    event: 'COMMISSION_REVERSAL',
    sign: -1,
    account: 'PLATFORM_REVENUE',
    affectsSellerBalance: false,
    affectsPlatformRevenue: true,
    description: 'Reversal of commission',
  },
  SELLER_PAYABLE_REVERSAL: {
    event: 'SELLER_PAYABLE_REVERSAL',
    sign: -1,
    account: 'SELLER_PAYABLE',
    affectsSellerBalance: true,
    affectsPlatformRevenue: false,
    description: 'Reversal of the seller obligation',
  },
  PAYOUT: {
    event: 'PAYOUT',
    sign: -1,
    account: 'SELLER_PAYABLE',
    affectsSellerBalance: true,
    affectsPlatformRevenue: false,
    description: 'Actual payout to the seller',
  },
  ADJUSTMENT: {
    event: 'ADJUSTMENT',
    sign: 1,
    account: 'SELLER_PAYABLE',
    affectsSellerBalance: true,
    affectsPlatformRevenue: false,
    description: 'Manual correction with approval and audit',
  },
};

export interface LedgerEntryInput {
  readonly event: LedgerEvent;
  /** Always stored as a positive magnitude; the sign comes from the event. */
  readonly amount: Money;
  readonly sellerId?: string | null;
  readonly orderId?: string | null;
  readonly orderItemId?: string | null;
  readonly refundId?: string | null;
  readonly payoutBatchId?: string | null;
  readonly commissionRuleId?: string | null;
  readonly memo?: string | null;
}

export interface LedgerBalances {
  readonly currency: CurrencyCode;
  /** What the platform owes each seller right now. */
  readonly sellerPayable: Map<string, Money>;
  readonly platformRevenue: Money;
  readonly promoExpense: Money;
  readonly pspFees: Money;
  readonly buyerSettlement: Money;
  readonly paidOut: Money;
}

/** Signed value of an entry, i.e. what it contributes to its account. */
export function signedAmount(event: LedgerEvent, amount: Money): Money {
  const meta = LEDGER_EVENT_META[event];
  const magnitude = toBigInt(amount);
  const positive = magnitude < 0n ? -magnitude : magnitude;
  return money(meta.sign === 1 ? positive : -positive, amount.currency);
}

/**
 * Replay entries into balances. PAY-008's acceptance criterion is exactly
 * this: "balance is recoverable from entries".
 */
export function foldEntries(
  entries: LedgerEntryInput[],
  currency: CurrencyCode = 'UZS',
): LedgerBalances {
  const sellerPayable = new Map<string, Money>();
  let platformRevenue = zero(currency);
  let promoExpense = zero(currency);
  let pspFees = zero(currency);
  let buyerSettlement = zero(currency);
  let paidOut = zero(currency);

  for (const entry of entries) {
    const meta = LEDGER_EVENT_META[entry.event];
    const signed = signedAmount(entry.event, entry.amount);

    if (meta.affectsSellerBalance && entry.sellerId) {
      const current = sellerPayable.get(entry.sellerId) ?? zero(currency);
      sellerPayable.set(entry.sellerId, add(current, signed));
    }
    switch (meta.account) {
      case 'PLATFORM_REVENUE':
        platformRevenue = add(platformRevenue, signed);
        break;
      case 'PLATFORM_PROMO_EXPENSE':
        promoExpense = add(promoExpense, signed);
        break;
      case 'PSP_CLEARING':
        pspFees = add(pspFees, signed);
        break;
      case 'BUYER_SETTLEMENT':
        buyerSettlement = add(buyerSettlement, signed);
        break;
      default:
        break;
    }
    if (entry.event === 'PAYOUT') paidOut = add(paidOut, signedAmount('SALE_GROSS', entry.amount));
  }

  return {
    currency,
    sellerPayable,
    platformRevenue,
    promoExpense,
    pspFees,
    buyerSettlement,
    paidOut,
  };
}

/**
 * The full set of entries produced when one order item is paid.
 * Called once per OrderItem so every amount traces to a single item (§8 intro).
 */
export interface SaleEntriesInput {
  readonly orderId: string;
  readonly orderItemId: string;
  readonly sellerId: string;
  readonly commissionRuleId: string;
  readonly buyerPaidForGoods: Money;
  readonly commission: Money;
  readonly sellerPayable: Money;
  readonly sellerFundedDiscount?: Money;
  readonly platformFundedDiscount?: Money;
  readonly pspFee?: Money;
}

export function buildSaleEntries(input: SaleEntriesInput): LedgerEntryInput[] {
  const entries: LedgerEntryInput[] = [
    {
      event: 'SALE_GROSS',
      amount: input.buyerPaidForGoods,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
    },
    {
      event: 'PLATFORM_COMMISSION',
      amount: input.commission,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
      commissionRuleId: input.commissionRuleId,
    },
    {
      event: 'SELLER_PAYABLE',
      amount: input.sellerPayable,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
      commissionRuleId: input.commissionRuleId,
    },
  ];
  if (input.sellerFundedDiscount && toBigInt(input.sellerFundedDiscount) > 0n) {
    entries.push({
      event: 'DISCOUNT_SELLER',
      amount: input.sellerFundedDiscount,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
    });
  }
  if (input.platformFundedDiscount && toBigInt(input.platformFundedDiscount) > 0n) {
    entries.push({
      event: 'DISCOUNT_PLATFORM',
      amount: input.platformFundedDiscount,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
    });
  }
  if (input.pspFee && toBigInt(input.pspFee) > 0n) {
    entries.push({
      event: 'PSP_FEE',
      amount: input.pspFee,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
    });
  }
  return entries;
}

export interface RefundEntriesInput {
  readonly orderId: string;
  readonly orderItemId: string;
  readonly sellerId: string;
  readonly refundId: string;
  readonly commissionRuleId: string;
  readonly refundGross: Money;
  readonly commissionReversal: Money;
  readonly sellerPayableReversal: Money;
}

export function buildRefundEntries(input: RefundEntriesInput): LedgerEntryInput[] {
  return [
    {
      event: 'REFUND_GROSS',
      amount: input.refundGross,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
      refundId: input.refundId,
    },
    {
      event: 'COMMISSION_REVERSAL',
      amount: input.commissionReversal,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
      refundId: input.refundId,
      commissionRuleId: input.commissionRuleId,
    },
    {
      event: 'SELLER_PAYABLE_REVERSAL',
      amount: input.sellerPayableReversal,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      sellerId: input.sellerId,
      refundId: input.refundId,
      commissionRuleId: input.commissionRuleId,
    },
  ];
}
