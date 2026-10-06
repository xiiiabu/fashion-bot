/**
 * Admin panel API — spec §10.
 *
 * Every route is guarded by AdminAuthGuard and an explicit permission
 * (ADM-001: deny by default). MFA-bearing roles additionally need a
 * MFA-verified session, which the guard enforces (ADM-002).
 */

import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_ROLES, LOCALES, SELLER_ROLES, type Locale } from '@fashion/core';
import {
  AdminAuthGuard,
  AdminSurface,
  PlatformOnly,
  Public,
  RequireAnyPermission,
  RequirePermissions,
} from '../identity/guards';
import { AdminAuthService } from './admin-auth.service';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminSellerService } from './admin-seller.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { OrdersService } from '../orders/orders.service';
import { LedgerService } from '../finance/ledger.service';
import { PayoutService } from '../finance/payout.service';
import { ReconciliationService } from '../finance/reconciliation.service';
import { RefundService } from '../payments/refund.service';
import { ReturnsService } from '../fulfillment/returns.service';
import { SupportService } from '../support/support.service';
import { CommissionRuleService } from '../finance/commission-rule.service';
import { InventoryService } from '../inventory/inventory.service';
import { StylistService } from '../ai/stylist.service';
import { Actor, type AppRequest, RateLimit, RequestLocale, zodBody } from '../common/http';
import type { AuthenticatedActor } from '../common/http';
import { AppError } from '../common/errors';

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});
const mfaSchema = z.object({ mfaToken: z.string().min(10), code: z.string().min(6).max(8) });
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  search: z.string().max(200).optional(),
});
const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const productSchema = z.object({
  sellerId: z.string().uuid(),
  brandId: z.string().uuid(),
  categoryId: z.string().uuid(),
  slug: z.string().max(120).optional(),
  externalId: z.string().max(80).nullable().optional(),
  titleRu: z.string().min(2).max(200),
  titleUz: z.string().min(2).max(200),
  titleEn: z.string().max(200).nullable().optional(),
  descriptionRu: z.string().max(5000).optional(),
  descriptionUz: z.string().max(5000).optional(),
  descriptionEn: z.string().max(5000).nullable().optional(),
  gender: z.enum(['WOMEN', 'MEN', 'UNISEX', 'KIDS']).optional(),
  compositionRu: z.string().max(500).optional(),
  compositionUz: z.string().max(500).optional(),
  careRu: z.string().max(500).optional(),
  careUz: z.string().max(500).optional(),
  countryOfOrigin: z.string().max(80).nullable().optional(),
  materials: z.array(z.string().max(40)).max(10).optional(),
  colorName: z.string().min(1).max(60),
  colorFamily: z.string().min(2).max(30),
  colorHex: z.string().max(9).nullable().optional(),
  styleTags: z.array(z.string().max(40)).max(10).optional(),
  occasions: z.array(z.string().max(40)).max(10).optional(),
  season: z.string().max(20).optional(),
  silhouette: z.string().max(30).nullable().optional(),
  formality: z.number().int().min(1).max(5).optional(),
  warmth: z.number().int().min(1).max(5).optional(),
  fitNotes: z.string().max(500).nullable().optional(),
  sizeChartId: z.string().uuid().nullable().optional(),
  returnPolicyId: z.string().uuid().nullable().optional(),
  authenticityNote: z.string().max(500).nullable().optional(),
  incompatibleSlots: z.array(z.string().max(20)).max(9).optional(),
  incompatibleStyles: z.array(z.string().max(40)).max(10).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const skuListSchema = z.object({
  skus: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        sellerSku: z.string().max(80).nullable().optional(),
        barcode: z.string().max(40).nullable().optional(),
        sizeLabel: z.string().min(1).max(20),
        colorName: z.string().max(60).nullable().optional(),
        priceMinor: z.string().regex(/^\d+$/),
        compareAtMinor: z.string().regex(/^\d+$/).nullable().optional(),
        measurements: z.record(z.string(), z.number().int()).optional(),
        weightGrams: z.number().int().nullable().optional(),
        onHand: z.number().int().min(0).optional(),
        safetyStock: z.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(40),
});

@Controller('admin')
@AdminSurface()
// Tenant isolation (ADM-003): everything here is platform staff only. The four
// routes the seller cabinet shares opt out individually with
// @PlatformOnly(false) — see each one below.
@PlatformOnly()
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly catalog: AdminCatalogService,
    private readonly sellers: AdminSellerService,
    private readonly analytics: AnalyticsService,
    private readonly orders: OrdersService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutService,
    private readonly reconciliation: ReconciliationService,
    private readonly refunds: RefundService,
    private readonly returns: ReturnsService,
    private readonly support: SupportService,
    private readonly commissionRules: CommissionRuleService,
    private readonly inventory: InventoryService,
    private readonly stylist: StylistService,
  ) {}

  // ───────────────────────────────────────────── auth (ADM-002/SEC-008)

  @Public()
  @RateLimit({ bucket: 'auth', max: 20 })
  @Post('auth/login')
  async login(
    @Body(zodBody(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() request: AppRequest,
  ) {
    return this.adminAuth.login(body, {
      ipHash: request.ipHash,
      userAgent: request.header('user-agent'),
      correlationId: request.correlationId,
    });
  }

  @Public()
  @RateLimit({ bucket: 'auth', max: 20 })
  @Post('auth/mfa')
  async mfa(@Body(zodBody(mfaSchema)) body: z.infer<typeof mfaSchema>, @Req() request: AppRequest) {
    return this.adminAuth.verifyMfa(body.mfaToken, body.code, {
      ipHash: request.ipHash,
      userAgent: request.header('user-agent'),
      correlationId: request.correlationId,
    });
  }

  @PlatformOnly(false) // Both surfaces sign out here.
  @Post('auth/logout')
  async logout(@Actor() actor: AuthenticatedActor) {
    if (actor.sessionId) await this.adminAuth.logout(actor.sessionId);
    return { ok: true };
  }

  @PlatformOnly(false) // Both surfaces read their own principal here.
  @Get('me')
  async me(@Actor() actor: AuthenticatedActor) {
    return {
      kind: actor.kind,
      id: actor.adminUserId ?? actor.sellerUserId,
      email: actor.email,
      roles: actor.roles,
      sellerId: actor.sellerId,
      permissions: [...actor.permissions],
      mfaVerified: actor.mfaVerified ?? false,
    };
  }

  @PlatformOnly(false) // A seller changes their own password here.
  @Post('auth/password')
  async changePassword(
    @Actor() actor: AuthenticatedActor,
    @Body(
      zodBody(
        z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(200) }),
      ),
    )
    body: { currentPassword: string; newPassword: string },
  ) {
    const id = actor.adminUserId ?? actor.sellerUserId;
    if (!id) throw AppError.unauthenticated();
    await this.adminAuth.changePassword({ kind: actor.kind as 'admin' | 'seller', id }, body);
    return { ok: true };
  }

  @PlatformOnly(false) // A seller lists their own sessions here.
  @Get('auth/sessions')
  async sessions(@Actor() actor: AuthenticatedActor) {
    const id = actor.adminUserId ?? actor.sellerUserId;
    if (!id) throw AppError.unauthenticated();
    return { items: await this.adminAuth.listSessions(id) };
  }

  // ──────────────────────────────────────────────────────── dashboard

  @RequirePermissions('analytics:read')
  @Get('dashboard')
  async dashboard(@Query(zodBody(dateRangeSchema)) query: z.infer<typeof dateRangeSchema>) {
    const [dashboard, series, topSellers, alerts, approvals] = await Promise.all([
      this.analytics.dashboard({ from: query.from, to: query.to }),
      this.analytics.dailySeries(30),
      this.analytics.topSellers(8),
      this.support.listAlerts({ status: 'OPEN', limit: 10 }),
      this.support.pendingApprovals(),
    ]);
    return { ...dashboard, series, topSellers, alerts, pendingApprovals: approvals.length };
  }

  @RequirePermissions('analytics:read')
  @Get('analytics/events')
  async events(@Query('days') days?: string) {
    return { items: await this.analytics.eventSummary(Number.parseInt(days ?? '7', 10)) };
  }

  // ───────────────────────────────────────── sellers, brands, contracts

  @RequirePermissions('seller:read')
  @Get('sellers')
  async listSellers(@Query(zodBody(paginationSchema)) query: z.infer<typeof paginationSchema>) {
    return this.sellers.list(query);
  }

  @RequirePermissions('seller:read')
  @Get('sellers/:id')
  async getSeller(@Param('id') id: string) {
    return this.sellers.detail(id);
  }

  @RequirePermissions('seller:write')
  @Post('sellers')
  async createSeller(@Body() body: unknown, @Actor() actor: AuthenticatedActor) {
    return this.sellers.create(body as never, actor);
  }

  @RequirePermissions('seller:write')
  @Patch('sellers/:id')
  async updateSeller(@Param('id') id: string, @Body() body: unknown, @Actor() actor: AuthenticatedActor) {
    return this.sellers.update(id, body as never, actor);
  }

  @RequirePermissions('seller:approve')
  @Post('sellers/:id/onboarding')
  async setOnboarding(
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          status: z.enum(['LEAD', 'KYB_PENDING', 'CONTRACT_PENDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED']),
          note: z.string().max(500).optional(),
        }),
      ),
    )
    body: { status: never; note?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.sellers.setOnboardingStatus(id, body.status, actor, body.note);
  }

  @RequirePermissions('seller:read')
  @Get('sellers/:id/quality')
  async sellerQuality(@Param('id') id: string) {
    return this.analytics.computeSellerQuality(id);
  }

  @RequirePermissions('brand:read')
  @Get('brands')
  async listBrands() {
    return { items: await this.sellers.listBrands() };
  }

  @RequirePermissions('brand:write')
  @Post('brands')
  async createBrand(@Body() body: unknown, @Actor() actor: AuthenticatedActor) {
    return this.sellers.createBrand(body as never, actor);
  }

  @RequirePermissions('brand:write')
  @Patch('brands/:id')
  async updateBrand(@Param('id') id: string, @Body() body: unknown, @Actor() actor: AuthenticatedActor) {
    return this.sellers.updateBrand(id, body as never, actor);
  }

  @RequirePermissions('contract:read')
  @Get('sellers/:id/contracts')
  async contracts(@Param('id') id: string) {
    return { items: await this.sellers.listContracts(id) };
  }

  @RequirePermissions('contract:write')
  @Post('sellers/:id/contracts')
  async createContract(@Param('id') id: string, @Body() body: unknown, @Actor() actor: AuthenticatedActor) {
    return this.sellers.createContract(id, body as never, actor);
  }

  // ─────────────────────────────────────── catalogue / PIM (ADM-003/004)

  @RequirePermissions('product:read')
  @Get('products')
  async listProducts(
    @Query(
      zodBody(
        paginationSchema.extend({
          sellerId: z.string().uuid().optional(),
          lifecycle: z.string().optional(),
          categoryId: z.string().uuid().optional(),
          brandId: z.string().uuid().optional(),
        }),
      ),
    )
    query: { limit?: number; offset?: number; search?: string; sellerId?: string; lifecycle?: string; categoryId?: string; brandId?: string },
  ) {
    return this.catalog.listProducts({
      ...query,
      lifecycle: query.lifecycle
        ? (query.lifecycle.split(',') as never)
        : undefined,
    });
  }

  @RequirePermissions('product:read')
  @Get('products/:id')
  async getProduct(@Param('id') id: string) {
    return this.catalog.getProduct(id);
  }

  @RequirePermissions('product:write')
  @Post('products')
  async createProduct(
    @Body(zodBody(productSchema)) body: z.infer<typeof productSchema>,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.catalog.createProduct(body, actor);
  }

  @RequirePermissions('product:write')
  @Patch('products/:id')
  async updateProduct(
    @Param('id') id: string,
    @Body(zodBody(productSchema.partial())) body: Partial<z.infer<typeof productSchema>>,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.catalog.updateProduct(id, body, actor);
  }

  @RequirePermissions('sku:write')
  @Post('products/:id/skus')
  async upsertSkus(
    @Param('id') id: string,
    @Body(zodBody(skuListSchema)) body: z.infer<typeof skuListSchema>,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.catalog.upsertSkus(id, body.skus, actor);
  }

  @RequirePermissions('product:read')
  @Get('products/:id/publish-check')
  async publishCheck(@Param('id') id: string) {
    return this.catalog.publishCheck(id);
  }

  /** CAT-009: the review workflow. */
  @RequirePermissions('product:publish')
  @Post('products/:id/lifecycle')
  async lifecycle(
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          to: z.enum(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED']),
          note: z.string().max(500).optional(),
        }),
      ),
    )
    body: { to: never; note?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.catalog.transitionLifecycle(id, body.to, actor, body.note);
  }

  @RequirePermissions('media:write')
  @Post('products/:id/media')
  async addMedia(
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          url: z.string().url().max(600),
          role: z.enum(['MAIN', 'FRONT', 'BACK', 'DETAIL', 'MODEL', 'FLATLAY', 'VIDEO']).optional(),
          altRu: z.string().min(2).max(300),
          altUz: z.string().min(2).max(300),
          altEn: z.string().max(300).nullable().optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          placeholder: z.string().max(20).nullable().optional(),
          rightsConfirmed: z.boolean().optional(),
          sortOrder: z.number().int().min(0).max(50).optional(),
        }),
      ),
    )
    body: never,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.catalog.addMedia(id, body, actor);
  }

  @RequirePermissions('media:write')
  @Delete('media/:id')
  async deleteMedia(@Param('id') id: string, @Actor() actor: AuthenticatedActor) {
    return this.catalog.deleteMedia(id, actor);
  }

  @RequirePermissions('inventory:write')
  @Patch('skus/:id/stock')
  async setStock(
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
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.catalog.setStock(id, body, actor);
  }

  @RequirePermissions('inventory:read')
  @Get('skus/:id/movements')
  async movements(@Param('id') id: string) {
    return { items: await this.inventory.movements(id, 100) };
  }

  @RequirePermissions('inventory:read')
  @Get('inventory/stale')
  async staleStock(@Query('hours') hours?: string) {
    return { items: await this.inventory.staleStock(Number.parseInt(hours ?? '48', 10)) };
  }

  /** ADM-004: dry run first, then commit. */
  @RequirePermissions('product:import')
  @Post('products/import')
  async importProducts(
    @Body(
      zodBody(
        z.object({
          fileName: z.string().max(200),
          content: z.string().min(10).max(5_000_000),
          sellerId: z.string().uuid(),
          dryRun: z.boolean().default(true),
        }),
      ),
    )
    body: { fileName: string; content: string; sellerId: string; dryRun: boolean },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.catalog.importCsv(body, actor);
  }

  @RequirePermissions('product:import')
  @Get('products/import/template')
  template() {
    return { fileName: 'products-template.csv', content: this.catalog.csvTemplate() };
  }

  @RequirePermissions('product:import')
  @Get('products/import/jobs')
  async importJobs() {
    return { items: await this.catalog.importJobs() };
  }

  @RequirePermissions('product:write')
  @Post('catalog/reindex')
  async reindex() {
    return { reindexed: await this.catalog.reindexAll() };
  }

  @RequirePermissions('category:read')
  @Get('categories')
  async categories(@RequestLocale() locale: Locale) {
    return { items: await this.sellers.listCategories(locale) };
  }

  @RequirePermissions('sizechart:read')
  @Get('size-charts')
  async sizeCharts() {
    return { items: await this.sellers.listSizeCharts() };
  }

  @RequirePermissions('sizechart:write')
  @Post('size-charts')
  async createSizeChart(@Body() body: unknown, @Actor() actor: AuthenticatedActor) {
    return this.sellers.upsertSizeChart(body as never, actor);
  }

  // ───────────────────────────────────────────────────────── orders

  @RequirePermissions('order:read')
  @Get('orders')
  async listOrders(
    @Query(
      zodBody(
        paginationSchema.extend({
          status: z.string().optional(),
          sellerId: z.string().uuid().optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      ),
    )
    query: { limit?: number; offset?: number; search?: string; status?: string; sellerId?: string; from?: Date; to?: Date },
  ) {
    return this.orders.adminList({
      ...query,
      status: query.status ? (query.status.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('order:read')
  @Get('orders/:id')
  async getOrder(@Param('id') id: string) {
    return this.orders.adminDetail(id);
  }

  @RequirePermissions('order:read')
  @Get('orders-overdue')
  async overdue() {
    return { items: await this.orders.overdueConfirmations() };
  }

  @RequirePermissions('order:write')
  @Post('suborders/:id/advance')
  async advance(
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          to: z.enum([
            'CONFIRMED',
            'PICKING',
            'READY_FOR_HANDOVER',
            'HANDED_OVER',
            'IN_TRANSIT',
            'DELIVERED',
            'COMPLETED',
          ]),
          note: z.string().max(300).optional(),
        }),
      ),
    )
    body: { to: never; note?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    const subOrder = await this.orders.adminDetail(id).catch(() => null);
    void subOrder;
    return this.orders.transitionSubOrder(id, body.to, {
      actorType: 'ADMIN',
      actorId: actor.adminUserId ?? null,
      note: body.note ?? null,
    });
  }

  // ──────────────────────────────────── payments, refunds, ledger, payouts

  @RequirePermissions('payment:refund')
  @Post('refunds/preview')
  async previewRefund(
    @Body(
      zodBody(
        z.object({
          orderId: z.string().uuid(),
          lines: z
            .array(
              z.object({
                orderItemId: z.string().uuid(),
                quantity: z.number().int().min(1),
                grossOverrideMinor: z.string().regex(/^\d+$/).nullable().optional(),
              }),
            )
            .min(1),
        }),
      ),
    )
    body: never,
  ) {
    return this.refunds.preview(body);
  }

  @RequirePermissions('payment:refund')
  @Post('refunds')
  async createRefund(
    @Body(
      zodBody(
        z.object({
          orderId: z.string().uuid(),
          lines: z
            .array(
              z.object({
                orderItemId: z.string().uuid(),
                quantity: z.number().int().min(1),
                grossOverrideMinor: z.string().regex(/^\d+$/).nullable().optional(),
              }),
            )
            .min(1),
          reason: z.string().min(4).max(500),
          returnRequestId: z.string().uuid().nullable().optional(),
          restock: z.boolean().optional(),
        }),
      ),
    )
    body: never,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.refunds.create(body, actor);
  }

  /** ADM-005: the second approval for a large refund. */
  @RequirePermissions('adjustment:approve')
  @Post('refunds/:id/approve')
  async approveRefund(
    @Param('id') id: string,
    @Body(zodBody(z.object({ approve: z.boolean(), note: z.string().max(500).optional() })))
    body: { approve: boolean; note?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.refunds.approve(id, actor, body);
  }

  @RequirePermissions('payment:read')
  @Get('refunds')
  async listRefunds(
    @Query(zodBody(paginationSchema.extend({ status: z.string().optional() })))
    query: { limit?: number; offset?: number; status?: string },
  ) {
    return this.refunds.list(query);
  }

  @RequirePermissions('ledger:read')
  @Get('ledger')
  async ledgerEntries(
    @Query(
      zodBody(
        paginationSchema.extend({
          sellerId: z.string().uuid().optional(),
          orderId: z.string().uuid().optional(),
          event: z.string().optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      ),
    )
    query: { limit?: number; offset?: number; sellerId?: string; orderId?: string; event?: string; from?: Date; to?: Date },
  ) {
    return this.ledger.entries({
      ...query,
      event: query.event ? (query.event.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('ledger:read')
  @Get('ledger/platform-totals')
  async platformTotals(@Query(zodBody(dateRangeSchema)) query: z.infer<typeof dateRangeSchema>) {
    return this.ledger.platformTotals(query);
  }

  @RequirePermissions('ledger:read')
  @Get('sellers/:id/balance')
  async sellerBalance(@Param('id') id: string) {
    return this.ledger.sellerBalance(id);
  }

  /** PAY-008: prove the balances can be rebuilt from entries. */
  @RequirePermissions('ledger:read')
  @Post('ledger/verify')
  async verifyLedger() {
    const [balances, orders] = await Promise.all([
      this.ledger.recomputeAccountBalances(),
      this.reconciliation.verifyLedgerAgainstOrders(),
    ]);
    return { balances, orders };
  }

  @RequirePermissions('adjustment:write')
  @Post('adjustments')
  async createAdjustment(
    @Body(
      zodBody(
        z.object({
          sellerId: z.string().uuid(),
          amountMinor: z.string().regex(/^-?\d+$/),
          currency: z.enum(['UZS', 'USD', 'EUR', 'RUB']).default('UZS'),
          reason: z.string().min(8).max(500),
          category: z.string().max(40).optional(),
          orderId: z.string().uuid().nullable().optional(),
        }),
      ),
    )
    body: { sellerId: string; amountMinor: string; currency: 'UZS'; reason: string; category?: string; orderId?: string | null },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.ledger.createAdjustment(
      {
        sellerId: body.sellerId,
        amount: { amount: body.amountMinor, currency: body.currency },
        reason: body.reason,
        category: body.category,
        orderId: body.orderId ?? null,
      },
      actor,
    );
  }

  /** ADM-005 / UAT-18: the maker cannot approve their own adjustment. */
  @RequirePermissions('adjustment:approve')
  @Post('adjustments/:id/approve')
  async approveAdjustment(
    @Param('id') id: string,
    @Body(zodBody(z.object({ approve: z.boolean(), note: z.string().max(500).optional() })))
    body: { approve: boolean; note?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.ledger.approveAdjustment(id, actor, body);
  }

  @RequirePermissions('payout:read')
  @Get('payouts')
  async listPayouts(
    @Query(zodBody(paginationSchema.extend({ sellerId: z.string().uuid().optional(), status: z.string().optional() })))
    query: { limit?: number; offset?: number; sellerId?: string; status?: string },
  ) {
    return this.payouts.list({
      ...query,
      status: query.status ? (query.status.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('payout:read')
  @Get('payouts/due')
  async payoutsDue() {
    return { items: await this.payouts.sellersDueForPayout() };
  }

  @RequirePermissions('payout:read')
  @Get('payouts/:id')
  async payoutDetail(@Param('id') id: string) {
    return this.payouts.batchDetail(id);
  }

  @RequirePermissions('payout:create')
  @Post('payouts')
  async createPayout(
    @Body(
      zodBody(
        z.object({
          sellerId: z.string().uuid(),
          periodFrom: z.coerce.date(),
          periodTo: z.coerce.date(),
          currency: z.string().max(4).optional(),
        }),
      ),
    )
    body: { sellerId: string; periodFrom: Date; periodTo: Date; currency?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.payouts.createBatch(body, actor);
  }

  @RequirePermissions('payout:create')
  @Post('payouts/:id/submit')
  async submitPayout(@Param('id') id: string, @Actor() actor: AuthenticatedActor) {
    return this.payouts.submitForApproval(id, actor);
  }

  /** ADM-005: a payout needs a different admin to release it. */
  @RequirePermissions('payout:approve')
  @Post('payouts/:id/approve')
  async approvePayout(
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          approve: z.boolean(),
          note: z.string().max(500).optional(),
          paymentReference: z.string().max(120).optional(),
        }),
      ),
    )
    body: { approve: boolean; note?: string; paymentReference?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.payouts.approve(id, actor, body);
  }

  @RequirePermissions('payout:approve')
  @Post('payouts/:id/settle')
  async settlePayout(
    @Param('id') id: string,
    @Body(zodBody(z.object({ reference: z.string().min(2).max(120) }))) body: { reference: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.payouts.markSettled(id, body.reference, actor);
  }

  @RequirePermissions('reconciliation:read')
  @Get('reconciliation')
  async reconciliationQueue(
    @Query(zodBody(paginationSchema.extend({ provider: z.string().optional(), status: z.string().optional() })))
    query: { limit?: number; offset?: number; provider?: string; status?: string },
  ) {
    return this.reconciliation.queue({
      ...query,
      status: query.status ? (query.status.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('reconciliation:read')
  @Get('reconciliation/summary')
  async reconciliationSummary() {
    return { items: await this.reconciliation.dailySummary(14) };
  }

  @RequirePermissions('reconciliation:resolve')
  @Post('reconciliation/run')
  async runReconciliation(
    @Body(zodBody(z.object({ date: z.coerce.date().optional(), provider: z.string().optional() })))
    body: { date?: Date; provider?: string },
  ) {
    return { summaries: await this.reconciliation.runDaily(body.date, body.provider) };
  }

  @RequirePermissions('reconciliation:resolve')
  @Post('reconciliation/:id/resolve')
  async resolveReconciliation(
    @Param('id') id: string,
    @Body(
      zodBody(z.object({ resolution: z.string().min(8).max(1000), releasePayment: z.boolean().optional() })),
    )
    body: { resolution: string; releasePayment?: boolean },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.reconciliation.resolve(id, body, actor);
  }

  @RequirePermissions('commissionrule:read')
  @Get('commission-rules')
  async commissionRuleHistory(@Query('code') code?: string) {
    return { items: await this.commissionRules.history(code) };
  }

  /** PAY-007: a rate change is a new version, never an edit. */
  @RequirePermissions('commissionrule:write')
  @Post('commission-rules')
  async createCommissionRule(
    @Body(
      zodBody(
        z.object({
          code: z.string().min(2).max(60),
          sellerId: z.string().uuid().nullable().optional(),
          categoryId: z.string().uuid().nullable().optional(),
          rateBps: z.number().int().min(0).max(5000),
          includesDelivery: z.boolean().optional(),
          sellerDiscountReducesBase: z.boolean().optional(),
          platformDiscountReducesBase: z.boolean().optional(),
          rounding: z.enum(['HALF_UP', 'FLOOR', 'CEIL']).optional(),
          minFeeMinor: z.string().regex(/^\d+$/).nullable().optional(),
          maxFeeMinor: z.string().regex(/^\d+$/).nullable().optional(),
          effectiveFrom: z.coerce.date().optional(),
          note: z.string().max(500).optional(),
          isDefault: z.boolean().optional(),
        }),
      ),
    )
    body: Record<string, unknown>,
    @Actor() actor: AuthenticatedActor,
  ) {
    if (!actor.adminUserId) throw AppError.forbidden('Admin only');
    const { minFeeMinor, maxFeeMinor, ...rest } = body as {
      minFeeMinor?: string | null;
      maxFeeMinor?: string | null;
    } & Record<string, unknown>;
    return this.commissionRules.createVersion(
      {
        ...(rest as unknown as { code: string; rateBps: number }),
        minFeeMinor: minFeeMinor ? BigInt(minFeeMinor) : null,
        maxFeeMinor: maxFeeMinor ? BigInt(maxFeeMinor) : null,
      },
      actor.adminUserId,
    );
  }

  @RequirePermissions('export:financial')
  @Get('exports/ledger')
  async exportLedger(
    @Query(zodBody(z.object({ from: z.coerce.date(), to: z.coerce.date(), sellerId: z.string().uuid().optional() })))
    query: { from: Date; to: Date; sellerId?: string },
  ) {
    return this.ledger.exportRows(query);
  }

  // ───────────────────────────────────────────────────────── returns

  @RequirePermissions('return:read')
  @Get('returns')
  async listReturns(
    @Query(zodBody(paginationSchema.extend({ status: z.string().optional(), sellerId: z.string().uuid().optional() })))
    query: { limit?: number; offset?: number; status?: string; sellerId?: string },
  ) {
    return this.returns.queue({
      ...query,
      status: query.status ? (query.status.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('return:approve')
  @Post('returns/:id/decide')
  async decideReturn(
    @Param('id') id: string,
    @Body(zodBody(z.object({ approve: z.boolean(), note: z.string().max(500).optional() })))
    body: { approve: boolean; note?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.returns.decide(id, body, actor);
  }

  @RequirePermissions('return:write')
  @Post('returns/:id/received')
  async receiveReturn(@Param('id') id: string, @Actor() actor: AuthenticatedActor) {
    return this.returns.markReceived(id, actor);
  }

  @RequirePermissions('return:inspect')
  @Post('returns/:id/inspect')
  async inspectReturn(
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
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.returns.inspect(id, body, actor);
  }

  @RequirePermissions('return:write')
  @Post('returns/:id/refund-pending')
  async markRefundPending(@Param('id') id: string, @Actor() actor: AuthenticatedActor) {
    return this.returns.markRefundPending(id, actor);
  }

  @RequirePermissions('return:read')
  @Get('returns/stats')
  async returnStats(@Query(zodBody(dateRangeSchema)) query: z.infer<typeof dateRangeSchema>) {
    return this.returns.returnReasonStats(query);
  }

  // ─────────────────────────────────────────────────── CMS and content

  @RequirePermissions('cms:read')
  @Get('cms/blocks')
  async cmsBlocks() {
    return { items: await this.support.listCmsBlocks() };
  }

  @RequirePermissions('cms:write')
  @Post('cms/blocks')
  async upsertCmsBlock(@Body() body: unknown, @Actor() actor: AuthenticatedActor) {
    return this.support.upsertCmsBlock(body as never, actor);
  }

  @RequirePermissions('cms:write')
  @Delete('cms/blocks/:key')
  async deleteCmsBlock(@Param('key') key: string, @Actor() actor: AuthenticatedActor) {
    return this.support.deleteCmsBlock(key, actor);
  }

  /** CNT-002: preview by locale and point in time. */
  @RequirePermissions('cms:read')
  @Get('cms/preview')
  async cmsPreview(@Query('locale') locale: string, @Query('at') at?: string) {
    const parsed = z.enum(LOCALES).parse(locale ?? 'ru');
    return { items: await this.support.previewCms(parsed, at ? new Date(at) : undefined) };
  }

  @RequirePermissions('cms:read')
  @Get('cms/pages')
  async cmsPages() {
    return { items: await this.support.listContentPages() };
  }

  @RequirePermissions('cms:write')
  @Post('cms/pages')
  async upsertCmsPage(@Body() body: unknown, @Actor() actor: AuthenticatedActor) {
    return this.support.upsertContentPage(body as never, actor);
  }

  // ───────────────────────────────────────────────────────── support

  @RequirePermissions('support:read')
  @Get('tickets')
  async tickets(
    @Actor() actor: AuthenticatedActor,
    @Query(zodBody(paginationSchema.extend({ status: z.string().optional() })))
    query: { limit?: number; offset?: number; search?: string; status?: string },
  ) {
    return this.support.adminListTickets(actor, {
      ...query,
      status: query.status ? (query.status.split(',') as never) : undefined,
    });
  }

  @RequirePermissions('support:read')
  @Get('tickets/:id')
  async ticket(@Param('id') id: string, @Actor() actor: AuthenticatedActor) {
    return this.support.adminGetTicket(actor, id);
  }

  @RequirePermissions('support:write')
  @Post('tickets/:id/reply')
  async replyTicket(
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          body: z.string().min(1).max(4000),
          isInternal: z.boolean().optional(),
          status: z
            .enum(['OPEN', 'WAITING_CUSTOMER', 'WAITING_SELLER', 'ESCALATED', 'RESOLVED', 'CLOSED'])
            .optional(),
        }),
      ),
    )
    body: never,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.support.adminReply(actor, id, body);
  }

  // ─────────────────────────────────────── AI control (§10 AI Control)

  @RequirePermissions('ai:read')
  @Get('ai/overview')
  async aiOverview(@RequestLocale() locale: Locale) {
    return {
      templates: this.stylist.templates(locale),
      suggestions: this.stylist.suggestions(locale),
      engine: { version: '1.0.0', rulesVersion: '2026-09-17' },
    };
  }

  // ────────────────────────────────── IAM, audit, alerts, flags, privacy

  @RequirePermissions('iam:read')
  @Get('iam/admins')
  async admins() {
    return { items: await this.adminAuth.listAdminUsers(), roles: ADMIN_ROLES };
  }

  @RequirePermissions('iam:write')
  @Post('iam/admins')
  async createAdmin(
    @Body(
      zodBody(
        z.object({
          email: z.string().email(),
          name: z.string().min(2).max(120),
          password: z.string().min(12).max(200),
          roles: z.array(z.enum(ADMIN_ROLES)).min(1),
        }),
      ),
    )
    body: never,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.adminAuth.createAdminUser(body, actor);
  }

  @RequirePermissions('iam:write')
  @Patch('iam/admins/:id/roles')
  async setAdminRoles(
    @Param('id') id: string,
    @Body(zodBody(z.object({ roles: z.array(z.enum(ADMIN_ROLES)) }))) body: { roles: never },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.adminAuth.updateAdminRoles(id, body.roles, actor);
  }

  @RequirePermissions('iam:write')
  @Patch('iam/admins/:id/disabled')
  async disableAdmin(
    @Param('id') id: string,
    @Body(zodBody(z.object({ disabled: z.boolean() }))) body: { disabled: boolean },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.adminAuth.setAdminDisabled(id, body.disabled, actor);
  }

  @RequirePermissions('iam:write')
  @Post('sellers/:id/users')
  async createSellerUser(
    @Param('id') sellerId: string,
    @Body(
      zodBody(
        z.object({
          email: z.string().email(),
          name: z.string().min(2).max(120),
          password: z.string().min(12).max(200),
          role: z.enum(SELLER_ROLES),
        }),
      ),
    )
    body: never,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.adminAuth.createSellerUser(sellerId, body, actor);
  }

  @RequirePermissions('audit:read')
  @Get('audit')
  async audit(
    @Query(
      zodBody(
        paginationSchema.extend({
          objectType: z.string().max(60).optional(),
          objectId: z.string().max(80).optional(),
          actorId: z.string().max(80).optional(),
          action: z.string().max(80).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      ),
    )
    query: never,
  ) {
    return this.support.auditLog(query);
  }

  /**
   * ADM-005. Guarded on any approval permission rather than audit:read: the
   * people who work this queue are the finance operators who approve from it,
   * and gating it on audit access hid their own queue from them.
   */
  @RequireAnyPermission('adjustment:approve', 'payout:approve', 'audit:read')
  @Get('approvals')
  async approvals(@Actor() actor: AuthenticatedActor) {
    return { items: await this.support.pendingApprovals(actor.adminUserId) };
  }

  @RequirePermissions('analytics:read')
  @Get('alerts')
  async alerts(@Query(zodBody(z.object({ status: z.string().optional(), severity: z.string().optional() })))
  query: { status?: string; severity?: string }) {
    return { items: await this.support.listAlerts(query) };
  }

  @RequirePermissions('config:write')
  @Post('alerts/:id/acknowledge')
  async acknowledgeAlert(@Param('id') id: string, @Actor() actor: AuthenticatedActor) {
    return this.support.acknowledgeAlert(id, actor);
  }

  @RequirePermissions('config:write')
  @Post('alerts/:id/resolve')
  async resolveAlert(
    @Param('id') id: string,
    @Body(zodBody(z.object({ resolution: z.string().min(2).max(1000) }))) body: { resolution: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.support.resolveAlert(id, body.resolution, actor);
  }

  @RequirePermissions('config:read')
  @Get('feature-flags')
  async featureFlags() {
    return { items: await this.support.listFeatureFlags() };
  }

  @RequirePermissions('featureflag:write')
  @Post('feature-flags')
  async setFeatureFlag(
    @Body(
      zodBody(
        z.object({
          key: z.string().min(2).max(80),
          enabled: z.boolean(),
          rolloutPercent: z.number().int().min(0).max(100).optional(),
          description: z.string().max(300).optional(),
          allowUserIds: z.array(z.string().uuid()).max(100).optional(),
        }),
      ),
    )
    body: never,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.support.setFeatureFlag(body, actor);
  }

  @RequirePermissions('config:read')
  @Get('settings')
  async settings() {
    return { items: await this.support.listSettings() };
  }

  @RequirePermissions('config:write')
  @Post('settings')
  async setSetting(
    @Body(
      zodBody(
        z.object({
          key: z.string().min(2).max(80),
          value: z.unknown(),
          description: z.string().max(300).optional(),
        }),
      ),
    )
    body: { key: string; value: unknown; description?: string },
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.support.setSetting(body.key, body.value, actor, body.description);
  }

  @RequirePermissions('privacyrequest:read')
  @Get('privacy-requests')
  async privacyRequests(@Query('status') status?: string) {
    return { items: await this.support.listPrivacyRequests({ status }) };
  }

  @RequirePermissions('privacyrequest:process')
  @Post('privacy-requests/:id/process')
  async processPrivacyRequest(
    @Param('id') id: string,
    @Body(
      zodBody(
        z.object({
          status: z.enum(['IN_PROGRESS', 'COMPLETED', 'REJECTED']),
          resolution: z.string().max(1000).optional(),
        }),
      ),
    )
    body: never,
    @Actor() actor: AuthenticatedActor,
  ) {
    return this.support.processPrivacyRequest(id, body, actor);
  }
}
