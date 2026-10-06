/**
 * Cart and checkout endpoints — API groups "Cart/checkout" and "Orders" (§14.2).
 */

import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Locale } from '@fashion/core';
import { CartService } from './cart.service';
import { CheckoutService } from '../checkout/checkout.service';
import {
  CorrelationId,
  CurrentUserId,
  IdempotencyKey,
  RateLimit,
  RequestLocale,
  zodBody,
} from '../common/http';
import { IdempotencyService } from '../common/idempotency.service';

const addItemSchema = z.object({
  skuId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10).optional(),
  addedFromAi: z.boolean().optional(),
  outfitSessionId: z.string().uuid().nullable().optional(),
  fitConfidence: z.number().min(0).max(1).nullable().optional(),
});

const addLookSchema = z.object({
  items: z
    .array(
      z.object({
        skuId: z.string().uuid(),
        quantity: z.number().int().min(1).max(10).optional(),
        fitConfidence: z.number().min(0).max(1).nullable().optional(),
      }),
    )
    .min(1)
    .max(12),
  outfitSessionId: z.string().uuid().nullable().optional(),
});

const quantitySchema = z.object({ quantity: z.number().int().min(0).max(10) });
const promoSchema = z.object({ code: z.string().max(40).nullable() });

const quoteSchema = z.object({
  addressId: z.string().uuid().nullable().optional(),
  deliveryChoices: z.record(z.string().uuid(), z.string().max(40)).optional(),
});

const confirmSchema = z.object({
  quoteId: z.string().uuid(),
  addressId: z.string().uuid().nullable().optional(),
  customerNote: z.string().max(500).nullable().optional(),
});

@Controller()
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly checkout: CheckoutService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('cart')
  async get(@CurrentUserId() userId: string, @RequestLocale() locale: Locale) {
    return this.cart.view(userId, locale);
  }

  @Get('cart/count')
  async count(@CurrentUserId() userId: string) {
    return { count: await this.cart.countItems(userId) };
  }

  @Post('cart/items')
  async addItem(
    @CurrentUserId() userId: string,
    @Body(zodBody(addItemSchema)) body: z.infer<typeof addItemSchema>,
    @RequestLocale() locale: Locale,
  ) {
    return this.cart.addItem(userId, body, locale);
  }

  /** AI-008: add a whole look, with per-item exceptions reported back. */
  @Post('cart/look')
  async addLook(
    @CurrentUserId() userId: string,
    @Body(zodBody(addLookSchema)) body: z.infer<typeof addLookSchema>,
    @RequestLocale() locale: Locale,
  ) {
    return this.cart.addLook(userId, body.items, {
      outfitSessionId: body.outfitSessionId ?? null,
      locale,
    });
  }

  @Patch('cart/items/:id')
  async updateQuantity(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body(zodBody(quantitySchema)) body: z.infer<typeof quantitySchema>,
    @RequestLocale() locale: Locale,
  ) {
    return this.cart.updateQuantity(userId, id, body.quantity, locale);
  }

  @Delete('cart/items/:id')
  async removeItem(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @RequestLocale() locale: Locale,
  ) {
    return this.cart.removeItem(userId, id, locale);
  }

  @Delete('cart')
  async clear(@CurrentUserId() userId: string, @RequestLocale() locale: Locale) {
    return this.cart.clear(userId, locale);
  }

  @Post('cart/promotion')
  async promotion(
    @CurrentUserId() userId: string,
    @Body(zodBody(promoSchema)) body: z.infer<typeof promoSchema>,
    @RequestLocale() locale: Locale,
  ) {
    return this.cart.applyPromotionCode(userId, body.code, locale);
  }

  /** ORD-002: the server-side quote. Also places the stock hold (CAT-008). */
  @RateLimit({ bucket: 'checkout', max: 40 })
  @Post('checkout/quote')
  async quote(
    @CurrentUserId() userId: string,
    @Body(zodBody(quoteSchema)) body: z.infer<typeof quoteSchema>,
    @RequestLocale() locale: Locale,
    @CorrelationId() correlationId: string,
  ) {
    return this.checkout.createQuote({
      userId,
      addressId: body.addressId ?? null,
      deliveryChoices: body.deliveryChoices,
      locale,
      correlationId,
    });
  }

  @Get('checkout/quote/:id')
  async getQuote(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.checkout.getQuote(userId, id);
  }

  /** ORD-006: requires an Idempotency-Key; a retry returns the same order. */
  @RateLimit({ bucket: 'checkout', max: 20 })
  @Post('checkout/confirm')
  async confirm(
    @CurrentUserId() userId: string,
    @Body(zodBody(confirmSchema)) body: z.infer<typeof confirmSchema>,
    @IdempotencyKey() key: string | null,
    @RequestLocale() locale: Locale,
    @CorrelationId() correlationId: string,
  ) {
    const idempotencyKey = this.idempotency.requireKey(key, 'POST /checkout/confirm');
    return this.idempotency.run(
      { key: idempotencyKey, scope: 'checkout.confirm', body, userId },
      () =>
        this.checkout.confirm({
          userId,
          quoteId: body.quoteId,
          addressId: body.addressId ?? null,
          customerNote: body.customerNote ?? null,
          locale,
          idempotencyKey,
          correlationId,
        }),
    );
  }
}
