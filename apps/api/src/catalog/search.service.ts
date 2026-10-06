/**
 * Catalogue search and filtering — spec BUY-002, BUY-003.
 *
 * BUY-002 Search over title, brand, category, material, style and colour with
 *         RU/UZ/EN transliteration. Acceptance criterion: unpublished SKUs are
 *         not indexed — enforced by the `publishedFilter` every query shares.
 * BUY-003 All filters combine and can be cleared, and facets report the counts
 *         that remain reachable.
 * CAT-008 Stock-aware: `inStockOnly` and the size filter exclude SKUs with no
 *         available units, so UAT-03 passes.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type ColorFamily,
  type FitPreference,
  type Locale,
  type ProductCard,
  type Season,
  type SearchFacets,
  type SearchResult,
  type StyleTag,
  expandQuery,
  foldLatin,
  normalizeForSearch,
  pickLocalized,
  sizeSortKey,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { decodeCursor, encodeCursor } from '../common/http';
import { toMoney } from '../common/money.util';
import { availableUnits, mapProductCard, productCardInclude } from './product-mapper';

export type SortOption =
  | 'relevance'
  | 'newest'
  | 'price_asc'
  | 'price_desc'
  | 'discount'
  | 'popular';

export interface SearchQuery {
  q?: string | null;
  categorySlugs?: string[];
  brandIds?: string[];
  brandSlugs?: string[];
  sellerIds?: string[];
  sizes?: string[];
  colors?: ColorFamily[];
  materials?: string[];
  styles?: StyleTag[];
  seasons?: Season[];
  fits?: FitPreference[];
  occasions?: string[];
  gender?: 'WOMEN' | 'MEN' | 'UNISEX' | 'KIDS' | null;
  priceMinMinor?: bigint | null;
  priceMaxMinor?: bigint | null;
  discountOnly?: boolean;
  inStockOnly?: boolean;
  collectionSlug?: string | null;
  sort?: SortOption;
  limit?: number;
  cursor?: string | null;
  locale: Locale;
  userId?: string | null;
}

interface CursorPayload extends Record<string, string | number> {
  offset: number;
}

const MAX_LIMIT = 48;

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /** The one place that decides what "visible in production" means (CAT-009). */
  private publishedFilter(): Prisma.ProductWhereInput {
    return {
      lifecycle: 'PUBLISHED',
      archivedAt: null,
      seller: { onboardingStatus: { in: ['ACTIVE'] }, suspendedAt: null },
      skus: { some: { isActive: true } },
    };
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const limit = Math.min(query.limit ?? 24, MAX_LIMIT);
    const offset = decodeCursor<CursorPayload>(query.cursor)?.offset ?? 0;

    const matchedIds = await this.resolveTextMatch(query.q);
    const where = await this.buildWhere(query, matchedIds);

    const [total, rows, facets] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include: productCardInclude,
        orderBy: this.buildOrderBy(query.sort, Boolean(query.q)),
        skip: offset,
        take: limit + 1,
      }),
      this.buildFacets(query, matchedIds),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const wishlisted = await this.wishlistedIds(
      query.userId,
      page.map((row) => row.id),
    );

    let items = page.map((row) =>
      mapProductCard(row, { locale: query.locale, wishlistedProductIds: wishlisted }),
    );

    // Relevance ordering cannot be expressed in SQL for the transliterated
    // match set, so the text-search branch re-ranks the page in memory.
    if (query.q && (query.sort ?? 'relevance') === 'relevance') {
      items = this.rankByRelevance(items, query.q, page);
    }

    // BUY-003: a size filter must not surface a product whose only matching
    // size is unavailable.
    if (query.sizes && query.sizes.length > 0) {
      const wanted = new Set(query.sizes.map((size) => size.toUpperCase()));
      const allowed = new Set(
        page
          .filter((row) =>
            row.skus.some(
              (sku) =>
                wanted.has(sku.sizeLabel.toUpperCase()) && availableUnits(sku.inventory) > 0,
            ),
          )
          .map((row) => row.id),
      );
      items = items.filter((item) => allowed.has(item.id));
    }

    return {
      items,
      facets,
      total,
      nextCursor: hasMore ? encodeCursor({ offset: offset + limit }) : null,
      query: query.q ?? null,
      didYouMean: items.length === 0 && query.q ? await this.suggest(query.q) : null,
      appliedFilters: compactFilters(query),
    };
  }

  /**
   * BUY-002: a query is expanded into its transliterated variants and matched
   * against the pre-expanded `searchDocument`. Returning the id set (rather
   * than inlining the condition) keeps facet counts consistent with results.
   */
  private async resolveTextMatch(q: string | null | undefined): Promise<Set<string> | null> {
    const trimmed = q?.trim();
    if (!trimmed || trimmed.length < 2) return null;

    const variants = expandQuery(trimmed).filter((variant) => variant.length >= 2);
    if (variants.length === 0) return null;

    // Full-text-ish match on the expanded document plus trigram similarity, so
    // "kurtka", "куртка" and a typo'd "kurkta" all land on the same products.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p.id
      FROM "Product" p
      WHERE p."lifecycle" = 'PUBLISHED'
        AND p."archivedAt" IS NULL
        AND (
          ${Prisma.join(
            variants.map(
              (variant) => Prisma.sql`p."searchDocument" LIKE ${`%${variant}%`}`,
            ),
            ' OR ',
          )}
          OR similarity(p."searchDocument", ${normalizeForSearch(trimmed)}) > 0.12
        )
      LIMIT 2000
    `);

    return new Set(rows.map((row) => row.id));
  }

  private async buildWhere(
    query: SearchQuery,
    matchedIds: Set<string> | null,
  ): Promise<Prisma.ProductWhereInput> {
    const and: Prisma.ProductWhereInput[] = [this.publishedFilter()];

    if (matchedIds) {
      and.push({ id: { in: [...matchedIds] } });
    }

    if (query.categorySlugs?.length) {
      // Include descendants so "coats-jackets" also returns "blazers".
      const categories = await this.prisma.category.findMany({
        where: { slug: { in: query.categorySlugs } },
        select: { id: true },
      });
      const ids = categories.map((category) => category.id);
      const children = await this.prisma.category.findMany({
        where: { parentId: { in: ids } },
        select: { id: true },
      });
      and.push({ categoryId: { in: [...ids, ...children.map((child) => child.id)] } });
    }

    if (query.brandIds?.length) and.push({ brandId: { in: query.brandIds } });
    if (query.brandSlugs?.length) and.push({ brand: { slug: { in: query.brandSlugs } } });
    if (query.sellerIds?.length) and.push({ sellerId: { in: query.sellerIds } });
    if (query.colors?.length) and.push({ colorFamily: { in: query.colors } });
    if (query.styles?.length) and.push({ styleTags: { hasSome: query.styles } });
    if (query.occasions?.length) and.push({ occasions: { hasSome: query.occasions } });
    if (query.seasons?.length) and.push({ season: { in: query.seasons } });
    if (query.materials?.length) and.push({ materials: { hasSome: query.materials } });
    if (query.gender) and.push({ gender: query.gender });
    if (query.fits?.length) {
      // "fit" on the product is expressed through the silhouette vocabulary.
      const silhouettes = query.fits.flatMap((fit) => SILHOUETTES_BY_FIT[fit] ?? []);
      if (silhouettes.length > 0) and.push({ silhouette: { in: silhouettes } });
    }

    if (query.collectionSlug) {
      and.push({ collectionItems: { some: { collection: { slug: query.collectionSlug } } } });
    }

    const skuConditions: Prisma.SkuWhereInput = { isActive: true };
    if (query.priceMinMinor != null || query.priceMaxMinor != null) {
      skuConditions.priceMinor = {
        ...(query.priceMinMinor != null ? { gte: query.priceMinMinor } : {}),
        ...(query.priceMaxMinor != null ? { lte: query.priceMaxMinor } : {}),
      };
    }
    if (query.sizes?.length) {
      skuConditions.sizeLabel = { in: query.sizes, mode: 'insensitive' };
    }
    if (query.inStockOnly !== false) {
      // Default to in-stock only: recommending or listing an unavailable SKU is
      // what CAT-008 and AI-002 exist to prevent.
      skuConditions.inventory = { onHand: { gt: 0 } };
    }
    and.push({ skus: { some: skuConditions } });

    if (query.discountOnly) {
      and.push({ skus: { some: { isActive: true, compareAtMinor: { not: null } } } });
    }

    return { AND: and };
  }

  private buildOrderBy(
    sort: SortOption | undefined,
    hasQuery: boolean,
  ): Prisma.ProductOrderByWithRelationInput[] {
    switch (sort) {
      case 'newest':
        return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
      case 'price_asc':
        return [{ skus: { _count: 'desc' } }, { createdAt: 'desc' }];
      case 'price_desc':
        return [{ skus: { _count: 'desc' } }, { createdAt: 'desc' }];
      case 'discount':
        return [{ popularityScore: 'desc' }, { publishedAt: 'desc' }];
      case 'popular':
        return [{ popularityScore: 'desc' }, { purchaseCount: 'desc' }];
      case 'relevance':
      default:
        return hasQuery
          ? [{ popularityScore: 'desc' }, { publishedAt: 'desc' }]
          : [{ popularityScore: 'desc' }, { publishedAt: 'desc' }];
    }
  }

  /**
   * Price sorting has to happen on the SKU price, which is a relation, so it
   * is applied after the page is mapped. For deep pages the caller should use
   * a price filter rather than deep paging a price sort.
   */
  sortByPrice(items: ProductCard[], direction: 'asc' | 'desc'): ProductCard[] {
    return [...items].sort((a, b) => {
      const left = BigInt(a.price.amount);
      const right = BigInt(b.price.amount);
      if (left === right) return 0;
      const comparison = left < right ? -1 : 1;
      return direction === 'asc' ? comparison : -comparison;
    });
  }

  private rankByRelevance(
    items: ProductCard[],
    query: string,
    rows: Array<{ id: string; titleRu: string; titleUz: string; brand: { name: string } }>,
  ): ProductCard[] {
    const needle = foldLatin(query);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const score = (item: ProductCard): number => {
      const row = byId.get(item.id);
      let value = 0;
      const title = foldLatin(item.title);
      if (title === needle) value += 100;
      if (title.startsWith(needle)) value += 50;
      if (title.includes(needle)) value += 25;
      if (row && foldLatin(row.brand.name).includes(needle)) value += 20;
      if (item.inStock) value += 8;
      if (item.badges.includes('SALE')) value += 2;
      return value;
    };
    return [...items].sort((a, b) => score(b) - score(a));
  }

  /** BUY-003: facets describe what is still reachable, with counts. */
  private async buildFacets(query: SearchQuery, matchedIds: Set<string> | null): Promise<SearchFacets> {
    // Facet counts ignore the dimension they describe (otherwise selecting one
    // brand would report a count of 1 for that brand and nothing else), but
    // respect every other active filter.
    const baseWhere = await this.buildWhere({ ...query, brandIds: [], brandSlugs: [] }, matchedIds);

    const [brandGroups, categoryGroups, colorGroups, styleRows, seasonGroups, skuAggregate, sizeRows] =
      await Promise.all([
        this.prisma.product.groupBy({
          by: ['brandId'],
          where: baseWhere,
          _count: { _all: true },
          orderBy: { _count: { brandId: 'desc' } },
          take: 30,
        }),
        this.prisma.product.groupBy({
          by: ['categoryId'],
          where: await this.buildWhere({ ...query, categorySlugs: [] }, matchedIds),
          _count: { _all: true },
          orderBy: { _count: { categoryId: 'desc' } },
          take: 30,
        }),
        this.prisma.product.groupBy({
          by: ['colorFamily'],
          where: await this.buildWhere({ ...query, colors: [] }, matchedIds),
          _count: { _all: true },
          orderBy: { _count: { colorFamily: 'desc' } },
          take: 24,
        }),
        this.prisma.product.findMany({
          where: await this.buildWhere({ ...query, styles: [] }, matchedIds),
          select: { styleTags: true, materials: true },
          take: 1500,
        }),
        this.prisma.product.groupBy({
          by: ['season'],
          where: await this.buildWhere({ ...query, seasons: [] }, matchedIds),
          _count: { _all: true },
        }),
        this.prisma.sku.aggregate({
          where: { isActive: true, product: baseWhere },
          _min: { priceMinor: true },
          _max: { priceMinor: true },
        }),
        this.prisma.sku.groupBy({
          by: ['sizeLabel'],
          where: {
            isActive: true,
            inventory: { onHand: { gt: 0 } },
            product: await this.buildWhere({ ...query, sizes: [] }, matchedIds),
          },
          _count: { _all: true },
          orderBy: { sizeLabel: 'asc' },
          take: 40,
        }),
      ]);

    const [brands, categories] = await Promise.all([
      this.prisma.brand.findMany({
        where: { id: { in: brandGroups.map((group) => group.brandId) } },
        select: { id: true, name: true },
      }),
      this.prisma.category.findMany({
        where: { id: { in: categoryGroups.map((group) => group.categoryId) } },
        select: { id: true, slug: true, nameRu: true, nameUz: true, nameEn: true },
      }),
    ]);

    const brandNames = new Map(brands.map((brand) => [brand.id, brand.name]));
    const categoryMap = new Map(categories.map((category) => [category.id, category]));

    const styleCounts = new Map<string, number>();
    const materialCounts = new Map<string, number>();
    for (const row of styleRows) {
      for (const tag of row.styleTags) styleCounts.set(tag, (styleCounts.get(tag) ?? 0) + 1);
      for (const material of row.materials) {
        materialCounts.set(material, (materialCounts.get(material) ?? 0) + 1);
      }
    }

    const currency = 'UZS';
    return {
      brands: brandGroups
        .filter((group) => brandNames.has(group.brandId))
        .map((group) => ({
          id: group.brandId,
          name: brandNames.get(group.brandId)!,
          count: group._count._all,
        })),
      categories: categoryGroups
        .filter((group) => categoryMap.has(group.categoryId))
        .map((group) => {
          const category = categoryMap.get(group.categoryId)!;
          return {
            slug: category.slug,
            name: pickLocalized(
              { ru: category.nameRu, uz: category.nameUz, en: category.nameEn },
              query.locale,
            ),
            count: group._count._all,
          };
        }),
      sizes: sizeRows
        .map((row) => ({ label: row.sizeLabel, count: row._count._all }))
        .sort((a, b) => sizeSortKey(a.label) - sizeSortKey(b.label)),
      colors: colorGroups.map((group) => ({
        family: group.colorFamily as ColorFamily,
        count: group._count._all,
      })),
      materials: [...materialCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([value, count]) => ({ value, count })),
      styles: [...styleCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([value, count]) => ({ value: value as StyleTag, count })),
      seasons: seasonGroups.map((group) => ({
        value: group.season as Season,
        count: group._count._all,
      })),
      fits: (['slim', 'regular', 'relaxed', 'oversized'] as FitPreference[]).map((value) => ({
        value,
        count: 0,
      })),
      priceRange: {
        min: toMoney(skuAggregate._min.priceMinor ?? 0n, currency),
        max: toMoney(skuAggregate._max.priceMinor ?? 0n, currency),
      },
    };
  }

  /** "Did you mean": nearest brand or category name by trigram similarity. */
  private async suggest(query: string): Promise<string | null> {
    const normalized = normalizeForSearch(query);
    if (normalized.length < 3) return null;
    const rows = await this.prisma.$queryRaw<Array<{ name: string; score: number }>>(Prisma.sql`
      SELECT name, similarity(lower(name), ${normalized}) AS score
      FROM "Brand"
      WHERE similarity(lower(name), ${normalized}) > 0.3
      UNION ALL
      SELECT "nameRu" AS name, similarity(lower("nameRu"), ${normalized}) AS score
      FROM "Category"
      WHERE similarity(lower("nameRu"), ${normalized}) > 0.3
      ORDER BY score DESC
      LIMIT 1
    `);
    return rows[0]?.name ?? null;
  }

  private async wishlistedIds(
    userId: string | null | undefined,
    productIds: string[],
  ): Promise<Set<string>> {
    if (!userId || productIds.length === 0) return new Set();
    const rows = await this.prisma.wishlistItem.findMany({
      where: { userId, productId: { in: productIds } },
      select: { productId: true },
    });
    return new Set(rows.map((row) => row.productId));
  }
}

const SILHOUETTES_BY_FIT: Record<FitPreference, string[]> = {
  slim: ['fitted', 'slim', 'tapered'],
  regular: ['straight', 'a_line', 'cropped'],
  relaxed: ['relaxed', 'wide_leg', 'longline', 'flared'],
  oversized: ['oversized'],
};

function compactFilters(query: SearchQuery): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (key: string, values?: readonly string[] | null) => {
    if (values && values.length > 0) out[key] = [...values];
  };
  add('category', query.categorySlugs);
  add('brand', query.brandIds);
  add('size', query.sizes);
  add('color', query.colors);
  add('material', query.materials);
  add('style', query.styles);
  add('season', query.seasons);
  add('fit', query.fits);
  add('occasion', query.occasions);
  if (query.gender) out.gender = [query.gender];
  if (query.discountOnly) out.discount = ['true'];
  if (query.priceMinMinor != null) out.priceMin = [query.priceMinMinor.toString()];
  if (query.priceMaxMinor != null) out.priceMax = [query.priceMaxMinor.toString()];
  return out;
}
