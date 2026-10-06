/**
 * Catalogue row -> transport DTO mapping.
 *
 * BUY-004 "цена/наличие актуальны": availability is always derived from
 * inventory at read time, never cached on the product row.
 * CAT-005: every price becomes a `Money` object, never a float.
 */

import { Prisma } from '@prisma/client';
import {
  type BrandSummary,
  type CategorySummary,
  type ColorFamily,
  type MediaRef,
  type Locale,
  type ProductCard,
  type SellerSummary,
  type SizeChart,
  type SkuDetail,
  type StyleTag,
  pickLocalized,
  sizeSortKey,
} from '@fashion/core';
import { discountPercent, nullableMoney, toMoney } from '../common/money.util';

/**
 * Everything the card needs, in one Prisma include.
 *
 * Declared through Prisma.validator rather than `as const` so the object stays
 * mutable (Prisma rejects readonly orderBy tuples) while still being checked
 * against the schema and usable for payload inference.
 */
export const productCardInclude = Prisma.validator<Prisma.ProductInclude>()({
  brand: true,
  seller: true,
  category: true,
  media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 6 },
  skus: {
    where: { isActive: true },
    include: { inventory: true },
    orderBy: { sizeOrder: 'asc' },
  },
});

type BrandRow = {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  verified: boolean;
};

type SellerRow = {
  id: string;
  displayName: string;
  legalName: string;
  verified: boolean;
  qualityScore: number | null;
  handlingDays: number;
};

type MediaRow = {
  id: string;
  url: string;
  kind: string;
  role: string;
  altRu: string;
  altUz: string;
  altEn: string | null;
  width: number | null;
  height: number | null;
  placeholder: string | null;
};

type SkuRow = {
  id: string;
  sizeLabel: string;
  sizeOrder: number;
  colorName: string;
  priceMinor: bigint;
  compareAtMinor: bigint | null;
  currency: string;
  barcode: string | null;
  sellerSku: string | null;
  measurements: unknown;
  inventory: { onHand: number; reserved: number; safetyStock: number; lowStockThreshold: number } | null;
};

type ProductRow = {
  id: string;
  slug: string;
  titleRu: string;
  titleUz: string;
  titleEn: string | null;
  colorName: string;
  colorFamily: string;
  styleTags: string[];
  categoryId: string;
  publishedAt: Date | null;
  popularityScore: number;
  brand: BrandRow;
  seller: SellerRow;
  category: { slug: string } | null;
  media: MediaRow[];
  skus: SkuRow[];
};

/** CAT-007: available = on hand − reserved − safety stock, floored at zero. */
export function availableUnits(
  inventory: { onHand: number; reserved: number; safetyStock: number } | null | undefined,
): number {
  if (!inventory) return 0;
  return Math.max(0, inventory.onHand - inventory.reserved - inventory.safetyStock);
}

export function mapBrand(row: BrandRow, productCount?: number): BrandSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    logoUrl: row.logoUrl,
    verified: row.verified,
    ...(productCount !== undefined ? { productCount } : {}),
  };
}

export function mapSeller(row: SellerRow): SellerSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    legalName: row.legalName,
    verified: row.verified,
    qualityScore: row.qualityScore,
    handlingDays: row.handlingDays,
  };
}

export function mapCategory(
  row: {
    id: string;
    slug: string;
    nameRu: string;
    nameUz: string;
    nameEn: string | null;
    slot: string | null;
    imageUrl: string | null;
    parent?: { slug: string } | null;
  },
  locale: Locale,
  productCount?: number,
): CategorySummary {
  return {
    id: row.id,
    slug: row.slug,
    name: pickLocalized({ ru: row.nameRu, uz: row.nameUz, en: row.nameEn }, locale),
    parentSlug: row.parent?.slug ?? null,
    slot: (row.slot as CategorySummary['slot']) ?? null,
    imageUrl: row.imageUrl,
    ...(productCount !== undefined ? { productCount } : {}),
  };
}

export function mapMedia(row: MediaRow, locale: Locale): MediaRef {
  return {
    id: row.id,
    url: row.url,
    kind: row.kind as MediaRef['kind'],
    role: row.role as MediaRef['role'],
    // CAT-004: alt text is part of the media standard, so it is always present.
    alt: pickLocalized({ ru: row.altRu, uz: row.altUz, en: row.altEn }, locale),
    width: row.width,
    height: row.height,
    placeholder: row.placeholder,
  };
}

export function mapSku(row: SkuRow): SkuDetail {
  const available = availableUnits(row.inventory);
  return {
    id: row.id,
    sizeLabel: row.sizeLabel,
    colorName: row.colorName,
    colorFamily: 'black' as ColorFamily, // overwritten by the caller from the product
    price: toMoney(row.priceMinor, row.currency),
    compareAtPrice: nullableMoney(row.compareAtMinor, row.currency),
    available,
    barcode: row.barcode,
    sellerSku: row.sellerSku,
    measurements: (row.measurements as Record<string, number> | null) ?? null,
    lowStock: available > 0 && available <= (row.inventory?.lowStockThreshold ?? 2),
  };
}

export interface MapCardOptions {
  readonly locale: Locale;
  readonly wishlistedProductIds?: Set<string>;
  readonly aiPick?: boolean;
  readonly newWindowDays?: number;
}

export function mapProductCard(row: ProductRow, options: MapCardOptions): ProductCard {
  const { locale } = options;
  const activeSkus = row.skus.filter((sku) => availableUnits(sku.inventory) > 0);
  // The displayed price is the cheapest buyable size; if nothing is buyable we
  // still show the cheapest size so the card is not priceless.
  const priceSource = (activeSkus.length > 0 ? activeSkus : row.skus)
    .slice()
    .sort((a, b) => Number(a.priceMinor - b.priceMinor))[0];

  const currency = priceSource?.currency ?? 'UZS';
  const priceMinor = priceSource?.priceMinor ?? 0n;
  const compareAtMinor = priceSource?.compareAtMinor ?? null;
  const discount = discountPercent(priceMinor, compareAtMinor);

  const badges: ProductCard['badges'] = [];
  const newWindow = (options.newWindowDays ?? 30) * 86_400_000;
  if (row.publishedAt && Date.now() - row.publishedAt.getTime() < newWindow) badges.push('NEW');
  if (discount != null && discount >= 5) badges.push('SALE');
  const totalAvailable = activeSkus.reduce((acc, sku) => acc + availableUnits(sku.inventory), 0);
  if (totalAvailable > 0 && totalAvailable <= 3) badges.push('LAST_ITEMS');
  if (row.brand.verified) badges.push('VERIFIED_BRAND');
  if (options.aiPick) badges.push('AI_PICK');

  return {
    id: row.id,
    slug: row.slug,
    title: pickLocalized({ ru: row.titleRu, uz: row.titleUz, en: row.titleEn }, locale),
    brand: mapBrand(row.brand),
    price: toMoney(priceMinor, currency),
    compareAtPrice: nullableMoney(compareAtMinor, currency),
    discountPercent: discount,
    media: row.media.map((item) => mapMedia(item, locale)),
    colorFamily: row.colorFamily as ColorFamily,
    colorName: row.colorName,
    availableSizes: activeSkus
      .slice()
      .sort((a, b) => sizeSortKey(a.sizeLabel) - sizeSortKey(b.sizeLabel))
      .map((sku) => sku.sizeLabel),
    inStock: activeSkus.length > 0,
    isWishlisted: options.wishlistedProductIds?.has(row.id) ?? false,
    styleTags: row.styleTags as StyleTag[],
    categorySlug: row.category?.slug ?? '',
    badges,
    rating: null,
  };
}

export function mapSizeChart(
  row: {
    id: string;
    code: string;
    brandId: string | null;
    categoryId: string | null;
    system: string;
    rows: unknown;
    noteRu: string | null;
    noteUz: string | null;
    noteEn: string | null;
  } | null,
  categorySlug: string,
): SizeChart | null {
  if (!row) return null;
  return {
    id: row.id,
    brandId: row.brandId,
    categorySlug,
    system: row.system,
    rows: (row.rows as SizeChart['rows']) ?? [],
    note:
      row.noteRu || row.noteUz || row.noteEn
        ? { ru: row.noteRu ?? '', uz: row.noteUz ?? '', en: row.noteEn ?? '' }
        : null,
  };
}

export type { ProductRow, SkuRow, MediaRow };
