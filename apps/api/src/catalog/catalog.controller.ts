/**
 * Catalogue endpoints — API group "Catalog" (§14.2):
 * /home, /categories, /brands, /products, /search, /collections.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  COLOR_FAMILIES,
  FIT_PREFERENCES,
  OCCASIONS,
  SEASONS,
  STYLE_TAGS,
  type Locale,
} from '@fashion/core';
import { CatalogService } from './catalog.service';
import { SearchService, type SortOption } from './search.service';
import { FitService } from '../fit/fit.service';
import { DeliveryService } from '../fulfillment/delivery.service';
import { OptionalAuth, Public } from '../identity/guards';
import { Actor, CurrentUserId, RateLimit, RequestLocale, zodBody } from '../common/http';
import type { AuthenticatedActor } from '../common/http';

const csvArray = (values: readonly string[]) =>
  z
    .string()
    .optional()
    .transform((input) =>
      input
        ? input
            .split(',')
            .map((item) => item.trim())
            .filter((item) => values.includes(item))
        : [],
    );

const freeCsv = z
  .string()
  .optional()
  .transform((input) =>
    input
      ? input
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 30)
      : [],
  );

const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  category: freeCsv,
  brand: freeCsv,
  brandSlug: freeCsv,
  seller: freeCsv,
  size: freeCsv,
  color: csvArray(COLOR_FAMILIES),
  material: freeCsv,
  style: csvArray(STYLE_TAGS),
  season: csvArray(SEASONS),
  fit: csvArray(FIT_PREFERENCES),
  occasion: csvArray(OCCASIONS),
  gender: z.enum(['WOMEN', 'MEN', 'UNISEX', 'KIDS']).optional(),
  priceMin: z.string().regex(/^\d+$/).optional(),
  priceMax: z.string().regex(/^\d+$/).optional(),
  discount: z.enum(['true', 'false']).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  collection: z.string().max(120).optional(),
  sort: z.enum(['relevance', 'newest', 'price_asc', 'price_desc', 'discount', 'popular']).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
  cursor: z.string().max(400).optional(),
});

const wishlistSchema = z.object({
  productId: z.string().uuid(),
  skuId: z.string().uuid().nullable().optional(),
});

const subscribeSchema = z.object({
  skuId: z.string().uuid(),
  backInStock: z.boolean().optional(),
  priceDrop: z.boolean().optional(),
  priceThresholdMinor: z.string().regex(/^\d+$/).nullable().optional(),
});

const reviewSchema = z.object({
  productId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(120).nullable().optional(),
  body: z.string().min(4).max(4000),
  fitVerdict: z.enum(['RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE']).nullable().optional(),
  orderItemId: z.string().uuid().nullable().optional(),
});

const feedbackSchema = z.object({
  skuId: z.string().uuid(),
  orderItemId: z.string().uuid().nullable().optional(),
  overall: z.enum(['RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE']),
  length: z.enum(['RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE']).nullable().optional(),
  width: z.enum(['RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE']).nullable().optional(),
  comfort: z.number().int().min(1).max(5).nullable().optional(),
  comment: z.string().max(1000).nullable().optional(),
});

@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly search: SearchService,
    private readonly fit: FitService,
    private readonly delivery: DeliveryService,
  ) {}

  @OptionalAuth()
  @Get('home')
  async home(@Actor() actor: AuthenticatedActor | undefined, @RequestLocale() locale: Locale) {
    return this.catalog.home(locale, actor?.userId ?? null);
  }

  @Public()
  @Get('categories')
  async categories(@RequestLocale() locale: Locale) {
    return { items: await this.catalog.categoryTree(locale) };
  }

  @Public()
  @Get('brands')
  async brands(@RequestLocale() locale: Locale, @Query('featured') featured?: string) {
    const items =
      featured === 'true' ? await this.catalog.featuredBrands(locale) : await this.catalog.allBrands();
    return { items };
  }

  @Public()
  @Get('brands/:slug')
  async brand(@Param('slug') slug: string, @RequestLocale() locale: Locale) {
    return this.catalog.brandBySlug(slug, locale);
  }

  @Public()
  @Get('collections')
  async collections(@RequestLocale() locale: Locale) {
    return { items: await this.catalog.collections(locale) };
  }

  @OptionalAuth()
  @Get('looks')
  async looks(@Actor() actor: AuthenticatedActor | undefined, @RequestLocale() locale: Locale) {
    const wishlisted = await this.catalog.wishlistedIds(actor?.userId);
    return { items: await this.catalog.curatedLooks(locale, wishlisted, 12) };
  }

  @OptionalAuth()
  @Get('looks/:idOrSlug')
  async look(
    @Param('idOrSlug') idOrSlug: string,
    @Actor() actor: AuthenticatedActor | undefined,
    @RequestLocale() locale: Locale,
  ) {
    return this.catalog.curatedLook(idOrSlug, locale, actor?.userId ?? null);
  }

  /** BUY-002 / BUY-003. */
  @OptionalAuth()
  @RateLimit({ max: 240 })
  @Get('search')
  async searchProducts(
    @Query(zodBody(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>,
    @Actor() actor: AuthenticatedActor | undefined,
    @RequestLocale() locale: Locale,
  ) {
    const result = await this.search.search({
      q: query.q ?? null,
      categorySlugs: query.category,
      brandIds: query.brand.filter(isUuid),
      brandSlugs: [...query.brandSlug, ...query.brand.filter((value) => !isUuid(value))],
      sellerIds: query.seller.filter(isUuid),
      sizes: query.size,
      colors: query.color as never,
      materials: query.material,
      styles: query.style as never,
      seasons: query.season as never,
      fits: query.fit as never,
      occasions: query.occasion,
      gender: query.gender ?? null,
      priceMinMinor: query.priceMin ? BigInt(query.priceMin) : null,
      priceMaxMinor: query.priceMax ? BigInt(query.priceMax) : null,
      discountOnly: query.discount === 'true',
      inStockOnly: query.inStock !== 'false',
      collectionSlug: query.collection ?? null,
      sort: (query.sort as SortOption) ?? 'relevance',
      limit: query.limit,
      cursor: query.cursor ?? null,
      locale,
      userId: actor?.userId ?? null,
    });

    // Price sorting needs the mapped SKU price, so it is applied to the page.
    if (query.sort === 'price_asc' || query.sort === 'price_desc') {
      return {
        ...result,
        items: this.search.sortByPrice(result.items, query.sort === 'price_asc' ? 'asc' : 'desc'),
      };
    }
    return result;
  }

  @OptionalAuth()
  @Get('products/:idOrSlug')
  async product(
    @Param('idOrSlug') idOrSlug: string,
    @Actor() actor: AuthenticatedActor | undefined,
    @RequestLocale() locale: Locale,
  ) {
    return this.catalog.productDetail(idOrSlug, locale, actor?.userId ?? null);
  }

  @Public()
  @Get('products/:id/reviews')
  async reviews(@Param('id') id: string) {
    return { items: await this.catalog.productReviews(id) };
  }

  @Post('reviews')
  async submitReview(
    @CurrentUserId() userId: string,
    @Body(zodBody(reviewSchema)) body: z.infer<typeof reviewSchema>,
  ) {
    return this.catalog.submitReview(userId, body);
  }

  /** FIT-003: the recommendation for one product, with confidence and reason. */
  @OptionalAuth()
  @Get('fit/recommendation')
  async fitRecommendation(
    @Query('productId') productId: string,
    @Actor() actor: AuthenticatedActor | undefined,
  ) {
    const recommendation = await this.fit.recommendForProduct({
      productId,
      userId: actor?.userId ?? null,
    });
    const signal = await this.fit.publicFitSignal(productId);
    return { recommendation, communitySignal: signal };
  }

  /** FIT-005: post-delivery feedback. */
  @Post('fit/feedback')
  async fitFeedback(
    @CurrentUserId() userId: string,
    @Body(zodBody(feedbackSchema)) body: z.infer<typeof feedbackSchema>,
  ) {
    return this.fit.submitFeedback(userId, body);
  }

  // ──────────────────────────────────────────────────────── wishlist

  @Get('wishlist')
  async wishlist(@CurrentUserId() userId: string, @RequestLocale() locale: Locale) {
    return { items: await this.catalog.wishlist(userId, locale) };
  }

  @Post('wishlist')
  @HttpCode(201)
  async addToWishlist(
    @CurrentUserId() userId: string,
    @Body(zodBody(wishlistSchema)) body: z.infer<typeof wishlistSchema>,
  ) {
    await this.catalog.addToWishlist(userId, body.productId, body.skuId ?? null);
    return { ok: true };
  }

  @Delete('wishlist/:productId')
  @HttpCode(204)
  async removeFromWishlist(
    @CurrentUserId() userId: string,
    @Param('productId') productId: string,
  ): Promise<void> {
    await this.catalog.removeFromWishlist(userId, productId);
  }

  @Post('stock-subscriptions')
  @HttpCode(201)
  async subscribe(
    @CurrentUserId() userId: string,
    @Body(zodBody(subscribeSchema)) body: z.infer<typeof subscribeSchema>,
  ) {
    await this.catalog.subscribeToSku(userId, body.skuId, {
      backInStock: body.backInStock,
      priceDrop: body.priceDrop,
      priceThresholdMinor: body.priceThresholdMinor ? BigInt(body.priceThresholdMinor) : null,
    });
    return { ok: true };
  }

  @Delete('stock-subscriptions/:skuId')
  @HttpCode(204)
  async unsubscribe(@CurrentUserId() userId: string, @Param('skuId') skuId: string): Promise<void> {
    await this.catalog.unsubscribeFromSku(userId, skuId);
  }

  // ─────────────────────────────────────────────── delivery and content

  @Public()
  @Get('delivery/zones')
  async zones(@RequestLocale() locale: Locale) {
    return { items: await this.delivery.listZones(locale) };
  }

  @Public()
  @Get('pages/:slug')
  async page(@Param('slug') slug: string, @RequestLocale() locale: Locale) {
    return this.catalog.contentPage(slug, locale);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
