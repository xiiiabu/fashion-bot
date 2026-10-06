/**
 * Checkout — spec §7.
 *
 * ORD-002 The backend recomputes everything: price, discounts, delivery,
 *         fiscal data, stock and reservation expiry. The frontend is not the
 *         source of the amount, and a stale client cannot underpay.
 * ORD-003 Confirming creates one Master Order plus one SubOrder per seller.
 * ORD-004 Each OrderItem stores an immutable snapshot — product, seller,
 *         price, size, commission rule and terms.
 * ORD-005 Reservations carry a TTL and are released on timeout or failure.
 * ORD-006 Order creation is protected by an idempotency key.
 * ORD-007 The review screen gets the full confirmed total before payment.
 * ORD-008 Promo codes record their funding party separately.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type Locale as PrismaLocale } from '@prisma/client';
import {
  type CheckoutQuote,
  type Locale,
  type Money,
  type ReturnPolicySnapshot,
  add,
  applyBps,
  compare,
  computeItemCommission,
  money,
  multiply,
  pickLocalized,
  prorate,
  splitByWeights,
  subtract,
  sum,
  toBigInt,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { toMinor, toMoney } from '../common/money.util';
import { CartService } from '../cart/cart.service';
import { CatalogService } from '../catalog/catalog.service';
import { InventoryService } from '../inventory/inventory.service';
import { DeliveryService } from '../fulfillment/delivery.service';
import { CommissionRuleService } from '../finance/commission-rule.service';
import { ProfileService } from '../identity/profile.service';
import { OrdersService } from '../orders/orders.service';

interface QuoteLineDraft {
  cartItemId: string;
  skuId: string;
  productId: string;
  categoryId: string;
  sellerId: string;
  sellerName: string;
  brandName: string;
  title: string;
  categorySlug: string;
  sizeLabel: string;
  colorName: string;
  imageUrl: string | null;
  quantity: number;
  unitPrice: Money;
  compareAtPrice: Money | null;
  lineTotal: Money;
  sellerFundedDiscount: Money;
  platformFundedDiscount: Money;
  addedFromAi: boolean;
  fitConfidence: number | null;
  outfitSessionId: string | null;
}

export interface QuoteRequest {
  readonly userId: string;
  readonly addressId?: string | null;
  /** Per-seller delivery choice: { sellerId: methodCode }. */
  readonly deliveryChoices?: Record<string, string>;
  readonly locale: Locale;
  readonly correlationId?: string;
}

export interface ConfirmRequest extends QuoteRequest {
  readonly quoteId: string;
  readonly customerNote?: string | null;
  readonly idempotencyKey: string;
}

@Injectable()
export class CheckoutService {
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
    private readonly delivery: DeliveryService,
    private readonly commissionRules: CommissionRuleService,
    private readonly profile: ProfileService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * ORD-002: build (and hold stock for) an authoritative quote.
   * Called on entering checkout and again whenever the address or a delivery
   * method changes.
   */
  async createQuote(request: QuoteRequest): Promise<CheckoutQuote> {
    const cart = await this.prisma.cart.findFirst({
      where: { userId: request.userId, isActive: true },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            sku: {
              include: {
                inventory: true,
                product: {
                  include: {
                    brand: { select: { name: true } },
                    category: { select: { id: true, slug: true } },
                    seller: {
                      select: {
                        id: true,
                        displayName: true,
                        legalName: true,
                        handlingDays: true,
                        onboardingStatus: true,
                        suspendedAt: true,
                      },
                    },
                    media: { orderBy: { sortOrder: 'asc' }, take: 1 },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!cart || cart.items.length === 0) {
      throw AppError.validation('Cart is empty');
    }

    const warnings: CheckoutQuote['warnings'] = [];
    const currency = cart.currency as Money['currency'];
    const lines: QuoteLineDraft[] = [];

    // ── 1. Re-validate every line against the live catalogue and stock.
    for (const item of cart.items) {
      const product = item.sku.product;
      const available = Math.max(
        0,
        (item.sku.inventory?.onHand ?? 0) -
          (item.sku.inventory?.reserved ?? 0) -
          (item.sku.inventory?.safetyStock ?? 0),
      );

      if (
        product.lifecycle !== 'PUBLISHED' ||
        !item.sku.isActive ||
        product.seller.onboardingStatus !== 'ACTIVE' ||
        product.seller.suspendedAt
      ) {
        warnings.push({
          code: 'ITEM_UNAVAILABLE',
          message: 'An item was removed because it is no longer on sale',
          skuId: item.skuId,
        });
        continue;
      }
      if (available <= 0) {
        warnings.push({ code: 'OUT_OF_STOCK', message: 'An item sold out', skuId: item.skuId });
        continue;
      }

      const quantity = Math.min(item.quantity, available);
      if (quantity < item.quantity) {
        warnings.push({
          code: 'QUANTITY_REDUCED',
          message: `Only ${quantity} left; the quantity was reduced`,
          skuId: item.skuId,
        });
      }

      const unitPrice = toMoney(item.sku.priceMinor, item.sku.currency);
      if (item.shownPriceMinor !== item.sku.priceMinor) {
        warnings.push({
          code: 'PRICE_CHANGED',
          message: 'The price of an item changed since you added it',
          skuId: item.skuId,
        });
      }

      lines.push({
        cartItemId: item.id,
        skuId: item.skuId,
        productId: product.id,
        categoryId: product.category.id,
        sellerId: product.seller.id,
        sellerName: product.seller.displayName,
        brandName: product.brand.name,
        title: pickLocalized(
          { ru: product.titleRu, uz: product.titleUz, en: product.titleEn },
          request.locale,
        ),
        categorySlug: product.category.slug,
        sizeLabel: item.sku.sizeLabel,
        colorName: item.sku.colorName || product.colorName,
        imageUrl: product.media[0]?.url ?? null,
        quantity,
        unitPrice,
        compareAtPrice: item.sku.compareAtMinor
          ? toMoney(item.sku.compareAtMinor, item.sku.currency)
          : null,
        lineTotal: multiply(unitPrice, quantity),
        sellerFundedDiscount: zero(currency),
        platformFundedDiscount: zero(currency),
        addedFromAi: item.addedFromAi,
        fitConfidence: item.fitConfidence,
        outfitSessionId: item.outfitSessionId,
      });
    }

    if (lines.length === 0) {
      throw new AppError('OUT_OF_STOCK', {
        message: 'Nothing in the cart can be bought right now',
        details: { warnings },
      });
    }

    // ── 2. Promotions (ORD-008): the funding party is tracked per line.
    await this.applyPromotions(cart.promotionCode, lines, currency, warnings);

    // ── 3. Delivery per seller (FUL-001/FUL-002).
    const address = request.addressId
      ? await this.prisma.address.findFirst({
          where: { id: request.addressId, userId: request.userId, deletedAt: null },
        })
      : null;
    if (request.addressId && !address) throw AppError.notFound('Address', request.addressId);

    const zoneId = await this.delivery.resolveZoneId(address);
    const sellerIds = [...new Set(lines.map((line) => line.sellerId))];
    const groups: CheckoutQuote['groups'] = [];
    let deliveryTotal = zero(currency);

    for (const sellerId of sellerIds) {
      const sellerLines = lines.filter((line) => line.sellerId === sellerId);
      const goodsTotal = sum(
        sellerLines.map((line) =>
          subtract(subtract(line.lineTotal, line.sellerFundedDiscount), line.platformFundedDiscount),
        ),
        currency,
      );

      const options = await this.delivery.optionsForSeller(sellerId, {
        locale: request.locale,
        zoneId,
        goodsTotalMinor: toMinor(goodsTotal),
      });

      if (options.length === 0) {
        // FUL-001: checkout shows only what is available. If a seller cannot
        // deliver to this address at all, say so rather than guessing a price.
        warnings.push({
          code: 'NO_DELIVERY_OPTION',
          message: `${sellerLines[0]!.sellerName} does not deliver to this address`,
        });
        continue;
      }

      const requested = request.deliveryChoices?.[sellerId];
      const chosen =
        options.find((option) => option.methodCode === requested) ??
        options.reduce(
          (cheapest, option) => (compare(option.price, cheapest.price) < 0 ? option : cheapest),
          options[0]!,
        );

      groups.push({
        sellerId,
        sellerName: sellerLines[0]!.sellerName,
        goodsTotal,
        deliveryMethodCode: chosen.methodCode,
        deliveryName: chosen.name,
        deliveryPrice: chosen.price,
        minDays: chosen.minDays,
        maxDays: chosen.maxDays,
      });
      deliveryTotal = add(deliveryTotal, chosen.price);
    }

    if (groups.length === 0) {
      throw AppError.validation('No delivery option is available for this address', { warnings });
    }

    // Drop lines whose seller could not be served.
    const servedSellers = new Set(groups.map((group) => group.sellerId));
    const servedLines = lines.filter((line) => servedSellers.has(line.sellerId));

    const goodsTotal = sum(servedLines.map((line) => line.lineTotal), currency);
    const discountTotal = sum(
      servedLines.map((line) => add(line.sellerFundedDiscount, line.platformFundedDiscount)),
      currency,
    );
    const grandTotal = add(subtract(goodsTotal, discountTotal), deliveryTotal);

    // ── 4. Hold the stock (CAT-008) and persist the quote.
    const reservation = await this.inventory.reserveForCheckout(
      cart.id,
      servedLines.map((line) => ({ skuId: line.skuId, quantity: line.quantity })),
      { correlationId: request.correlationId },
    );

    const expiresAt = new Date(Date.now() + this.config.QUOTE_TTL_SECONDS * 1000);
    const payload = {
      lines: servedLines.map((line) => ({
        ...line,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        sellerFundedDiscount: line.sellerFundedDiscount,
        platformFundedDiscount: line.platformFundedDiscount,
        compareAtPrice: line.compareAtPrice,
      })),
      groups,
      addressId: address?.id ?? null,
      addressSnapshot: address
        ? {
            recipientName: address.recipientName,
            phone: address.phone,
            city: address.city,
            district: address.district,
            street: address.street,
            building: address.building,
            apartment: address.apartment,
            entrance: address.entrance,
            floor: address.floor,
            landmark: address.landmark,
            postalCode: address.postalCode,
          }
        : null,
      warnings,
      locale: request.locale,
    };

    const quote = await this.prisma.quote.create({
      data: {
        cartId: cart.id,
        userId: request.userId,
        addressId: address?.id ?? null,
        payload: JSON.parse(
          JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
        ) as Prisma.InputJsonValue,
        goodsTotalMinor: toMinor(goodsTotal),
        discountTotalMinor: toMinor(discountTotal),
        deliveryTotalMinor: toMinor(deliveryTotal),
        grandTotalMinor: toMinor(grandTotal),
        currency,
        expiresAt,
        reservationExpiresAt: reservation.expiresAt,
      },
    });

    // §15.1: the fiscal document must name one seller of record. With several
    // sellers in one order, the receipt is issued per suborder.
    const fiscal =
      groups.length === 1
        ? { receiptRequired: true, sellerOfRecord: groups[0]!.sellerName }
        : { receiptRequired: true, sellerOfRecord: 'per_suborder' };

    return {
      id: quote.id,
      cartId: cart.id,
      lines: servedLines.map((line) => ({
        cartItemId: line.cartItemId,
        skuId: line.skuId,
        title: line.title,
        sellerId: line.sellerId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        sellerFundedDiscount: line.sellerFundedDiscount,
        platformFundedDiscount: line.platformFundedDiscount,
      })),
      groups,
      goodsTotal,
      discountTotal,
      deliveryTotal,
      grandTotal,
      currency,
      reservationExpiresAt: reservation.expiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      addressId: address?.id ?? null,
      warnings,
      fiscal,
    };
  }

  /**
   * ORD-003/ORD-004/ORD-007: turn a live quote into a Master Order with one
   * SubOrder per seller and immutable OrderItem snapshots carrying the
   * commission rule that applied at this moment (PAY-006, PAY-007).
   */
  async confirm(request: ConfirmRequest): Promise<{ orderId: string; orderNumber: string; grandTotal: Money }> {
    // §15.1: proof of acceptance must exist before an order is created.
    await this.profile.assertRequiredConsents(request.userId);

    const quote = await this.prisma.quote.findFirst({
      where: { id: request.quoteId, userId: request.userId },
      include: { cart: true },
    });
    if (!quote) throw AppError.notFound('Quote', request.quoteId);
    if (quote.consumedAt) {
      throw AppError.conflict('CONFLICT', 'This quote was already used');
    }
    if (quote.expiresAt < new Date()) {
      throw new AppError('QUOTE_EXPIRED', { message: 'The quote expired — refresh the total' });
    }
    if (quote.reservationExpiresAt < new Date()) {
      throw new AppError('RESERVATION_EXPIRED', {
        message: 'The stock hold expired — refresh your cart',
      });
    }

    const payload = quote.payload as unknown as {
      lines: Array<
        Omit<QuoteLineDraft, 'unitPrice' | 'lineTotal' | 'sellerFundedDiscount' | 'platformFundedDiscount' | 'compareAtPrice'> & {
          unitPrice: Money;
          lineTotal: Money;
          sellerFundedDiscount: Money;
          platformFundedDiscount: Money;
          compareAtPrice: Money | null;
        }
      >;
      groups: CheckoutQuote['groups'];
      addressId: string | null;
      addressSnapshot: Record<string, unknown> | null;
      locale: Locale;
    };

    const currency = quote.currency as Money['currency'];
    const reservations = await this.prisma.reservation.findMany({
      where: { cartId: quote.cartId, status: 'HELD' },
    });

    // The hold must still cover every line, or the amount we are about to
    // charge is not backed by stock.
    const heldBySku = new Map<string, number>();
    for (const reservation of reservations) {
      heldBySku.set(reservation.skuId, (heldBySku.get(reservation.skuId) ?? 0) + reservation.quantity);
    }
    for (const line of payload.lines) {
      if ((heldBySku.get(line.skuId) ?? 0) < line.quantity) {
        throw new AppError('RESERVATION_EXPIRED', {
          message: 'The stock hold no longer covers your cart — refresh the total',
          details: { skuId: line.skuId },
        });
      }
    }

    // Resolve the commission rule per (seller, category) once (PAY-007).
    const ruleMap = await this.commissionRules.resolveMany(
      payload.lines.map((line) => ({ sellerId: line.sellerId, categoryId: line.categoryId })),
    );

    const returnPolicy: ReturnPolicySnapshot = await this.delivery.policySnapshotForOrder(
      payload.lines.map((line) => line.productId),
      payload.locale,
    );

    const orderNumber = await this.orders.nextOrderNumber();

    const result = await this.prisma.$transaction(
      async (tx) => {
        const order = await tx.order.create({
          data: {
            number: orderNumber,
            userId: request.userId,
            cartId: quote.cartId,
            quoteId: quote.id,
            addressId: payload.addressId,
            status: 'AWAITING_PAYMENT',
            addressSnapshot: (payload.addressSnapshot ?? undefined) as Prisma.InputJsonValue,
            returnPolicySnapshot: returnPolicy as unknown as Prisma.InputJsonValue,
            goodsTotalMinor: quote.goodsTotalMinor,
            discountTotalMinor: quote.discountTotalMinor,
            deliveryTotalMinor: quote.deliveryTotalMinor,
            grandTotalMinor: quote.grandTotalMinor,
            currency,
            locale: payload.locale as PrismaLocale,
            idempotencyKey: request.idempotencyKey,
            correlationId: request.correlationId ?? null,
            customerNote: request.customerNote ?? null,
            placedAt: new Date(),
            aiAttributed: payload.lines.some((line) => line.addedFromAi),
            outfitSessionId: payload.lines.find((line) => line.outfitSessionId)?.outfitSessionId ?? null,
          },
        });

        let commissionTotal = zero(currency);

        for (const group of payload.groups) {
          const groupLines = payload.lines.filter((line) => line.sellerId === group.sellerId);
          if (groupLines.length === 0) continue;

          const subOrderNumber = `${orderNumber}-${(payload.groups.indexOf(group) + 1)
            .toString()
            .padStart(2, '0')}`;

          const seller = await tx.seller.findUniqueOrThrow({
            where: { id: group.sellerId },
            select: { handlingDays: true, displayName: true },
          });

          // FUL-004: the seller's SLA clock starts now.
          const confirmDueAt = new Date(Date.now() + Math.max(1, seller.handlingDays) * 86_400_000);

          const subOrder = await tx.subOrder.create({
            data: {
              number: subOrderNumber,
              orderId: order.id,
              sellerId: group.sellerId,
              status: 'PENDING_CONFIRMATION',
              goodsTotalMinor: toMinor(group.goodsTotal),
              deliveryTotalMinor: toMinor(group.deliveryPrice),
              currency,
              deliveryMethodCode: group.deliveryMethodCode,
              deliveryMethodName: group.deliveryName,
              estimatedMinDays: group.minDays,
              estimatedMaxDays: group.maxDays,
              confirmDueAt,
            },
          });

          // PAY-014: delivery is allocated to lines for reporting, but stays
          // out of the commission base unless the rule includes it.
          const deliveryShares = splitByWeights(
            group.deliveryPrice,
            groupLines.map((line) => toBigInt(line.lineTotal)),
          );

          let subOrderCommission = zero(currency);
          let subOrderPayable = zero(currency);
          let subOrderDiscount = zero(currency);

          for (const [index, line] of groupLines.entries()) {
            const resolved = ruleMap.get(CommissionRuleService.key(line.sellerId, line.categoryId))!;
            const commission = computeItemCommission({
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              sellerFundedDiscount: line.sellerFundedDiscount,
              platformFundedDiscount: line.platformFundedDiscount,
              deliveryAmount: deliveryShares[index] ?? zero(currency),
              rule: resolved.snapshot,
            });

            const returnWindowDays = returnPolicy.windowDays;

            await tx.orderItem.create({
              data: {
                orderId: order.id,
                subOrderId: subOrder.id,
                sellerId: line.sellerId,
                skuId: line.skuId,
                // ORD-004: snapshot, never re-read from the catalogue later.
                productId: line.productId,
                productTitle: line.title,
                brandName: line.brandName,
                sellerName: line.sellerName,
                sizeLabel: line.sizeLabel,
                colorName: line.colorName,
                imageUrl: line.imageUrl,
                categorySlug: line.categorySlug,
                quantity: line.quantity,
                unitPriceMinor: toMinor(line.unitPrice),
                compareAtMinor: line.compareAtPrice ? toMinor(line.compareAtPrice) : null,
                lineTotalMinor: toMinor(line.lineTotal),
                sellerDiscountMinor: toMinor(line.sellerFundedDiscount),
                platformDiscountMinor: toMinor(line.platformFundedDiscount),
                deliveryAllocatedMinor: toMinor(deliveryShares[index] ?? zero(currency)),
                currency,
                commissionRuleId: resolved.ruleId.startsWith('config-') ? null : resolved.ruleId,
                commissionRuleSnapshot: resolved.snapshot as unknown as Prisma.InputJsonValue,
                commissionBaseMinor: toMinor(commission.commissionBase),
                commissionMinor: toMinor(commission.commission),
                sellerPayableMinor: toMinor(commission.sellerPayableBeforeAdjustments),
                returnableUntil:
                  returnWindowDays > 0
                    ? new Date(Date.now() + returnWindowDays * 86_400_000)
                    : null,
                addedFromAi: line.addedFromAi,
                fitConfidence: line.fitConfidence,
              },
            });

            subOrderCommission = add(subOrderCommission, commission.commission);
            subOrderPayable = add(subOrderPayable, commission.sellerPayableBeforeAdjustments);
            subOrderDiscount = add(
              subOrderDiscount,
              add(line.sellerFundedDiscount, line.platformFundedDiscount),
            );
          }

          await tx.subOrder.update({
            where: { id: subOrder.id },
            data: {
              commissionTotalMinor: toMinor(subOrderCommission),
              payableTotalMinor: toMinor(subOrderPayable),
              discountTotalMinor: toMinor(subOrderDiscount),
            },
          });

          commissionTotal = add(commissionTotal, subOrderCommission);
        }

        await tx.order.update({
          where: { id: order.id },
          data: { commissionTotalMinor: toMinor(commissionTotal) },
        });

        // ORD-011: the first transition is recorded like every other one.
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            machine: 'order',
            fromStatus: null,
            toStatus: 'AWAITING_PAYMENT',
            actorType: 'USER',
            actorId: request.userId,
            note: 'Order created from quote',
            correlationId: request.correlationId ?? null,
          },
        });

        // The hold now belongs to the order, not the cart (ORD-005).
        await tx.reservation.updateMany({
          where: { cartId: quote.cartId, status: 'HELD' },
          data: { orderId: order.id },
        });
        await tx.quote.update({ where: { id: quote.id }, data: { consumedAt: new Date() } });
        await tx.cart.update({ where: { id: quote.cartId }, data: { isActive: false } });

        return { orderId: order.id, orderNumber: order.number, grandTotalMinor: order.grandTotalMinor };
      },
      { timeout: 20_000 },
    );

    logger.info(
      { orderId: result.orderId, orderNumber: result.orderNumber, sellers: payload.groups.length },
      'order created',
    );

    return {
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      grandTotal: money(result.grandTotalMinor, currency),
    };
  }

  /**
   * ORD-008: apply a promo code and record who funds it. The discount is
   * distributed across eligible lines by value so each OrderItem carries its
   * own share — that is what makes a partial refund reversible (PAY-009).
   */
  private async applyPromotions(
    code: string | null,
    lines: QuoteLineDraft[],
    currency: Money['currency'],
    warnings: CheckoutQuote['warnings'],
  ): Promise<void> {
    // Automatic SKU-level promotions first.
    const skuIds = lines.map((line) => line.skuId);
    const now = new Date();
    const automatic = await this.prisma.promotionSku.findMany({
      where: {
        skuId: { in: skuIds },
        promotion: {
          isActive: true,
          requiresCode: false,
          startsAt: { lte: now },
          endsAt: { gte: now },
        },
      },
      include: { promotion: true },
    });

    for (const link of automatic) {
      const line = lines.find((candidate) => candidate.skuId === link.skuId);
      if (!line) continue;
      const amount = this.discountAmount(link.promotion, line.lineTotal, currency);
      this.assignDiscount(line, amount, link.promotion.funding, link.promotion.sellerSharePercent, currency);
    }

    if (!code) return;

    const promotion = await this.prisma.promotion.findUnique({
      where: { code },
      include: { skus: { select: { skuId: true } } },
    });
    if (
      !promotion ||
      !promotion.isActive ||
      promotion.startsAt > now ||
      promotion.endsAt < now ||
      (promotion.usageLimit != null && promotion.usageCount >= promotion.usageLimit)
    ) {
      warnings.push({ code: 'PROMO_INVALID', message: 'The promo code is not valid' });
      return;
    }

    const eligible =
      promotion.skus.length > 0
        ? lines.filter((line) => promotion.skus.some((link) => link.skuId === line.skuId))
        : lines;
    if (eligible.length === 0) {
      warnings.push({ code: 'PROMO_NOT_APPLICABLE', message: 'The promo code does not apply to these items' });
      return;
    }

    const eligibleTotal = sum(eligible.map((line) => line.lineTotal), currency);
    if (promotion.minOrderMinor != null && toBigInt(eligibleTotal) < promotion.minOrderMinor) {
      warnings.push({
        code: 'PROMO_MIN_ORDER',
        message: 'The order total is below the minimum for this promo code',
      });
      return;
    }

    let total = this.discountAmount(promotion, eligibleTotal, currency);
    if (promotion.maxDiscountMinor != null && toBigInt(total) > promotion.maxDiscountMinor) {
      total = money(promotion.maxDiscountMinor, currency);
    }

    // Distribute by line value so the parts sum exactly back to the discount.
    const shares = splitByWeights(
      total,
      eligible.map((line) => toBigInt(line.lineTotal)),
    );
    for (const [index, line] of eligible.entries()) {
      this.assignDiscount(
        line,
        shares[index] ?? zero(currency),
        promotion.funding,
        promotion.sellerSharePercent,
        currency,
      );
    }
  }

  private discountAmount(
    promotion: { kind: string; valueBps: number | null; valueMinor: bigint | null },
    base: Money,
    currency: Money['currency'],
  ): Money {
    if (promotion.kind === 'PERCENT' && promotion.valueBps != null) {
      return applyBps(base, promotion.valueBps);
    }
    if (promotion.valueMinor != null) {
      const fixed = money(promotion.valueMinor, currency);
      return compare(fixed, base) > 0 ? base : fixed;
    }
    return zero(currency);
  }

  /** PAY-015 / ORD-008: the funding split is recorded, never averaged away. */
  private assignDiscount(
    line: QuoteLineDraft,
    amount: Money,
    funding: string,
    sellerSharePercent: number,
    currency: Money['currency'],
  ): void {
    if (toBigInt(amount) <= 0n) return;
    if (funding === 'SELLER') {
      line.sellerFundedDiscount = add(line.sellerFundedDiscount, amount);
      return;
    }
    if (funding === 'PLATFORM') {
      line.platformFundedDiscount = add(line.platformFundedDiscount, amount);
      return;
    }
    const sellerPart = prorate(amount, sellerSharePercent, 100);
    line.sellerFundedDiscount = add(line.sellerFundedDiscount, sellerPart);
    line.platformFundedDiscount = add(line.platformFundedDiscount, subtract(amount, sellerPart));
    void currency;
  }

  /** The review screen re-reads the stored quote without re-reserving. */
  async getQuote(userId: string, quoteId: string): Promise<CheckoutQuote> {
    const quote = await this.prisma.quote.findFirst({ where: { id: quoteId, userId } });
    if (!quote) throw AppError.notFound('Quote', quoteId);

    const payload = quote.payload as unknown as {
      lines: Array<{
        cartItemId: string;
        skuId: string;
        title: string;
        sellerId: string;
        quantity: number;
        unitPrice: Money;
        lineTotal: Money;
        sellerFundedDiscount: Money;
        platformFundedDiscount: Money;
      }>;
      groups: CheckoutQuote['groups'];
      addressId: string | null;
      warnings: CheckoutQuote['warnings'];
    };

    return {
      id: quote.id,
      cartId: quote.cartId,
      lines: payload.lines,
      groups: payload.groups,
      goodsTotal: toMoney(quote.goodsTotalMinor, quote.currency),
      discountTotal: toMoney(quote.discountTotalMinor, quote.currency),
      deliveryTotal: toMoney(quote.deliveryTotalMinor, quote.currency),
      grandTotal: toMoney(quote.grandTotalMinor, quote.currency),
      currency: quote.currency,
      reservationExpiresAt: quote.reservationExpiresAt.toISOString(),
      expiresAt: quote.expiresAt.toISOString(),
      addressId: payload.addressId,
      warnings: payload.warnings ?? [],
      fiscal:
        payload.groups.length === 1
          ? { receiptRequired: true, sellerOfRecord: payload.groups[0]!.sellerName }
          : { receiptRequired: true, sellerOfRecord: 'per_suborder' },
    };
  }
}
