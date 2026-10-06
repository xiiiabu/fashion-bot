/**
 * Buyer order endpoints — API group "Orders" (§14.2):
 * /orders, /orders/{id}, /cancel, /returns.
 */

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Locale } from '@fashion/core';
import { OrdersService } from './orders.service';
import { ReturnsService } from '../fulfillment/returns.service';
import { Actor, CurrentUserId, RateLimit, RequestLocale, zodBody } from '../common/http';
import type { AuthenticatedActor } from '../common/http';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  scope: z.enum(['active', 'all', 'completed']).optional(),
});

const cancelSchema = z.object({ reason: z.string().min(3).max(500) });

const returnSchema = z.object({
  orderId: z.string().uuid(),
  items: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(10),
        reason: z.enum([
          'SIZE_TOO_SMALL',
          'SIZE_TOO_LARGE',
          'NOT_AS_DESCRIBED',
          'QUALITY_ISSUE',
          'WRONG_ITEM',
          'DAMAGED',
          'CHANGED_MIND',
          'LATE_DELIVERY',
          'OTHER',
        ]),
      }),
    )
    .min(1)
    .max(20),
  comment: z.string().max(1000).optional(),
});

@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly returns: ReturnsService,
  ) {}

  @Get('orders')
  async list(
    @CurrentUserId() userId: string,
    @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>,
    @RequestLocale() locale: Locale,
  ) {
    const scope = query.scope ?? 'all';
    return this.orders.listForUser(userId, locale, {
      limit: query.limit,
      offset: query.offset,
      status:
        scope === 'active'
          ? [
              'AWAITING_PAYMENT',
              'PAID',
              'CONFIRMED',
              'PICKING',
              'READY_FOR_HANDOVER',
              'IN_TRANSIT',
              'PAYMENT_FAILED',
            ]
          : scope === 'completed'
            ? ['DELIVERED', 'COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'RETURNED']
            : undefined,
    });
  }

  @Get('orders/:id')
  async detail(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @RequestLocale() locale: Locale,
  ) {
    return this.orders.getForUser(userId, id, locale);
  }

  /** ORD-009: the machine and the policy decide, not the client. */
  @RateLimit({ max: 20 })
  @Post('orders/:id/cancel')
  async cancel(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body(zodBody(cancelSchema)) body: z.infer<typeof cancelSchema>,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.orders.cancelByBuyer(userId, id, body.reason, actor);
  }

  /** FIT-005: items delivered but not yet rated, for the feedback prompt. */
  @Get('orders/feedback/pending')
  async pendingFeedback(@CurrentUserId() userId: string) {
    return { items: await this.orders.deliveredItemsAwaitingFeedback(userId) };
  }

  // ───────────────────────────────────────────────── returns (FUL-006/007)

  @Get('returns')
  async listReturns(@CurrentUserId() userId: string, @RequestLocale() locale: Locale) {
    return { items: await this.returns.listForUser(userId, locale) };
  }

  @Get('returns/:id')
  async getReturn(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @RequestLocale() locale: Locale,
  ) {
    return this.returns.getForUser(userId, id, locale);
  }

  /** FUL-006: eligibility is evaluated server-side and explained. */
  @Get('orders/:id/return-eligibility')
  async eligibility(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @RequestLocale() locale: Locale,
  ) {
    return this.returns.eligibility(userId, id, locale);
  }

  @RateLimit({ max: 20 })
  @Post('returns')
  async createReturn(
    @CurrentUserId() userId: string,
    @Body(zodBody(returnSchema)) body: z.infer<typeof returnSchema>,
    @RequestLocale() locale: Locale,
  ) {
    return this.returns.create(userId, body, locale);
  }

  @Post('returns/:id/handover')
  async handover(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.returns.markHandedOver(userId, id);
  }

  @Post('returns/:id/cancel')
  async cancelReturn(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.returns.cancelByBuyer(userId, id);
  }
}
