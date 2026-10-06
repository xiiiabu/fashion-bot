/**
 * Cart — spec ORD-001 and AI-008.
 *
 * ORD-001 One cart may hold items from several sellers and groups them by
 *         seller and delivery so the terms are legible before payment.
 * AI-008  "Add whole look" adds separate SKUs and re-validates size and stock
 *         for each, returning the exceptions with their reasons rather than
 *         silently dropping an item.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type CartItemView,
  type CartSellerGroup,
  type CartView,
  type Locale,
  add,
  compare,
  money,
  multiply,
  pickLocalized,
  sum,
  zero,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { nullableMoney, toMoney } from '../common/money.util';
import { CatalogService } from '../catalog/catalog.service';
import { InventoryService } from '../inventory/inventory.service';
import { DeliveryService } from '../fulfillment/delivery.service';

const MAX_LINES = 40;
const MAX_QUANTITY_PER_LINE = 10;

export interface AddToCartInput {
  readonly skuId: string;
  readonly quantity?: number;
  readonly addedFromAi?: boolean;
  readonly outfitSessionId?: string | null;
  readonly fitConfidence?: number | null;
}

export interface AddLookResult {
  readonly cart: CartView;
  readonly added: Array<{ skuId: string; cartItemId: string }>;
  /** AI-008: the shopper is told what could not be added and why. */
  readonly exceptions: Array<{
    skuId: string;
    reason: 'OUT_OF_STOCK' | 'NOT_PURCHASABLE' | 'LIMIT_REACHED' | 'ALREADY_IN_CART';
    message: string;
    available?: number;
  }>;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
    private readonly delivery: DeliveryService,
  ) {}

  async getOrCreateCart(userId: string): Promise<{ id: string }> {
    const existing = await this.prisma.cart.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) return existing;
    return this.prisma.cart.create({ data: { userId, isActive: true }, select: { id: true } });
  }

  async view(userId: string, locale: Locale): Promise<CartView> {
    const cart = await this.getOrCreateCart(userId);
    return this.buildView(cart.id, locale);
  }

  async addItem(userId: string, input: AddToCartInput, locale: Locale): Promise<CartView> {
    const cart = await this.getOrCreateCart(userId);
    const quantity = clampQuantity(input.quantity ?? 1);

    // BUY-005: a SKU with missing mandatory data cannot enter the cart at all.
    await this.catalog.assertPurchasable(input.skuId);

    const lines = await this.prisma.cartItem.count({ where: { cartId: cart.id } });
    const existing = await this.prisma.cartItem.findUnique({
      where: { cartId_skuId: { cartId: cart.id, skuId: input.skuId } },
    });
    if (!existing && lines >= MAX_LINES) {
      throw AppError.validation(`Cart is limited to ${MAX_LINES} lines`);
    }

    const targetQuantity = clampQuantity((existing?.quantity ?? 0) + quantity);
    const available = await this.inventory.available(input.skuId);
    if (available <= 0) {
      throw new AppError('OUT_OF_STOCK', { message: 'This size is out of stock', details: { skuId: input.skuId } });
    }
    // Clamp rather than reject: capping at what is available is kinder than
    // an error, and the cart view flags the reduction.
    const finalQuantity = Math.min(targetQuantity, available);

    const sku = await this.prisma.sku.findUniqueOrThrow({
      where: { id: input.skuId },
      select: { priceMinor: true },
    });

    await this.prisma.cartItem.upsert({
      where: { cartId_skuId: { cartId: cart.id, skuId: input.skuId } },
      create: {
        cartId: cart.id,
        skuId: input.skuId,
        quantity: finalQuantity,
        addedFromAi: input.addedFromAi ?? false,
        outfitSessionId: input.outfitSessionId ?? null,
        fitConfidence: input.fitConfidence ?? null,
        shownPriceMinor: sku.priceMinor,
      },
      update: {
        quantity: finalQuantity,
        addedFromAi: input.addedFromAi ? true : undefined,
        outfitSessionId: input.outfitSessionId ?? undefined,
        fitConfidence: input.fitConfidence ?? undefined,
        shownPriceMinor: sku.priceMinor,
      },
    });

    await this.touch(cart.id);
    return this.buildView(cart.id, locale);
  }

  /** AI-008: add every item of a look, re-validating each one. */
  async addLook(
    userId: string,
    items: Array<{ skuId: string; quantity?: number; fitConfidence?: number | null }>,
    options: { outfitSessionId?: string | null; locale: Locale },
  ): Promise<AddLookResult> {
    const cart = await this.getOrCreateCart(userId);
    const added: AddLookResult['added'] = [];
    const exceptions: AddLookResult['exceptions'] = [];

    for (const item of items) {
      try {
        await this.catalog.assertPurchasable(item.skuId);
      } catch {
        exceptions.push({
          skuId: item.skuId,
          reason: 'NOT_PURCHASABLE',
          message: 'This item is no longer available for sale',
        });
        continue;
      }

      const available = await this.inventory.available(item.skuId);
      if (available <= 0) {
        exceptions.push({
          skuId: item.skuId,
          reason: 'OUT_OF_STOCK',
          message: 'This size sold out',
          available: 0,
        });
        continue;
      }

      const lines = await this.prisma.cartItem.count({ where: { cartId: cart.id } });
      const existing = await this.prisma.cartItem.findUnique({
        where: { cartId_skuId: { cartId: cart.id, skuId: item.skuId } },
      });
      if (!existing && lines >= MAX_LINES) {
        exceptions.push({
          skuId: item.skuId,
          reason: 'LIMIT_REACHED',
          message: `Cart is limited to ${MAX_LINES} lines`,
        });
        continue;
      }

      const sku = await this.prisma.sku.findUniqueOrThrow({
        where: { id: item.skuId },
        select: { priceMinor: true },
      });
      const quantity = Math.min(clampQuantity(item.quantity ?? 1), available);

      const row = await this.prisma.cartItem.upsert({
        where: { cartId_skuId: { cartId: cart.id, skuId: item.skuId } },
        create: {
          cartId: cart.id,
          skuId: item.skuId,
          quantity,
          addedFromAi: true,
          outfitSessionId: options.outfitSessionId ?? null,
          fitConfidence: item.fitConfidence ?? null,
          shownPriceMinor: sku.priceMinor,
        },
        update: {
          quantity: Math.min(clampQuantity(existing ? existing.quantity + quantity : quantity), available),
          addedFromAi: true,
          outfitSessionId: options.outfitSessionId ?? undefined,
          fitConfidence: item.fitConfidence ?? undefined,
          shownPriceMinor: sku.priceMinor,
        },
      });
      added.push({ skuId: item.skuId, cartItemId: row.id });
    }

    if (options.outfitSessionId && added.length > 0) {
      await this.prisma.outfitSession
        .update({ where: { id: options.outfitSessionId }, data: { addedToCartAt: new Date() } })
        .catch(() => undefined);
    }

    await this.touch(cart.id);
    return { cart: await this.buildView(cart.id, options.locale), added, exceptions };
  }

  async updateQuantity(
    userId: string,
    cartItemId: string,
    quantity: number,
    locale: Locale,
  ): Promise<CartView> {
    const item = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, cart: { userId, isActive: true } },
      include: { cart: { select: { id: true } } },
    });
    if (!item) throw AppError.notFound('CartItem', cartItemId);

    if (quantity <= 0) {
      await this.prisma.cartItem.delete({ where: { id: cartItemId } });
    } else {
      const available = await this.inventory.available(item.skuId);
      if (available <= 0) {
        throw new AppError('OUT_OF_STOCK', { message: 'This size is out of stock' });
      }
      await this.prisma.cartItem.update({
        where: { id: cartItemId },
        data: { quantity: Math.min(clampQuantity(quantity), available) },
      });
    }

    await this.touch(item.cart.id);
    return this.buildView(item.cart.id, locale);
  }

  async removeItem(userId: string, cartItemId: string, locale: Locale): Promise<CartView> {
    const item = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, cart: { userId, isActive: true } },
      select: { id: true, cartId: true },
    });
    if (!item) throw AppError.notFound('CartItem', cartItemId);
    await this.prisma.cartItem.delete({ where: { id: item.id } });
    await this.touch(item.cartId);
    return this.buildView(item.cartId, locale);
  }

  async clear(userId: string, locale: Locale): Promise<CartView> {
    const cart = await this.getOrCreateCart(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await this.inventory.releaseForCart(cart.id, undefined, 'cart_cleared');
    await this.touch(cart.id);
    return this.buildView(cart.id, locale);
  }

  async applyPromotionCode(userId: string, code: string | null, locale: Locale): Promise<CartView> {
    const cart = await this.getOrCreateCart(userId);
    if (code) {
      const promotion = await this.prisma.promotion.findUnique({ where: { code } });
      const now = new Date();
      if (
        !promotion ||
        !promotion.isActive ||
        promotion.startsAt > now ||
        promotion.endsAt < now ||
        (promotion.usageLimit != null && promotion.usageCount >= promotion.usageLimit)
      ) {
        throw AppError.validation('This promo code is not valid', { code });
      }
    }
    await this.prisma.cart.update({ where: { id: cart.id }, data: { promotionCode: code } });
    return this.buildView(cart.id, locale);
  }

  /** Mark the cart consumed once its order is created. */
  async deactivate(cartId: string): Promise<void> {
    await this.prisma.cart.update({ where: { id: cartId }, data: { isActive: false } });
  }

  async countItems(userId: string): Promise<number> {
    const aggregate = await this.prisma.cartItem.aggregate({
      where: { cart: { userId, isActive: true } },
      _sum: { quantity: true },
    });
    return aggregate._sum.quantity ?? 0;
  }

  /**
   * The read model. Every price is re-read from the SKU, so a catalogue change
   * is visible immediately (ORD-002: the frontend is never the source).
   */
  async buildView(cartId: string, locale: Locale): Promise<CartView> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
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
                    seller: { select: { id: true, displayName: true, handlingDays: true } },
                    media: { orderBy: { sortOrder: 'asc' }, take: 1 },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!cart) throw AppError.notFound('Cart', cartId);

    const currency = cart.currency;
    const bySeller = new Map<string, { name: string; handlingDays: number; items: CartItemView[] }>();

    for (const item of cart.items) {
      const product = item.sku.product;
      const available = Math.max(
        0,
        (item.sku.inventory?.onHand ?? 0) -
          (item.sku.inventory?.reserved ?? 0) -
          (item.sku.inventory?.safetyStock ?? 0),
      );

      let issue: CartItemView['issue'] = 'NONE';
      if (product.lifecycle !== 'PUBLISHED' || !item.sku.isActive) issue = 'UNPUBLISHED';
      else if (available <= 0) issue = 'OUT_OF_STOCK';
      else if (available < item.quantity) issue = 'QUANTITY_REDUCED';
      else if (item.shownPriceMinor !== item.sku.priceMinor) issue = 'PRICE_CHANGED';

      const unitPrice = toMoney(item.sku.priceMinor, item.sku.currency);
      const view: CartItemView = {
        id: item.id,
        skuId: item.skuId,
        productId: product.id,
        title: pickLocalized({ ru: product.titleRu, uz: product.titleUz, en: product.titleEn }, locale),
        brandName: product.brand.name,
        sellerId: product.seller.id,
        sellerName: product.seller.displayName,
        sizeLabel: item.sku.sizeLabel,
        colorName: item.sku.colorName || product.colorName,
        quantity: item.quantity,
        unitPrice,
        lineTotal: multiply(unitPrice, item.quantity),
        compareAtUnitPrice: nullableMoney(item.sku.compareAtMinor, item.sku.currency),
        imageUrl: product.media[0]?.url ?? null,
        available,
        issue,
        addedFromAi: item.addedFromAi,
        fitConfidence: item.fitConfidence,
      };

      const group =
        bySeller.get(product.seller.id) ??
        { name: product.seller.displayName, handlingDays: product.seller.handlingDays, items: [] };
      group.items.push(view);
      bySeller.set(product.seller.id, group);
    }

    const groups: CartSellerGroup[] = [];
    for (const [sellerId, group] of bySeller.entries()) {
      const subtotal = sum(
        group.items.map((item) => item.lineTotal),
        currency as never,
      );
      const deliveryOptions = await this.delivery.optionsForSeller(sellerId, {
        locale,
        goodsTotalMinor: BigInt(subtotal.amount),
      });
      groups.push({
        sellerId,
        sellerName: group.name,
        items: group.items,
        subtotal,
        deliveryOptions,
        handlingDays: group.handlingDays,
      });
    }

    const subtotal = sum(
      groups.map((group) => group.subtotal),
      currency as never,
    );
    // The cart shows the cheapest delivery per seller as an estimate; the
    // binding figure comes from the checkout quote (ORD-002).
    const estimatedDelivery = groups.reduce(
      (acc, group) =>
        add(
          acc,
          group.deliveryOptions.length > 0
            ? group.deliveryOptions.reduce(
                (cheapest, option) => (compare(option.price, cheapest) < 0 ? option.price : cheapest),
                group.deliveryOptions[0]!.price,
              )
            : zero(currency as never),
        ),
      zero(currency as never),
    );

    return {
      id: cart.id,
      groups,
      itemCount: cart.items.reduce((acc, item) => acc + item.quantity, 0),
      subtotal,
      estimatedDelivery,
      estimatedTotal: add(subtotal, estimatedDelivery),
      currency,
      hasIssues: groups.some((group) => group.items.some((item) => item.issue !== 'NONE')),
      updatedAt: cart.updatedAt.toISOString(),
    };
  }

  private async touch(cartId: string): Promise<void> {
    await this.prisma.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });
  }
}

function clampQuantity(quantity: number): number {
  return Math.max(0, Math.min(MAX_QUANTITY_PER_LINE, Math.trunc(quantity)));
}

export { money, Prisma };
