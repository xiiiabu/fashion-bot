/**
 * Seller cabinet API — spec §11.
 *
 * SEL-001 Every route resolves the tenant through `resolveTenant`, so a seller
 *         can only ever see their own organisation. UAT-17 lands here.
 * SEL-002 Role permissions come from the same RBAC table as the admin panel.
 * SEL-003 Catalogue changes go through the same moderation workflow.
 * SEL-004 An order queue with confirm / pick / ready / handover / reject.
 * SEL-005 A returns queue with receive, inspect and classify.
 * SEL-006 Finance with drill-down to the OrderItem.
 * SEL-008 Analytics about their own performance only — never a competitor's.
 */

import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SELLER_ROLES, type Locale } from '@fashion/core';
import { AdminAuthGuard, AdminSurface, RequirePermissions, resolveTenant } from '../identity/guards';
import { AdminAuthService } from '../admin/admin-auth.service';
import { AdminCatalogService, type ProductInput } from '../admin/admin-catalog.service';
import { AdminSellerService } from '../admin/admin-seller.service';
import { OrdersService } from '../orders/orders.service';
import { ReturnsService } from '../fulfillment/returns.service';
import { LedgerService } from '../finance/ledger.service';
import { PayoutService } from '../finance/payout.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { InventoryService } from '../inventory/inventory.service';
import { Actor, RequestLocale, zodBody } from '../common/http';
import type { AuthenticatedActor } from '../common/http';
import { AppError } from '../common/errors';

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  search: z.string().max(200).optional(),
  sellerId: z.string().uuid().optional(),
});

@Controller('seller')
@AdminSurface()
@UseGuards(AdminAuthGuard)
export class SellerController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly catalog: AdminCatalogService,
    private readonly sellers: AdminSellerService,
    private readonly orders: OrdersService,
    private readonly returns: ReturnsService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutService,
    private readonly analytics: AnalyticsService,
    private readonly inventory: InventoryService,
  ) {}

  /** The cabinet home: who am I, what is my balance, what needs attention. */
  @RequirePermissions('order:read')
  @Get('overview')
  async overview(@Actor() actor: AuthenticatedActor, @Query('sellerId') sellerIdQuery?: string) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    const [seller, balance, queue, returnsQueue, quality] = await Promise.all([
      this.sellers.detail(sellerId),
      this.ledger.sellerBalance(sellerId),
      this.orders.sellerQueue(sellerId, { limit: 5 }),
      this.returns.queue({ sellerId, status: ['REQUESTED', 'APPROVED', 'HANDED_OVER', 'RECEIVED'], limit: 5 }),
      this.analytics.computeSellerQuality(sellerId),
    ]);

    return {
      seller: {
        id: seller.id,
        displayName: seller.displayName,
        legalName: seller.legalName,
        onboardingStatus: seller.onboardingStatus,
        settlementMode: seller.settlementMode,
        handlingDays: seller.handlingDays,
        cutoffLocalTime: seller.cutoffLocalTime,
        payoutScheduleDays: seller.payoutScheduleDays,
        checklist: seller.checklist,
        checklistComplete: seller.checklistComplete,
      },
      finance: balance,
      pendingOrders: queue.total,
      pendingReturns: returnsQueue.total,
      productCount: seller._count.products,
      // SEL-010: the factors are shown, not just the score.
      quality,
    };
  }

  // ───────────────────────────────────────── catalogue (SEL-003)

  @RequirePermissions('product:read')
  @Get('products')
  async products(
    @Actor() actor: AuthenticatedActor,
    @Query(zodBody(pagination.extend({ lifecycle: z.string().optional() })))
    query: { limit?: number; offset?: number; search?: string; sellerId?: string; lifecycle?: string },
  ) {
    const sellerId = resolveTenant(actor, query.sellerId);
    return this.catalog.listProducts({
      ...query,
      sellerId,
      lifecycle: query.lifecycle ? (query.lifecycle.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('product:read')
  @Get('products/:id')
  async product(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.catalog.getProduct(id, sellerId);
  }

  @RequirePermissions('product:write')
  @Post('products')
  async createProduct(@Actor() actor: AuthenticatedActor, @Body() body: Record<string, unknown>) {
    const sellerId = resolveTenant(actor, body.sellerId as string | undefined);
    // SEL-001: the tenant is forced, never taken from the payload.
    return this.catalog.createProduct({ ...body, sellerId } as unknown as ProductInput, actor);
  }

  @RequirePermissions('product:write')
  @Patch('products/:id')
  async updateProduct(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const sellerId = resolveTenant(actor, body.sellerId as string | undefined);
    return this.catalog.updateProduct(id, body as never, actor, sellerId);
  }

  @RequirePermissions('sku:write')
  @Post('products/:id/skus')
  async upsertSkus(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body(zodBody(z.object({ skus: z.array(z.record(z.string(), z.unknown())).min(1).max(40) })))
    body: { skus: Array<Record<string, unknown>> },
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.catalog.upsertSkus(id, body.skus as never, actor, sellerId);
  }

  @RequirePermissions('product:read')
  @Get('products/:id/publish-check')
  async publishCheck(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    await this.catalog.getProduct(id, sellerId);
    return this.catalog.publishCheck(id);
  }

  /**
   * SEL-003: a seller submits for review; only an admin publishes. That is
   * what keeps CAT-009's moderation gate meaningful.
   */
  @RequirePermissions('product:write')
  @Post('products/:id/submit')
  async submitForReview(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    await this.catalog.getProduct(id, sellerId);
    return this.catalog.transitionLifecycle(id, 'IN_REVIEW', actor, 'Submitted by the seller');
  }

  @RequirePermissions('media:write')
  @Post('products/:id/media')
  async addMedia(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.catalog.addMedia(id, body as never, actor, sellerId);
  }

  @RequirePermissions('media:write')
  @Delete('media/:id')
  async deleteMedia(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.catalog.deleteMedia(id, actor, sellerId);
  }

  @RequirePermissions('inventory:write')
  @Patch('skus/:id/stock')
  async setStock(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          onHand: z.number().int().min(0).optional(),
          safetyStock: z.number().int().min(0).optional(),
          lowStockThreshold: z.number().int().min(0).optional(),
        }),
      ),
    )
    body: { onHand?: number; safetyStock?: number; lowStockThreshold?: number },
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.catalog.setStock(id, body, actor, sellerId);
  }

  @RequirePermissions('inventory:read')
  @Get('skus/:id/movements')
  async movements(@Actor() actor: AuthenticatedActor, @Param('id') id: string) {
    resolveTenant(actor);
    return { items: await this.inventory.movements(id, 100) };
  }

  /** SEL-007: a CSV stock/price feed, same engine as the admin import. */
  @RequirePermissions('product:write')
  @Post('products/import')
  async importProducts(
    @Actor() actor: AuthenticatedActor,
    @Body(
      zodBody(
        z.object({
          fileName: z.string().max(200),
          content: z.string().min(10).max(2_000_000),
          dryRun: z.boolean().default(true),
          sellerId: z.string().uuid().optional(),
        }),
      ),
    )
    body: { fileName: string; content: string; dryRun: boolean; sellerId?: string },
  ) {
    const sellerId = resolveTenant(actor, body.sellerId);
    return this.catalog.importCsv({ ...body, sellerId }, actor);
  }

  @RequirePermissions('product:read')
  @Get('products/import/jobs')
  async importJobs(@Actor() actor: AuthenticatedActor, @Query('sellerId') sellerIdQuery?: string) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return { items: await this.catalog.importJobs(sellerId) };
  }

  @RequirePermissions('product:read')
  @Get('products/import/template')
  template() {
    return { fileName: 'products-template.csv', content: this.catalog.csvTemplate() };
  }

  // ─────────────────────────────────────────── orders (SEL-004)

  @RequirePermissions('order:read')
  @Get('orders')
  async orderQueue(
    @Actor() actor: AuthenticatedActor,
    @Query(zodBody(pagination.extend({ status: z.string().optional() })))
    query: { limit?: number; offset?: number; sellerId?: string; status?: string },
  ) {
    const sellerId = resolveTenant(actor, query.sellerId);
    return this.orders.sellerQueue(sellerId, {
      limit: query.limit,
      offset: query.offset,
      status: query.status ? (query.status.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('order:write')
  @Post('orders/:id/confirm')
  async confirm(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.orders.sellerConfirm(sellerId, id, actor);
  }

  /** FUL-004: a rejection needs a reason and produces a refund obligation. */
  @RequirePermissions('order:write')
  @Post('orders/:id/reject')
  async reject(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          reason: z.string().min(4).max(500),
          itemIds: z.array(z.string().uuid()).max(40).optional(),
          sellerId: z.string().uuid().optional(),
        }),
      ),
    )
    body: { reason: string; itemIds?: string[]; sellerId?: string },
  ) {
    const sellerId = resolveTenant(actor, body.sellerId);
    return this.orders.sellerReject(sellerId, id, body, actor);
  }

  @RequirePermissions('order:write')
  @Post('orders/:id/advance')
  async advance(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          to: z.enum(['PICKING', 'READY_FOR_HANDOVER', 'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']),
          note: z.string().max(300).optional(),
          sellerId: z.string().uuid().optional(),
        }),
      ),
    )
    body: { to: never; note?: string; sellerId?: string },
  ) {
    const sellerId = resolveTenant(actor, body.sellerId);
    return this.orders.sellerAdvance(sellerId, id, body.to, actor, body.note);
  }

  // ─────────────────────────────────────────── returns (SEL-005)

  @RequirePermissions('return:read')
  @Get('returns')
  async returnQueue(
    @Actor() actor: AuthenticatedActor,
    @Query(zodBody(pagination.extend({ status: z.string().optional() })))
    query: { limit?: number; offset?: number; sellerId?: string; status?: string },
  ) {
    const sellerId = resolveTenant(actor, query.sellerId);
    return this.returns.queue({
      sellerId,
      limit: query.limit,
      offset: query.offset,
      status: query.status ? (query.status.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('return:write')
  @Post('returns/:id/received')
  async received(@Actor() actor: AuthenticatedActor, @Param('id') id: string) {
    resolveTenant(actor);
    return this.returns.markReceived(id, actor);
  }

  /**
   * SEL-005: a seller may inspect and classify, but the refund itself stays
   * with finance — "refund только через разрешённый workflow".
   */
  @RequirePermissions('return:inspect')
  @Post('returns/:id/inspect')
  async inspect(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          items: z
            .array(
              z.object({
                returnItemId: z.string().uuid(),
                outcome: z.enum(['ACCEPTED', 'REJECTED', 'PARTIAL']),
                restock: z.boolean(),
                note: z.string().max(300).optional(),
              }),
            )
            .min(1),
          classification: z.string().max(80).optional(),
          note: z.string().max(500).optional(),
        }),
      ),
    )
    body: never,
  ) {
    resolveTenant(actor);
    return this.returns.inspect(id, body, actor);
  }

  // ─────────────────────────────────────────── finance (SEL-006)

  @RequirePermissions('ledger:read')
  @Get('finance/balance')
  async balance(@Actor() actor: AuthenticatedActor, @Query('sellerId') sellerIdQuery?: string) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.ledger.sellerBalance(sellerId);
  }

  /** SEL-006: every line drills down to the OrderItem. */
  @RequirePermissions('ledger:read')
  @Get('finance/ledger')
  async ledgerEntries(
    @Actor() actor: AuthenticatedActor,
    @Query(
      zodBody(
        pagination.extend({
          event: z.string().optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      ),
    )
    query: { limit?: number; offset?: number; sellerId?: string; event?: string; from?: Date; to?: Date },
  ) {
    const sellerId = resolveTenant(actor, query.sellerId);
    return this.ledger.entries({
      sellerId,
      limit: query.limit,
      offset: query.offset,
      from: query.from,
      to: query.to,
      event: query.event ? (query.event.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('payout:read')
  @Get('finance/payouts')
  async payoutList(
    @Actor() actor: AuthenticatedActor,
    @Query(zodBody(pagination)) query: { limit?: number; offset?: number; sellerId?: string },
  ) {
    const sellerId = resolveTenant(actor, query.sellerId);
    return this.payouts.list({ sellerId, limit: query.limit, offset: query.offset });
  }

  @RequirePermissions('payout:read')
  @Get('finance/payouts/:id')
  async payoutDetail(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.payouts.batchDetail(id, sellerId);
  }

  @RequirePermissions('export:financial')
  @Get('finance/export')
  async exportFinance(
    @Actor() actor: AuthenticatedActor,
    @Query(zodBody(z.object({ from: z.coerce.date(), to: z.coerce.date(), sellerId: z.string().uuid().optional() })))
    query: { from: Date; to: Date; sellerId?: string },
  ) {
    const sellerId = resolveTenant(actor, query.sellerId);
    return this.ledger.exportRows({ sellerId, from: query.from, to: query.to });
  }

  // ──────────────────────────────────────── analytics (SEL-008)

  @RequirePermissions('analytics:read')
  @Get('analytics')
  async sellerAnalytics(
    @Actor() actor: AuthenticatedActor,
    @Query(zodBody(z.object({ sellerId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() })))
    query: { sellerId?: string; from?: Date; to?: Date },
  ) {
    const sellerId = resolveTenant(actor, query.sellerId);
    const [totals, returns, quality] = await Promise.all([
      // SEL-008: scoped to this seller — "нет данных конкурентов".
      this.orders.totals({ sellerId, from: query.from, to: query.to }),
      this.returns.returnReasonStats({ sellerId, from: query.from, to: query.to }),
      this.analytics.computeSellerQuality(sellerId),
    ]);
    return { totals, returns, quality };
  }

  // ───────────────────────────────── settings, users, contracts

  @RequirePermissions('iam:read')
  @Get('users')
  async users(@Actor() actor: AuthenticatedActor, @Query('sellerId') sellerIdQuery?: string) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return { items: await this.adminAuth.listSellerUsers(sellerId), roles: SELLER_ROLES };
  }

  @RequirePermissions('iam:write')
  @Post('users')
  async createUser(
    @Actor() actor: AuthenticatedActor,
    @Body(
      zodBody(
        z.object({
          email: z.string().email(),
          name: z.string().min(2).max(120),
          password: z.string().min(12).max(200),
          role: z.enum(SELLER_ROLES),
          sellerId: z.string().uuid().optional(),
        }),
      ),
    )
    body: { email: string; name: string; password: string; role: never; sellerId?: string },
  ) {
    const sellerId = resolveTenant(actor, body.sellerId);
    // SEL-002: only the owner manages the team.
    if (actor.kind === 'seller' && !actor.roles.includes('SELLER_OWNER')) {
      throw AppError.forbidden('Only the seller owner can manage users');
    }
    return this.adminAuth.createSellerUser(sellerId, body, actor);
  }

  @RequirePermissions('contract:read')
  @Get('contracts')
  async contracts(@Actor() actor: AuthenticatedActor, @Query('sellerId') sellerIdQuery?: string) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return { items: await this.sellers.listContracts(sellerId) };
  }

  @RequirePermissions('inventory:write')
  @Post('delivery-methods')
  async upsertDelivery(
    @Actor() actor: AuthenticatedActor,
    @Body() body: Record<string, unknown>,
  ) {
    const sellerId = resolveTenant(actor, body.sellerId as string | undefined);
    return this.sellers.upsertDeliveryMethod(sellerId, body as never, actor);
  }

  @RequirePermissions('product:write')
  @Post('return-policies')
  async upsertReturnPolicy(@Actor() actor: AuthenticatedActor, @Body() body: Record<string, unknown>) {
    const sellerId = resolveTenant(actor, body.sellerId as string | undefined);
    return this.sellers.upsertReturnPolicy(sellerId, body as never, actor);
  }

  /** SEL-007: scoped, rotatable feed credentials. Shown once. */
  @RequirePermissions('iam:write')
  @Post('feeds')
  async createFeed(
    @Actor() actor: AuthenticatedActor,
    @Body(
      zodBody(
        z.object({
          name: z.string().min(2).max(80),
          scopes: z.array(z.string().max(40)).max(10).optional(),
          sellerId: z.string().uuid().optional(),
        }),
      ),
    )
    body: { name: string; scopes?: string[]; sellerId?: string },
  ) {
    const sellerId = resolveTenant(actor, body.sellerId);
    return this.sellers.createInventoryFeed(sellerId, body, actor);
  }

  @RequirePermissions('iam:write')
  @Delete('feeds/:id')
  async revokeFeed(
    @Actor() actor: AuthenticatedActor,
    @Param('id') id: string,
    @Query('sellerId') sellerIdQuery?: string,
  ) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    return this.sellers.revokeInventoryFeed(id, actor, sellerId);
  }

  @RequirePermissions('sizechart:read')
  @Get('size-charts')
  async sizeCharts(@Actor() actor: AuthenticatedActor) {
    resolveTenant(actor);
    return { items: await this.sellers.listSizeCharts() };
  }

  @RequirePermissions('sizechart:write')
  @Post('size-charts')
  async upsertSizeChart(@Actor() actor: AuthenticatedActor, @Body() body: Record<string, unknown>) {
    resolveTenant(actor);
    return this.sellers.upsertSizeChart(body as never, actor);
  }

  @RequirePermissions('category:read')
  @Get('categories')
  async categories(@Actor() actor: AuthenticatedActor, @RequestLocale() locale: Locale) {
    resolveTenant(actor);
    return { items: await this.sellers.listCategories(locale) };
  }

  @RequirePermissions('brand:read')
  @Get('brands')
  async brands(@Actor() actor: AuthenticatedActor, @Query('sellerId') sellerIdQuery?: string) {
    const sellerId = resolveTenant(actor, sellerIdQuery);
    const all = await this.sellers.listBrands();
    // SEL-001 again: a seller sees their own brands plus unassigned ones they
    // may legitimately list under, never another seller's brand roster.
    return { items: all.filter((brand) => brand.seller?.id === sellerId || brand.seller == null) };
  }
}
