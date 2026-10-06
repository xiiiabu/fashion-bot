/**
 * Modular monolith wiring — spec §13 ("для MVP рекомендуется modular monolith
 * с ясными доменными границами. Payment, AI, search и notifications
 * изолируются адаптерами и могут выделяться по мере роста").
 *
 * Domains are separate Nest modules with explicit exports, so extracting one
 * into a service later is a deployment change rather than a rewrite.
 */

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaService } from './common/prisma.service';
import { CacheService } from './common/cache.service';
import { AuditService } from './common/audit.service';
import { IdempotencyService } from './common/idempotency.service';
import { AppExceptionFilter } from './common/errors';
import { CorrelationMiddleware, RateLimitGuard, SerializeInterceptor } from './common/http';

import { AuthService } from './identity/auth.service';
import { ProfileService } from './identity/profile.service';
import { IdentityController } from './identity/identity.controller';
import { AdminAuthGuard, UserAuthGuard } from './identity/guards';

import { AdminAuthService } from './admin/admin-auth.service';
import { AdminCatalogService } from './admin/admin-catalog.service';
import { AdminSellerService } from './admin/admin-seller.service';
import { AdminController } from './admin/admin.controller';

import { CatalogService } from './catalog/catalog.service';
import { SearchService } from './catalog/search.service';
import { CatalogController } from './catalog/catalog.controller';

import { FitService } from './fit/fit.service';
import { DeliveryService } from './fulfillment/delivery.service';
import { ReturnsService } from './fulfillment/returns.service';

import { InventoryService } from './inventory/inventory.service';
import { CartService } from './cart/cart.service';
import { CartController } from './cart/cart.controller';
import { CheckoutService } from './checkout/checkout.service';
import { OrdersService } from './orders/orders.service';
import { OrdersController } from './orders/orders.controller';

import { CommissionRuleService } from './finance/commission-rule.service';
import { LedgerService } from './finance/ledger.service';
import { PayoutService } from './finance/payout.service';
import { ReconciliationService } from './finance/reconciliation.service';

import { PaymentService } from './payments/payment.service';
import { RefundService } from './payments/refund.service';
import { PaymentsController } from './payments/payments.controller';
import { paymentProvidersProvider } from './payments/providers/registry';

import { RetrievalService } from './ai/retrieval.service';
import { LlmService } from './ai/llm.service';
import { StylistService } from './ai/stylist.service';
import { AiController } from './ai/ai.controller';

import { NotificationsService } from './notifications/notifications.service';
import { SupportService } from './support/support.service';
import { SupportController } from './support/support.controller';
import { AnalyticsService } from './analytics/analytics.service';
import { SellerController } from './seller/seller.controller';
import { SchedulerService } from './jobs/scheduler.service';
import { HealthController } from './health.controller';

/**
 * Everything shares one PrismaService instance (one connection pool), so the
 * infrastructure providers live in a global module rather than being imported
 * a dozen times.
 */
@Module({
  providers: [PrismaService, CacheService, AuditService, IdempotencyService],
  exports: [PrismaService, CacheService, AuditService, IdempotencyService],
})
class CoreModule {}

@Module({
  imports: [CoreModule],
  providers: [AuthService, ProfileService, AdminAuthService],
  controllers: [IdentityController],
  exports: [AuthService, ProfileService, AdminAuthService],
})
class IdentityModule {}

@Module({
  imports: [CoreModule],
  providers: [FitService],
  exports: [FitService],
})
class FitModule {}

@Module({
  imports: [CoreModule],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
class DeliveryModule {}

@Module({
  imports: [CoreModule],
  providers: [InventoryService],
  exports: [InventoryService],
})
class InventoryModule {}

@Module({
  imports: [CoreModule, FitModule, DeliveryModule, InventoryModule],
  providers: [CatalogService, SearchService],
  controllers: [CatalogController],
  exports: [CatalogService, SearchService],
})
class CatalogModule {}

@Module({
  imports: [CoreModule],
  providers: [CommissionRuleService, LedgerService, PayoutService, ReconciliationService],
  exports: [CommissionRuleService, LedgerService, PayoutService, ReconciliationService],
})
class FinanceModule {}

@Module({
  imports: [CoreModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
class NotificationsModule {}

@Module({
  imports: [CoreModule, InventoryModule],
  providers: [OrdersService],
  exports: [OrdersService],
})
class OrdersModule {}

@Module({
  imports: [CoreModule, CatalogModule, InventoryModule, DeliveryModule],
  providers: [CartService],
  exports: [CartService],
})
class CartModule {}

@Module({
  imports: [
    CoreModule,
    InventoryModule,
    OrdersModule,
    FinanceModule,
    NotificationsModule,
    DeliveryModule,
  ],
  providers: [PaymentService, RefundService, paymentProvidersProvider],
  controllers: [PaymentsController],
  exports: [PaymentService, RefundService],
})
class PaymentsModule {}

@Module({
  imports: [
    CoreModule,
    OrdersModule,
    InventoryModule,
    NotificationsModule,
    FinanceModule,
  ],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
class FulfillmentModule {}

@Module({
  imports: [
    CoreModule,
    CartModule,
    CatalogModule,
    InventoryModule,
    DeliveryModule,
    FinanceModule,
    IdentityModule,
    OrdersModule,
  ],
  providers: [CheckoutService],
  controllers: [CartController],
  exports: [CheckoutService],
})
class CheckoutModule {}

@Module({
  imports: [CoreModule, CatalogModule, FitModule, CartModule],
  providers: [RetrievalService, LlmService, StylistService],
  controllers: [AiController],
  exports: [StylistService, RetrievalService, LlmService],
})
class AiModule {}

@Module({
  imports: [CoreModule, FinanceModule],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
class AnalyticsModule {}

@Module({
  imports: [CoreModule, NotificationsModule, AnalyticsModule, IdentityModule, CatalogModule, AiModule, OrdersModule],
  providers: [SupportService],
  controllers: [SupportController],
  exports: [SupportService],
})
class SupportModule {}

@Module({
  imports: [
    CoreModule,
    IdentityModule,
    InventoryModule,
    CatalogModule,
    OrdersModule,
    FinanceModule,
    PaymentsModule,
    FulfillmentModule,
    SupportModule,
    AnalyticsModule,
    AiModule,
  ],
  providers: [AdminCatalogService, AdminSellerService],
  controllers: [AdminController, SellerController],
  exports: [AdminCatalogService, AdminSellerService],
})
class AdminModule {}

@Module({
  imports: [
    CoreModule,
    InventoryModule,
    NotificationsModule,
    FinanceModule,
    FulfillmentModule,
    PaymentsModule,
    OrdersModule,
    IdentityModule,
    SupportModule,
    AnalyticsModule,
  ],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
class JobsModule {}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    CoreModule,
    IdentityModule,
    CatalogModule,
    FitModule,
    DeliveryModule,
    InventoryModule,
    CartModule,
    CheckoutModule,
    OrdersModule,
    FinanceModule,
    PaymentsModule,
    FulfillmentModule,
    AiModule,
    NotificationsModule,
    SupportModule,
    AnalyticsModule,
    AdminModule,
    JobsModule,
  ],
  controllers: [HealthController, OrdersController],
  providers: [
    // ADM-001: the buyer guard runs first and denies by default; routes opt
    // out with @Public() or @OptionalAuth(). Admin routes add AdminAuthGuard
    // at the controller level.
    { provide: APP_GUARD, useClass: UserAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    AdminAuthGuard,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
