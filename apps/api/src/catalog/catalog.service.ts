/**
 * Catalogue read model — spec §4.3 and §12.
 *
 * BUY-001 Home is CMS-driven with a fallback, so an empty CMS still renders.
 * BUY-004 Cards carry current price and availability.
 * BUY-005 The PDP exposes everything required before a purchase is possible;
 *         `assertPurchasable` is the gate that stops a SKU with missing
 *         mandatory data from being sold.
 * BUY-007 Wishlist is server-side and survives sessions.
 * BUY-009 Reviews are moderated and carry a verified-purchase mark.
 * CNT-001/002 CMS blocks are scheduled and localised.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type BrandSummary,
  type CategorySummary,
  type ColorFamily,
  type HomeBlock,
  type Locale,
  type Occasion,
  type ProductCard,
  type ProductDetail,
  type Season,
  type Silhouette,
  type StyleTag,
  INTENT_EXAMPLES,
  pickLocalized,
  sizeSortKey,
  sum,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { discountPercent, nullableMoney, toMoney } from '../common/money.util';
import { FitService } from '../fit/fit.service';
import { DeliveryService } from '../fulfillment/delivery.service';
import {
  availableUnits,
  mapBrand,
  mapCategory,
  mapMedia,
  mapProductCard,
  mapSeller,
  mapSizeChart,
  mapSku,
  productCardInclude,
} from './product-mapper';
import { SearchService } from './search.service';

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly fit: FitService,
    private readonly delivery: DeliveryService,
  ) {}

  private publishedWhere(): Prisma.ProductWhereInput {
    return {
      lifecycle: 'PUBLISHED',
      archivedAt: null,
      seller: { onboardingStatus: 'ACTIVE', suspendedAt: null },
    };
  }

  // ───────────────────────────────────────────────────── home (BUY-001)

  async home(locale: Locale, userId: string | null): Promise<{ blocks: HomeBlock[] }> {
    const now = new Date();
    const blocks = await this.prisma.cmsBlock.findMany({
      where: {
        isActive: true,
        locales: { has: locale },
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: { sortOrder: 'asc' },
    });

    const wishlisted = await this.wishlistedIds(userId);
    const resolved: HomeBlock[] = [];

    for (const block of blocks) {
      const config = (block.config as Record<string, unknown>) ?? {};
      const base = {
        id: block.id,
        kind: block.kind as HomeBlock['kind'],
        title: pickLocalized({ ru: block.titleRu, uz: block.titleUz, en: block.titleEn }, locale) || null,
        subtitle:
          pickLocalized({ ru: block.subtitleRu, uz: block.subtitleUz, en: block.subtitleEn }, locale) ||
          null,
        ctaLabel:
          pickLocalized({ ru: block.ctaLabelRu, uz: block.ctaLabelUz, en: block.ctaLabelEn }, locale) ||
          null,
        ctaHref: block.ctaHref,
        imageUrl: block.imageUrl,
      };

      switch (block.kind) {
        case 'PRODUCT_RAIL':
        case 'SALE_RAIL': {
          const products = await this.productsForRail(config, locale, wishlisted, block.kind === 'SALE_RAIL');
          // BUY-001 fallback: an empty rail is dropped rather than rendered blank.
          if (products.length === 0) continue;
          resolved.push({ ...base, products });
          break;
        }
        case 'BRAND_RAIL': {
          const brands = await this.featuredBrands(locale, (config.limit as number) ?? 12);
          if (brands.length === 0) continue;
          resolved.push({ ...base, brands });
          break;
        }
        case 'CATEGORY_GRID': {
          const categories = await this.rootCategories(locale);
          if (categories.length === 0) continue;
          resolved.push({ ...base, categories });
          break;
        }
        case 'LOOK_RAIL': {
          const looks = await this.curatedLooks(locale, wishlisted, (config.limit as number) ?? 8);
          if (looks.length === 0) continue;
          resolved.push({ ...base, looks });
          break;
        }
        case 'AI_PROMPT': {
          const prompts = Array.isArray(config.prompts) && config.prompts.length > 0
            ? (config.prompts as string[])
            : INTENT_EXAMPLES[locale];
          resolved.push({ ...base, prompts });
          break;
        }
        default:
          resolved.push(base);
      }
    }

    // A deployment with no CMS content at all still has a usable home screen.
    if (resolved.length === 0) {
      resolved.push(...(await this.fallbackHome(locale, wishlisted)));
    }

    // Personal recommendations go first when we are allowed to personalise.
    const recommended = await this.recommendations(locale, userId, 12);
    if (recommended.length > 0) {
      resolved.unshift({
        id: 'recommendations',
        kind: 'PRODUCT_RAIL',
        title: RECOMMENDED_TITLE[locale],
        subtitle: null,
        ctaLabel: null,
        ctaHref: '/catalog',
        imageUrl: null,
        products: recommended,
      });
    }

    return { blocks: resolved };
  }

  private async fallbackHome(locale: Locale, wishlisted: Set<string>): Promise<HomeBlock[]> {
    const [newest, categories, brands] = await Promise.all([
      this.prisma.product.findMany({
        where: this.publishedWhere(),
        include: productCardInclude,
        orderBy: { publishedAt: 'desc' },
        take: 12,
      }),
      this.rootCategories(locale),
      this.featuredBrands(locale, 12),
    ]);

    const blocks: HomeBlock[] = [
      {
        id: 'fallback-ai',
        kind: 'AI_PROMPT',
        title: AI_BLOCK_TITLE[locale],
        subtitle: AI_BLOCK_SUBTITLE[locale],
        ctaLabel: null,
        ctaHref: '/stylist',
        imageUrl: null,
        prompts: INTENT_EXAMPLES[locale],
      },
    ];
    if (categories.length > 0) {
      blocks.push({
        id: 'fallback-categories',
        kind: 'CATEGORY_GRID',
        title: CATEGORIES_TITLE[locale],
        subtitle: null,
        ctaLabel: null,
        ctaHref: null,
        imageUrl: null,
        categories,
      });
    }
    if (newest.length > 0) {
      blocks.push({
        id: 'fallback-new',
        kind: 'PRODUCT_RAIL',
        title: NEW_TITLE[locale],
        subtitle: null,
        ctaLabel: null,
        ctaHref: '/catalog?sort=newest',
        imageUrl: null,
        products: newest.map((row) =>
          mapProductCard(row, { locale, wishlistedProductIds: wishlisted }),
        ),
      });
    }
    if (brands.length > 0) {
      blocks.push({
        id: 'fallback-brands',
        kind: 'BRAND_RAIL',
        title: BRANDS_TITLE[locale],
        subtitle: null,
        ctaLabel: null,
        ctaHref: '/brands',
        imageUrl: null,
        brands,
      });
    }
    return blocks;
  }

  private async productsForRail(
    config: Record<string, unknown>,
    locale: Locale,
    wishlisted: Set<string>,
    saleOnly: boolean,
  ): Promise<ProductCard[]> {
    const limit = Math.min((config.limit as number) ?? 12, 24);
    const where: Prisma.ProductWhereInput = { ...this.publishedWhere() };

    if (typeof config.collectionSlug === 'string') {
      where.collectionItems = { some: { collection: { slug: config.collectionSlug } } };
    }
    if (Array.isArray(config.productIds) && config.productIds.length > 0) {
      where.id = { in: config.productIds as string[] };
    }
    if (typeof config.categorySlug === 'string') {
      where.category = { slug: config.categorySlug };
    }
    if (Array.isArray(config.styleTags) && config.styleTags.length > 0) {
      where.styleTags = { hasSome: config.styleTags as string[] };
    }
    if (saleOnly) {
      where.skus = { some: { isActive: true, compareAtMinor: { not: null } } };
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput =
      config.sort === 'newest' ? { publishedAt: 'desc' } : { popularityScore: 'desc' };

    const rows = await this.prisma.product.findMany({
      where,
      include: productCardInclude,
      orderBy,
      take: limit,
    });
    return rows
      .map((row) => mapProductCard(row, { locale, wishlistedProductIds: wishlisted }))
      .filter((card) => card.inStock || config.allowOutOfStock === true);
  }

  /**
   * Personal rail. With personalisation off (USR-006) this returns the
   * popularity-ranked list instead of nothing, so the screen is never empty.
   */
  async recommendations(locale: Locale, userId: string | null, limit = 12): Promise<ProductCard[]> {
    const wishlisted = await this.wishlistedIds(userId);

    let styleTags: string[] = [];
    let colors: string[] = [];
    let brandIds: string[] = [];
    if (userId) {
      const [user, profile] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: userId }, select: { personalizationEnabled: true } }),
        this.prisma.styleProfile.findUnique({ where: { userId } }),
      ]);
      if (user?.personalizationEnabled && profile) {
        styleTags = profile.styles;
        colors = profile.colors;
        brandIds = profile.favouriteBrandIds;
      }
    }

    const hasSignal = styleTags.length > 0 || colors.length > 0 || brandIds.length > 0;
    const rows = await this.prisma.product.findMany({
      where: {
        ...this.publishedWhere(),
        skus: { some: { isActive: true, inventory: { onHand: { gt: 0 } } } },
        ...(hasSignal
          ? {
              OR: [
                ...(styleTags.length > 0 ? [{ styleTags: { hasSome: styleTags } }] : []),
                ...(colors.length > 0 ? [{ colorFamily: { in: colors } }] : []),
                ...(brandIds.length > 0 ? [{ brandId: { in: brandIds } }] : []),
              ],
            }
          : {}),
      },
      include: productCardInclude,
      orderBy: [{ popularityScore: 'desc' }, { publishedAt: 'desc' }],
      take: limit,
    });

    return rows.map((row) =>
      mapProductCard(row, { locale, wishlistedProductIds: wishlisted, aiPick: hasSignal }),
    );
  }

  // ────────────────────────────────────── categories, brands, collections

  async rootCategories(locale: Locale): Promise<CategorySummary[]> {
    const rows = await this.prisma.category.findMany({
      where: { isActive: true, parentId: null },
      orderBy: { sortOrder: 'asc' },
      include: { parent: { select: { slug: true } } },
    });
    const counts = await this.productCountsByCategory();
    return rows.map((row) => mapCategory(row, locale, counts.get(row.id) ?? 0));
  }

  async categoryTree(locale: Locale): Promise<Array<CategorySummary & { children: CategorySummary[] }>> {
    const rows = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: { parent: { select: { slug: true } } },
    });
    const counts = await this.productCountsByCategory();
    const roots = rows.filter((row) => !row.parentId);
    return roots.map((root) => ({
      ...mapCategory(root, locale, counts.get(root.id) ?? 0),
      children: rows
        .filter((row) => row.parentId === root.id)
        .map((child) => mapCategory(child, locale, counts.get(child.id) ?? 0)),
    }));
  }

  private async productCountsByCategory(): Promise<Map<string, number>> {
    const groups = await this.prisma.product.groupBy({
      by: ['categoryId'],
      where: this.publishedWhere(),
      _count: { _all: true },
    });
    const direct = new Map(groups.map((group) => [group.categoryId, group._count._all]));

    // Roll child counts up, so a parent tile shows the whole branch.
    const categories = await this.prisma.category.findMany({ select: { id: true, parentId: true } });
    for (const category of categories) {
      if (!category.parentId) continue;
      const own = direct.get(category.id) ?? 0;
      if (own === 0) continue;
      direct.set(category.parentId, (direct.get(category.parentId) ?? 0) + own);
    }
    return direct;
  }

  async featuredBrands(locale: Locale, limit = 20): Promise<BrandSummary[]> {
    void locale;
    const rows = await this.prisma.brand.findMany({
      where: { products: { some: this.publishedWhere() } },
      orderBy: [{ featured: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      take: limit,
      include: { _count: { select: { products: { where: this.publishedWhere() } } } },
    });
    return rows.map((row) => mapBrand(row, row._count.products));
  }

  async allBrands(): Promise<BrandSummary[]> {
    const rows = await this.prisma.brand.findMany({
      where: { products: { some: this.publishedWhere() } },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: { where: this.publishedWhere() } } } },
    });
    return rows.map((row) => mapBrand(row, row._count.products));
  }

  async brandBySlug(slug: string, locale: Locale) {
    const brand = await this.prisma.brand.findUnique({
      where: { slug },
      include: { _count: { select: { products: { where: this.publishedWhere() } } } },
    });
    if (!brand) throw AppError.notFound('Brand', slug);
    return {
      ...mapBrand(brand, brand._count.products),
      coverUrl: brand.coverUrl,
      description: brand.description,
      country: brand.country,
      locale,
    };
  }

  async collections(locale: Locale) {
    const now = new Date();
    const rows = await this.prisma.collection.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { items: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: pickLocalized({ ru: row.titleRu, uz: row.titleUz, en: row.titleEn }, locale),
      subtitle: pickLocalized({ ru: row.subtitleRu, uz: row.subtitleUz }, locale) || null,
      description: pickLocalized({ ru: row.descriptionRu, uz: row.descriptionUz }, locale) || null,
      coverUrl: row.coverUrl,
      itemCount: row._count.items,
      endsAt: row.endsAt?.toISOString() ?? null,
    }));
  }

  /** AI-010: curated looks, with sponsored placement marked. */
  async curatedLooks(locale: Locale, wishlisted: Set<string>, limit = 8) {
    const looks = await this.prisma.curatedOutfit.findMany({
      where: { isActive: true, items: { some: { product: this.publishedWhere() } } },
      orderBy: { sortOrder: 'asc' },
      take: limit,
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: { product: { include: productCardInclude } },
        },
      },
    });

    return looks.map((look) => {
      const products = look.items
        .filter((item) => item.product.lifecycle === 'PUBLISHED')
        .map((item) => mapProductCard(item.product, { locale, wishlistedProductIds: wishlisted }));
      return {
        id: look.id,
        slug: look.slug,
        title: pickLocalized({ ru: look.titleRu, uz: look.titleUz, en: look.titleEn }, locale),
        description: pickLocalized({ ru: look.descriptionRu, uz: look.descriptionUz }, locale) || null,
        imageUrl: look.coverUrl,
        total: sum(products.map((product) => product.price)),
        itemCount: products.length,
        isSponsored: look.isSponsored,
        styleTags: look.styleTags as StyleTag[],
        products,
      };
    });
  }

  async curatedLook(idOrSlug: string, locale: Locale, userId: string | null) {
    const wishlisted = await this.wishlistedIds(userId);
    const look = await this.prisma.curatedOutfit.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: { product: { include: productCardInclude }, sku: true },
        },
      },
    });
    if (!look) throw AppError.notFound('CuratedOutfit', idOrSlug);

    const items = look.items
      .filter((item) => item.product.lifecycle === 'PUBLISHED')
      .map((item) => ({
        slot: item.slot,
        skuId: item.skuId,
        sizeLabel: item.sku?.sizeLabel ?? null,
        product: mapProductCard(item.product, { locale, wishlistedProductIds: wishlisted }),
      }));

    return {
      id: look.id,
      slug: look.slug,
      title: pickLocalized({ ru: look.titleRu, uz: look.titleUz, en: look.titleEn }, locale),
      description: pickLocalized({ ru: look.descriptionRu, uz: look.descriptionUz }, locale) || null,
      imageUrl: look.coverUrl,
      isSponsored: look.isSponsored,
      styleTags: look.styleTags as StyleTag[],
      occasions: look.occasions as Occasion[],
      total: sum(items.map((item) => item.product.price)),
      items,
    };
  }

  // ─────────────────────────────────────────────────────── PDP (BUY-005)

  async productDetail(
    idOrSlug: string,
    locale: Locale,
    userId: string | null,
  ): Promise<ProductDetail> {
    const product = await this.prisma.product.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
        lifecycle: 'PUBLISHED',
        archivedAt: null,
      },
      include: {
        brand: true,
        seller: true,
        category: true,
        sizeChart: true,
        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        skus: { where: { isActive: true }, include: { inventory: true }, orderBy: { sizeOrder: 'asc' } },
      },
    });
    if (!product) throw AppError.notFound('Product', idOrSlug);

    // Counting a view is fire-and-forget: it must never slow or fail the PDP.
    void this.prisma.product
      .update({ where: { id: product.id }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined);

    const wishlisted = await this.wishlistedIds(userId);
    const card = mapProductCard(product, { locale, wishlistedProductIds: wishlisted });

    const [fit, delivery, returnPolicy, rating, related, completeTheLook, sizeChart] = await Promise.all([
      this.fit.recommendForProduct({ productId: product.id, userId }),
      this.delivery.estimateForProduct(product.sellerId, locale),
      this.delivery.returnPolicyForProduct(product.id, locale),
      this.productRating(product.id),
      this.relatedProducts(product, locale, wishlisted),
      this.completeTheLook(product, locale, wishlisted),
      this.resolveSizeChart(product),
    ]);

    const skus = product.skus
      .slice()
      .sort((a, b) => sizeSortKey(a.sizeLabel) - sizeSortKey(b.sizeLabel))
      .map((sku) => ({
        ...mapSku(sku),
        colorFamily: product.colorFamily as ColorFamily,
        colorName: sku.colorName || product.colorName,
      }));

    return {
      ...card,
      rating,
      description: pickLocalized(
        { ru: product.descriptionRu, uz: product.descriptionUz, en: product.descriptionEn },
        locale,
      ),
      seller: mapSeller(product.seller),
      composition: pickLocalized({ ru: product.compositionRu, uz: product.compositionUz }, locale),
      care: pickLocalized({ ru: product.careRu, uz: product.careUz }, locale),
      countryOfOrigin: product.countryOfOrigin,
      media: product.media.map((item) => mapMedia(item, locale)),
      skus,
      sizeChart,
      fitNotes: product.fitNotes,
      silhouette: (product.silhouette as Silhouette) ?? null,
      formality: product.formality as ProductDetail['formality'],
      warmth: product.warmth as ProductDetail['warmth'],
      season: product.season as Season,
      occasions: product.occasions as Occasion[],
      materials: product.materials,
      delivery,
      returnPolicy,
      authenticity: product.authenticityNote,
      fit,
      relatedProductIds: related.map((item) => item.id),
      completeTheLook,
    };
  }

  private async resolveSizeChart(product: {
    sizeChart: Parameters<typeof mapSizeChart>[0];
    brandId: string;
    categoryId: string;
    category: { slug: string };
  }) {
    if (product.sizeChart) return mapSizeChart(product.sizeChart, product.category.slug);
    const chart = await this.prisma.sizeChart.findFirst({
      where: {
        OR: [
          { brandId: product.brandId, categoryId: product.categoryId },
          { brandId: null, categoryId: product.categoryId },
          { brandId: product.brandId, categoryId: null },
        ],
      },
      orderBy: [{ brandId: 'desc' }, { categoryId: 'desc' }],
    });
    return mapSizeChart(chart, product.category.slug);
  }

  /**
   * BUY-005 acceptance criterion: "нельзя купить SKU без обязательных данных".
   * Called by cart add and by checkout, so an incomplete product cannot be
   * bought even if a stale client has its id.
   */
  async assertPurchasable(skuId: string): Promise<void> {
    const sku = await this.prisma.sku.findUnique({
      where: { id: skuId },
      include: {
        product: {
          include: {
            brand: { select: { id: true } },
            seller: { select: { onboardingStatus: true, suspendedAt: true } },
            media: { select: { id: true, role: true }, take: 1 },
          },
        },
      },
    });
    if (!sku) throw AppError.notFound('Sku', skuId);

    const problems: string[] = [];
    if (!sku.isActive) problems.push('sku_inactive');
    if (sku.product.lifecycle !== 'PUBLISHED') problems.push('product_not_published');
    if (sku.product.archivedAt) problems.push('product_archived');
    if (sku.product.seller.onboardingStatus !== 'ACTIVE') problems.push('seller_inactive');
    if (sku.product.seller.suspendedAt) problems.push('seller_suspended');
    if (sku.priceMinor <= 0n) problems.push('price_missing');
    if (sku.product.media.length === 0) problems.push('media_missing');
    if (!sku.product.compositionRu.trim()) problems.push('composition_missing');
    if (!sku.sizeLabel.trim()) problems.push('size_missing');

    if (problems.length > 0) {
      throw AppError.validation('This item cannot be purchased', { skuId, problems });
    }
  }

  private async relatedProducts(
    product: { id: string; categoryId: string; styleTags: string[]; colorFamily: string },
    locale: Locale,
    wishlisted: Set<string>,
  ): Promise<ProductCard[]> {
    const rows = await this.prisma.product.findMany({
      where: {
        ...this.publishedWhere(),
        id: { not: product.id },
        OR: [
          { categoryId: product.categoryId },
          { styleTags: { hasSome: product.styleTags } },
        ],
        skus: { some: { isActive: true, inventory: { onHand: { gt: 0 } } } },
      },
      include: productCardInclude,
      orderBy: { popularityScore: 'desc' },
      take: 12,
    });
    return rows.map((row) => mapProductCard(row, { locale, wishlistedProductIds: wishlisted }));
  }

  /**
   * BUY-008 "complete the look": items from *other* slots that are compatible,
   * which is also how a shopper discovers a second brand.
   */
  private async completeTheLook(
    product: { id: string; categoryId: string; styleTags: string[]; formality: number; season: string; category: { slot: string | null } },
    locale: Locale,
    wishlisted: Set<string>,
  ): Promise<ProductCard[]> {
    const ownSlot = product.category.slot;
    const rows = await this.prisma.product.findMany({
      where: {
        ...this.publishedWhere(),
        id: { not: product.id },
        ...(ownSlot ? { category: { slot: { not: ownSlot as never } } } : {}),
        styleTags: { hasSome: product.styleTags.length > 0 ? product.styleTags : ['minimal'] },
        formality: { gte: Math.max(1, product.formality - 1), lte: Math.min(5, product.formality + 1) },
        OR: [{ season: product.season }, { season: 'ALL_SEASON' }],
        skus: { some: { isActive: true, inventory: { onHand: { gt: 0 } } } },
      },
      include: productCardInclude,
      orderBy: { popularityScore: 'desc' },
      take: 8,
    });
    return rows.map((row) =>
      mapProductCard(row, { locale, wishlistedProductIds: wishlisted, aiPick: true }),
    );
  }

  // ──────────────────────────────────────────────── wishlist (BUY-007)

  async wishlist(userId: string, locale: Locale): Promise<ProductCard[]> {
    const items = await this.prisma.wishlistItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { product: { include: productCardInclude } },
    });
    const wishlisted = new Set(items.map((item) => item.productId));
    return items
      .filter((item) => item.product.lifecycle === 'PUBLISHED')
      .map((item) => mapProductCard(item.product, { locale, wishlistedProductIds: wishlisted }));
  }

  async addToWishlist(userId: string, productId: string, skuId?: string | null): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, lifecycle: 'PUBLISHED' },
      select: { id: true },
    });
    if (!product) throw AppError.notFound('Product', productId);
    await this.prisma.wishlistItem
      .create({ data: { userId, productId, skuId: skuId ?? null } })
      .catch((error) => {
        // Already there: tapping the heart twice should be idempotent.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
        throw error;
      });
  }

  async removeFromWishlist(userId: string, productId: string): Promise<void> {
    await this.prisma.wishlistItem.deleteMany({ where: { userId, productId } });
  }

  /** NTF-003: back-in-stock / price-drop subscription for a specific size. */
  async subscribeToSku(
    userId: string,
    skuId: string,
    options: { backInStock?: boolean; priceDrop?: boolean; priceThresholdMinor?: bigint | null },
  ): Promise<void> {
    const sku = await this.prisma.sku.findUnique({ where: { id: skuId }, select: { id: true } });
    if (!sku) throw AppError.notFound('Sku', skuId);
    await this.prisma.stockSubscription.upsert({
      where: { userId_skuId: { userId, skuId } },
      create: {
        userId,
        skuId,
        wantsBackInStock: options.backInStock ?? true,
        wantsPriceDrop: options.priceDrop ?? false,
        priceThresholdMinor: options.priceThresholdMinor ?? null,
      },
      update: {
        wantsBackInStock: options.backInStock ?? undefined,
        wantsPriceDrop: options.priceDrop ?? undefined,
        priceThresholdMinor: options.priceThresholdMinor ?? undefined,
        notifiedAt: null,
      },
    });
  }

  async unsubscribeFromSku(userId: string, skuId: string): Promise<void> {
    await this.prisma.stockSubscription.deleteMany({ where: { userId, skuId } });
  }

  // ───────────────────────────────────────────────── reviews (BUY-009)

  async productReviews(productId: string, limit = 20) {
    const reviews = await this.prisma.review.findMany({
      where: { productId, status: 'APPROVED' },
      orderBy: [{ helpfulCount: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      include: { user: { select: { firstName: true } } },
    });
    return reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      title: review.title,
      body: review.body,
      fitVerdict: review.fitVerdict,
      // BUY-009: no PII in a public review — a first name only.
      authorName: review.user.firstName ?? 'Покупатель',
      verifiedPurchase: review.verifiedPurchase,
      createdAt: review.createdAt.toISOString(),
      helpfulCount: review.helpfulCount,
    }));
  }

  async productRating(productId: string): Promise<{ average: number; count: number } | null> {
    const aggregate = await this.prisma.review.aggregate({
      where: { productId, status: 'APPROVED' },
      _avg: { rating: true },
      _count: { _all: true },
    });
    if (aggregate._count._all === 0) return null;
    return {
      average: Number((aggregate._avg.rating ?? 0).toFixed(2)),
      count: aggregate._count._all,
    };
  }

  /** Reviews enter moderation; they do not appear until approved (BUY-009). */
  async submitReview(
    userId: string,
    input: {
      productId: string;
      rating: number;
      title?: string | null;
      body: string;
      fitVerdict?: 'RUNS_SMALL' | 'TRUE_TO_SIZE' | 'RUNS_LARGE' | null;
      orderItemId?: string | null;
    },
  ): Promise<{ id: string; status: string }> {
    const verified = input.orderItemId
      ? Boolean(
          await this.prisma.orderItem.findFirst({
            where: {
              id: input.orderItemId,
              productId: input.productId,
              order: { userId },
              subOrder: { status: { in: ['DELIVERED', 'COMPLETED'] } },
            },
            select: { id: true },
          }),
        )
      : false;

    const review = await this.prisma.review.upsert({
      where: {
        userId_productId_orderItemId: {
          userId,
          productId: input.productId,
          orderItemId: input.orderItemId ?? '',
        },
      },
      create: {
        userId,
        productId: input.productId,
        orderItemId: input.orderItemId ?? null,
        rating: Math.max(1, Math.min(5, Math.round(input.rating))),
        title: input.title?.slice(0, 120) ?? null,
        body: input.body.slice(0, 4000),
        fitVerdict: input.fitVerdict ?? null,
        verifiedPurchase: verified,
        status: 'PENDING',
      },
      update: {
        rating: Math.max(1, Math.min(5, Math.round(input.rating))),
        title: input.title?.slice(0, 120) ?? null,
        body: input.body.slice(0, 4000),
        fitVerdict: input.fitVerdict ?? null,
        status: 'PENDING',
      },
    });
    return { id: review.id, status: review.status };
  }

  // ───────────────────────────────────────────────────────── helpers

  async wishlistedIds(userId: string | null | undefined): Promise<Set<string>> {
    if (!userId) return new Set();
    const rows = await this.prisma.wishlistItem.findMany({
      where: { userId },
      select: { productId: true },
    });
    return new Set(rows.map((row) => row.productId));
  }

  /** Legal and FAQ pages served to the Mini App (CNT-001). */
  async contentPage(slug: string, locale: Locale) {
    const page =
      (await this.prisma.contentPage.findUnique({ where: { slug_locale: { slug, locale } } })) ??
      (await this.prisma.contentPage.findFirst({ where: { slug, isPublished: true } }));
    if (!page || !page.isPublished) throw AppError.notFound('ContentPage', slug);
    return {
      slug: page.slug,
      locale: page.locale,
      title: page.title,
      body: page.body,
      updatedAt: page.updatedAt.toISOString(),
    };
  }

  async searchProducts(...args: Parameters<SearchService['search']>) {
    return this.search.search(...args);
  }
}

const RECOMMENDED_TITLE: Record<Locale, string> = {
  ru: 'Вам может подойти',
  uz: 'Sizga mos kelishi mumkin',
  en: 'Picked for you',
};
const NEW_TITLE: Record<Locale, string> = {
  ru: 'Новинки',
  uz: 'Yangi mahsulotlar',
  en: 'New in',
};
const BRANDS_TITLE: Record<Locale, string> = { ru: 'Бренды', uz: 'Brendlar', en: 'Brands' };
const CATEGORIES_TITLE: Record<Locale, string> = {
  ru: 'Категории',
  uz: 'Kategoriyalar',
  en: 'Categories',
};
const AI_BLOCK_TITLE: Record<Locale, string> = {
  ru: 'AI‑стилист соберёт образ',
  uz: 'AI stilist uslub yig‘ib beradi',
  en: 'Let the AI stylist build a look',
};
const AI_BLOCK_SUBTITLE: Record<Locale, string> = {
  ru: 'Опишите повод и бюджет — подберём вещи из наличия',
  uz: 'Tadbir va byudjetni yozing — mavjud buyumlardan tanlaymiz',
  en: 'Describe the occasion and budget — we pick from what is in stock',
};

export { discountPercent, nullableMoney, toMoney, availableUnits };
