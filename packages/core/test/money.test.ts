/**
 * Unit tests — spec §18.1: "Unit: Commission, rounding, state transitions,
 * promotions, fit rules, adapters."
 *
 * The money cases are taken straight from the spec so the numbers are the
 * spec's own, not ones chosen to make the code look right: §8.2's worked
 * example, Appendix A's four-seller order, and UAT-11 through UAT-14.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_COMMISSION_RULE,
  add,
  applyBps,
  computeItemCommission,
  computeOrderCommission,
  computeRefundReversal,
  formatMoney,
  fromMajor,
  money,
  prorate,
  splitByWeights,
  splitEvenly,
  subtract,
  sum,
  toBigInt,
  zero,
} from '../src/index.js';

/** Soum -> tiyin, the minor unit the whole system stores (CAT-005). */
const uzs = (major: number) => fromMajor(major, 'UZS');

describe('money primitives', () => {
  it('stores major units as integer minor units', () => {
    assert.equal(uzs(1_000_000).amount, '100000000');
    assert.equal(uzs(0).amount, '0');
    assert.equal(fromMajor('1234.56', 'UZS').amount, '123456');
  });

  it('refuses a float minor amount', () => {
    assert.throws(() => money(1.5 as unknown as number));
  });

  it('refuses mixed currencies', () => {
    assert.throws(() => add(money(100, 'UZS'), money(100, 'USD')));
  });

  it('adds and subtracts without precision loss at GMV scale', () => {
    // 2^31 tiyin is ~21.5M soum, so a realistic month of GMV overflows Int32.
    const big = uzs(9_000_000_000);
    assert.equal(subtract(add(big, big), big).amount, big.amount);
    assert.equal(toBigInt(add(big, big)), 1_800_000_000_000n);
  });

  it('rounds half up on applyBps, symmetrically for negatives', () => {
    // 5 tiyin at 10% = 0.5 -> 1
    assert.equal(applyBps(money(5), 1000).amount, '1');
    assert.equal(applyBps(money(-5), 1000).amount, '-1');
    assert.equal(applyBps(money(4), 1000).amount, '0');
  });

  it('splits evenly with the remainder distributed, summing back exactly', () => {
    const parts = splitEvenly(money(100), 3);
    assert.deepEqual(parts.map((part) => part.amount), ['34', '33', '33']);
    assert.equal(sum(parts).amount, '100');
  });

  it('splits by weights so the shares always sum back to the whole', () => {
    const shares = splitByWeights(money(1000), [1, 1, 1]);
    assert.equal(sum(shares).amount, '1000');
    const uneven = splitByWeights(money(777), [5, 3, 1]);
    assert.equal(sum(uneven).amount, '777');
  });

  it('formats UZS without decimals and with grouped thousands', () => {
    const formatted = formatMoney(uzs(1_650_000));
    assert.match(formatted, /1.650.000/u);
    assert.match(formatted, /so'm|so‘m/u);
  });
});

describe('commission — §8.2 and UAT-11', () => {
  it('charges 10% and leaves the remainder payable to the seller', () => {
    // The spec's own worked example: 1 000 000 -> 100 000 -> 900 000.
    const result = computeItemCommission({ unitPrice: uzs(1_000_000), quantity: 1 });
    assert.equal(result.commission.amount, uzs(100_000).amount);
    assert.equal(result.sellerPayableBeforeAdjustments.amount, uzs(900_000).amount);
    assert.equal(
      add(result.commission, result.sellerPayableBeforeAdjustments).amount,
      result.commissionBase.amount,
    );
  });

  it('excludes delivery from the base by default (PAY-014)', () => {
    const withDelivery = computeItemCommission({
      unitPrice: uzs(1_000_000),
      quantity: 1,
      deliveryAmount: uzs(35_000),
    });
    assert.equal(withDelivery.commission.amount, uzs(100_000).amount);
    assert.match(withDelivery.baseExplanation, /delivery excluded/);
  });

  it('includes delivery when the contract says so', () => {
    const included = computeItemCommission({
      unitPrice: uzs(1_000_000),
      quantity: 1,
      deliveryAmount: uzs(35_000),
      rule: { ...DEFAULT_COMMISSION_RULE, includesDelivery: true },
    });
    assert.equal(included.commission.amount, uzs(103_500).amount);
  });

  it('lets a seller-funded discount reduce the base (UAT-12)', () => {
    const discounted = computeItemCommission({
      unitPrice: uzs(1_000_000),
      quantity: 1,
      sellerFundedDiscount: uzs(200_000),
    });
    assert.equal(discounted.commissionBase.amount, uzs(800_000).amount);
    assert.equal(discounted.commission.amount, uzs(80_000).amount);
    assert.equal(discounted.buyerPaidForGoods.amount, uzs(800_000).amount);
  });

  it('keeps a platform-funded discount out of the base (UAT-13)', () => {
    const subsidised = computeItemCommission({
      unitPrice: uzs(1_000_000),
      quantity: 1,
      platformFundedDiscount: uzs(200_000),
    });
    // The buyer pays less, but the seller still sold a 1 000 000 item, so the
    // commission base is unchanged — the platform funded the gap.
    assert.equal(subsidised.commissionBase.amount, uzs(1_000_000).amount);
    assert.equal(subsidised.commission.amount, uzs(100_000).amount);
    assert.equal(subsidised.buyerPaidForGoods.amount, uzs(800_000).amount);
  });

  it('reproduces Appendix A exactly', () => {
    const breakdown = computeOrderCommission([
      { orderItemId: 'a', sellerId: 'A', unitPrice: uzs(800_000), quantity: 1 },
      { orderItemId: 'b', sellerId: 'B', unitPrice: uzs(400_000), quantity: 1 },
      { orderItemId: 'c', sellerId: 'C', unitPrice: uzs(1_200_000), quantity: 1 },
      { orderItemId: 'd', sellerId: 'D', unitPrice: uzs(3_000_000), quantity: 1 },
    ]);

    assert.equal(breakdown.totalGross.amount, uzs(5_400_000).amount);
    assert.equal(breakdown.totalCommission.amount, uzs(540_000).amount);
    assert.equal(breakdown.totalSellerPayable.amount, uzs(4_860_000).amount);
    assert.equal(breakdown.effectiveTakeRateBps, 1000);

    const perSeller = new Map(breakdown.bySeller.map((entry) => [entry.sellerId, entry]));
    assert.equal(perSeller.get('A')!.commission.amount, uzs(80_000).amount);
    assert.equal(perSeller.get('B')!.commission.amount, uzs(40_000).amount);
    assert.equal(perSeller.get('C')!.commission.amount, uzs(120_000).amount);
    assert.equal(perSeller.get('D')!.commission.amount, uzs(300_000).amount);
  });

  it('keeps the sum of item commissions equal to the order total (PAY-006)', () => {
    // Prices chosen so each 10% lands on a half-tiyin boundary.
    const lines = Array.from({ length: 7 }, (_, index) => ({
      orderItemId: `item-${index}`,
      sellerId: 'S',
      unitPrice: money(4_999 + index, 'UZS'),
      quantity: 3,
    }));
    const breakdown = computeOrderCommission(lines);
    const summed = sum(breakdown.items.map((item) => item.commission));
    assert.equal(summed.amount, breakdown.totalCommission.amount);
  });

  it('never claims more commission than the line is worth', () => {
    const capped = computeItemCommission({
      unitPrice: uzs(10_000),
      quantity: 1,
      rule: { ...DEFAULT_COMMISSION_RULE, minFeeMinor: uzs(50_000).amount },
    });
    assert.equal(capped.commission.amount, capped.commissionBase.amount);
    assert.equal(capped.sellerPayableBeforeAdjustments.amount, '0');
  });

  it('rejects a non-positive quantity', () => {
    assert.throws(() => computeItemCommission({ unitPrice: uzs(1000), quantity: 0 }));
  });
});

describe('refund reversal — PAY-009 and UAT-14', () => {
  it('reverses 40% of commission for a 40% refund, as the spec states', () => {
    const original = computeItemCommission({ unitPrice: uzs(1_000_000), quantity: 1 });
    const reversal = computeRefundReversal({
      original,
      refundQuantity: 1,
      originalQuantity: 1,
      refundGrossOverride: uzs(400_000),
    });
    assert.equal(reversal.refundGross.amount, uzs(400_000).amount);
    assert.equal(reversal.commissionReversal.amount, uzs(40_000).amount);
    assert.equal(reversal.sellerPayableReversal.amount, uzs(360_000).amount);
    assert.equal(reversal.proportionBps, 4000);
  });

  it('reverses exactly one unit of a multi-unit line', () => {
    const original = computeItemCommission({ unitPrice: uzs(520_000), quantity: 3 });
    const reversal = computeRefundReversal({ original, refundQuantity: 1, originalQuantity: 3 });
    assert.equal(reversal.refundGross.amount, uzs(520_000).amount);
    assert.equal(reversal.commissionReversal.amount, uzs(52_000).amount);
  });

  it('reverses the full amount for a full refund, leaving nothing behind', () => {
    const original = computeItemCommission({ unitPrice: uzs(1_480_000), quantity: 2 });
    const reversal = computeRefundReversal({ original, refundQuantity: 2, originalQuantity: 2 });
    assert.equal(reversal.refundGross.amount, original.commissionBase.amount);
    assert.equal(reversal.commissionReversal.amount, original.commission.amount);
    assert.equal(
      reversal.sellerPayableReversal.amount,
      original.sellerPayableBeforeAdjustments.amount,
    );
  });

  it('reverses the discounted rate, not the list rate', () => {
    const original = computeItemCommission({
      unitPrice: uzs(1_000_000),
      quantity: 1,
      sellerFundedDiscount: uzs(200_000),
    });
    const reversal = computeRefundReversal({ original, refundQuantity: 1, originalQuantity: 1 });
    // The buyer paid 800 000 and the platform took 80 000, so that is what comes back.
    assert.equal(reversal.refundGross.amount, uzs(800_000).amount);
    assert.equal(reversal.commissionReversal.amount, uzs(80_000).amount);
  });

  it('is exact across repeated partial refunds of one line', () => {
    const original = computeItemCommission({ unitPrice: uzs(333_333), quantity: 3 });
    const first = computeRefundReversal({ original, refundQuantity: 1, originalQuantity: 3 });
    const second = computeRefundReversal({ original, refundQuantity: 2, originalQuantity: 3 });
    // Refunding 1 then 2 must total the same as refunding all 3 at once.
    const whole = computeRefundReversal({ original, refundQuantity: 3, originalQuantity: 3 });
    assert.equal(add(first.refundGross, second.refundGross).amount, whole.refundGross.amount);
    assert.equal(
      add(first.commissionReversal, second.commissionReversal).amount,
      whole.commissionReversal.amount,
    );
  });
});

describe('proration', () => {
  it('prorates a delivery charge across lines without losing a tiyin', () => {
    const delivery = uzs(35_000);
    const weights = [uzs(1_650_000), uzs(520_000), uzs(890_000)].map((value) => toBigInt(value));
    const shares = splitByWeights(delivery, weights);
    assert.equal(sum(shares).amount, delivery.amount);
  });

  it('prorates zero to zero', () => {
    assert.equal(prorate(zero(), 1, 3).amount, '0');
  });
});
