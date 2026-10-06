/**
 * Catalogue administration — spec §10 (ADM-003, ADM-004, ADM-011) and §5.
 *
 * ADM-003 Create a Product/SKU with variants, size chart, media, price, stock
 *         and seller, behind validation and a moderation workflow.
 * ADM-004 Bulk CSV/XLSX import with a dry run, an error report and an
 *         idempotent upsert — "ошибки не создают hidden partial chaos".
 * ADM-011 A locale-completeness indicator; a required locale cannot be
 *         published empty.
 * CAT-002/004/009 Required attributes, media standard and the publish gate.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type ProductLifecycle } from '@prisma/client';
import {
  type Locale,
  REQUIRED_LOCALES,
  assertTransition,
  buildSearchDocument,
  localeCompleteness,
  sizeSortKey,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { AuditService } from '../common/audit.service';
import type { AuthenticatedActor } from '../common/http';
import { InventoryService } from '../inventory/inventory.service';
import { toMoney } from '../common/money.util';

export interface ProductInput {
  sellerId: string;
  brandId: string;
  categoryId: string;
  slug?: string;
  externalId?: string | null;
  titleRu: string;
  titleUz: string;
  titleEn?: string | null;
  descriptionRu?: string;
  descriptionUz?: string;
  descriptionEn?: string | null;
  gender?: 'WOMEN' | 'MEN' | 'UNISEX' | 'KIDS';
  compositionRu?: string;
  compositionUz?: string;
  careRu?: string;
  careUz?: string;
  countryOfOrigin?: string | null;
  materials?: string[];
  colorName: string;
  colorFamily: string;
  colorHex?: string | null;
  styleTags?: string[];
  occasions?: string[];
  season?: string;
  silhouette?: string | null;
  formality?: number;
  warmth?: number;
  fitNotes?: string | null;
  sizeChartId?: string | null;
  returnPolicyId?: string | null;
  authenticityNote?: string | null;
  incompatibleSlots?: string[];
  incompatibleStyles?: string[];
  attributes?: Record<string, unknown>;
}

export interface SkuInput {
  id?: string;
  sellerSku?: string | null;
  barcode?: string | null;
  sizeLabel: string;
  colorName?: string | null;
  priceMinor: string;
  compareAtMinor?: string | null;
  measurements?: Record<string, number>;
  weightGrams?: number | null;
  onHand?: number;
  safetyStock?: number;
  isActive?: boolean;
}

/** CAT-004 / BUY-005: what must be true before a product may be published. */
export interface PublishCheck {
  readonly ready: boolean;
  readonly blockers: Array<{ code: string; message: string; field?: string }>;
  readonly warnings: Array<{ code: string; message: string }>;
  readonly localeCompleteness: {
    title: { complete: boolean; missing: Locale[] };
    description: { complete: boolean; missing: Locale[] };
    composition: { complete: boolean; missing: Locale[] };
  };
}

@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────────── products (ADM-003)

  async listProducts(options: {
    sellerId?: string;
    lifecycle?: ProductLifecycle[];
    search?: string;
    categoryId?: string;
    brandId?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: Prisma.ProductWhereInput = {
      ...(options.sellerId ? { sellerId: options.sellerId } : {}),
      ...(options.lifecycle ? { lifecycle: { in: options.lifecycle } } : {}),
      ...(options.categoryId ? { categoryId: options.categoryId } : {}),
      ...(options.brandId ? { brandId: options.brandId } : {}),
      ...(options.search
        ? {
            OR: [
              { titleRu: { contains: options.search, mode: 'insensitive' } },
              { titleUz: { contains: options.search, mode: 'insensitive' } },
              { slug: { contains: options.search, mode: 'insensitive' } },
              { externalId: { contains: options.search, mode: 'insensitive' } },
              { skus: { some: { sellerSku: { contains: options.search, mode: 'insensitive' } } } },
              { skus: { some: { barcode: { contains: options.search } } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: Math.min(options.limit ?? 25, 100),
        skip: options.offset ?? 0,
        include: {
          brand: { select: { id: true, name: true } },
          seller: { select: { id: true, displayName: true } },
          category: { select: { id: true, slug: true, nameRu: true } },
          media: { orderBy: { sortOrder: 'asc' }, take: 1 },
          skus: { include: { inventory: true } },
        },
      }),
    ]);

    return {
      total,
      rows: rows.map((row) => {
        const onHand = row.skus.reduce((acc, sku) => acc + (sku.inventory?.onHand ?? 0), 0);
        const prices = row.skus.map((sku) => sku.priceMinor).sort((a, b) => Number(a - b));
        return {
          id: row.id,
          slug: row.slug,
          externalId: row.externalId,
          title: row.titleRu,
          titleUz: row.titleUz,
          brand: row.brand,
          seller: row.seller,
          category: row.category,
          lifecycle: row.lifecycle,
          version: row.version,
          imageUrl: row.media[0]?.url ?? null,
          skuCount: row.skus.length,
          onHand,
          priceFrom: prices.length > 0 ? toMoney(prices[0]!) : null,
          publishedAt: row.publishedAt?.toISOString() ?? null,
          updatedAt: row.updatedAt.toISOString(),
          localeComplete: localeCompleteness({
            ru: row.titleRu,
            uz: row.titleUz,
            en: row.titleEn,
          }).complete,
        };
      }),
    };
  }

  async getProduct(productId: string, sellerId?: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, ...(sellerId ? { sellerId } : {}) },
      include: {
        brand: true,
        seller: { select: { id: true, displayName: true, legalName: true } },
        category: true,
        sizeChart: true,
        returnPolicy: true,
        media: { orderBy: { sortOrder: 'asc' } },
        skus: {
          include: { inventory: true, prices: { orderBy: { validFrom: 'desc' }, take: 5 } },
          orderBy: { sizeOrder: 'asc' },
        },
        versions: { orderBy: { version: 'desc' }, take: 10 },
      },
    });
    if (!product) throw AppError.notFound('Product', productId);
    return { ...product, publishCheck: await this.publishCheck(product.id) };
  }

  async createProduct(input: ProductInput, actor: AuthenticatedActor) {
    await this.assertReferences(input);

    const slug = await this.uniqueSlug(input.slug ?? input.titleRu);
    const product = await this.prisma.product.create({
      data: {
        slug,
        externalId: input.externalId ?? null,
        sellerId: input.sellerId,
        brandId: input.brandId,
        categoryId: input.categoryId,
        titleRu: input.titleRu,
        titleUz: input.titleUz,
        titleEn: input.titleEn ?? null,
        descriptionRu: input.descriptionRu ?? '',
        descriptionUz: input.descriptionUz ?? '',
        descriptionEn: input.descriptionEn ?? null,
        gender: input.gender ?? 'UNISEX',
        compositionRu: input.compositionRu ?? '',
        compositionUz: input.compositionUz ?? '',
        careRu: input.careRu ?? '',
        careUz: input.careUz ?? '',
        countryOfOrigin: input.countryOfOrigin ?? null,
        materials: input.materials ?? [],
        colorName: input.colorName,
        colorFamily: input.colorFamily,
        colorHex: input.colorHex ?? null,
        styleTags: input.styleTags ?? [],
        occasions: input.occasions ?? [],
        season: input.season ?? 'ALL_SEASON',
        silhouette: input.silhouette ?? null,
        formality: clamp(input.formality ?? 3, 1, 5),
        warmth: clamp(input.warmth ?? 3, 1, 5),
        fitNotes: input.fitNotes ?? null,
        sizeChartId: input.sizeChartId ?? null,
        returnPolicyId: input.returnPolicyId ?? null,
        authenticityNote: input.authenticityNote ?? null,
        incompatibleSlots: input.incompatibleSlots ?? [],
        incompatibleStyles: input.incompatibleStyles ?? [],
        attributes: (input.attributes ?? {}) as Prisma.InputJsonValue,
        // CAT-002: a new product always starts as a draft.
        lifecycle: 'DRAFT',
        submittedByAdminId: actor.adminUserId ?? null,
      },
    });

    await this.reindex(product.id);
    await this.audit.record(actor, {
      action: 'product.create',
      objectType: 'Product',
      objectId: product.id,
      after: { slug, titleRu: input.titleRu, sellerId: input.sellerId },
    });
    return this.getProduct(product.id);
  }

  async updateProduct(productId: string, input: Partial<ProductInput>, actor: AuthenticatedActor, sellerId?: string) {
    const before = await this.prisma.product.findFirst({
      where: { id: productId, ...(sellerId ? { sellerId } : {}) },
    });
    if (!before) throw AppError.notFound('Product', productId);

    if (input.sellerId && sellerId && input.sellerId !== sellerId) {
      throw AppError.forbidden('A seller cannot move a product to another organisation');
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        titleRu: input.titleRu ?? undefined,
        titleUz: input.titleUz ?? undefined,
        titleEn: input.titleEn === null ? null : (input.titleEn ?? undefined),
        descriptionRu: input.descriptionRu ?? undefined,
        descriptionUz: input.descriptionUz ?? undefined,
        descriptionEn: input.descriptionEn === null ? null : (input.descriptionEn ?? undefined),
        gender: input.gender ?? undefined,
        compositionRu: input.compositionRu ?? undefined,
        compositionUz: input.compositionUz ?? undefined,
        careRu: input.careRu ?? undefined,
        careUz: input.careUz ?? undefined,
        countryOfOrigin: input.countryOfOrigin === null ? null : (input.countryOfOrigin ?? undefined),
        materials: input.materials ?? undefined,
        colorName: input.colorName ?? undefined,
        colorFamily: input.colorFamily ?? undefined,
        colorHex: input.colorHex === null ? null : (input.colorHex ?? undefined),
        styleTags: input.styleTags ?? undefined,
        occasions: input.occasions ?? undefined,
        season: input.season ?? undefined,
        silhouette: input.silhouette === null ? null : (input.silhouette ?? undefined),
        formality: input.formality != null ? clamp(input.formality, 1, 5) : undefined,
        warmth: input.warmth != null ? clamp(input.warmth, 1, 5) : undefined,
        fitNotes: input.fitNotes === null ? null : (input.fitNotes ?? undefined),
        sizeChartId: input.sizeChartId === null ? null : (input.sizeChartId ?? undefined),
        returnPolicyId: input.returnPolicyId === null ? null : (input.returnPolicyId ?? undefined),
        authenticityNote: input.authenticityNote === null ? null : (input.authenticityNote ?? undefined),
        incompatibleSlots: input.incompatibleSlots ?? undefined,
        incompatibleStyles: input.incompatibleStyles ?? undefined,
        attributes: input.attributes ? (input.attributes as Prisma.InputJsonValue) : undefined,
        categoryId: input.categoryId ?? undefined,
        brandId: input.brandId ?? undefined,
        version: { increment: 1 },
      },
    });

    // CAT-009: keep a snapshot of what changed, with who changed it.
    await this.prisma.productVersion.create({
      data: {
        productId,
        version: updated.version,
        snapshot: serialize(before) as Prisma.InputJsonValue,
        changedByAdminId: actor.adminUserId ?? actor.sellerUserId ?? null,
        changeNote: 'update',
      },
    });

    // SEL-003: a critical change on a published product sends it back to review.
    const criticalChanged =
      input.titleRu !== undefined ||
      input.compositionRu !== undefined ||
      input.categoryId !== undefined ||
      input.brandId !== undefined;
    if (criticalChanged && before.lifecycle === 'PUBLISHED' && actor.kind === 'seller') {
      await this.prisma.product.update({
        where: { id: productId },
        data: { lifecycle: 'IN_REVIEW', reviewNote: 'Re-review after a critical change by the seller' },
      });
    }

    await this.reindex(productId);
    await this.audit.recordChange(
      actor,
      'Product',
      productId,
      'product.update',
      serialize(before),
      serialize(updated),
    );
    return this.getProduct(productId);
  }

  /** CAT-009: the lifecycle gate. Publishing runs the full check first. */
  async transitionLifecycle(
    productId: string,
    to: ProductLifecycle,
    actor: AuthenticatedActor,
    note?: string,
  ) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw AppError.notFound('Product', productId);

    assertTransition('product', product.lifecycle, to);

    if (to === 'PUBLISHED') {
      const check = await this.publishCheck(productId);
      if (!check.ready) {
        throw AppError.validation('This product cannot be published yet', {
          blockers: check.blockers,
          localeCompleteness: check.localeCompleteness,
        });
      }
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        lifecycle: to,
        reviewNote: note ?? null,
        reviewedByAdminId: to === 'PUBLISHED' || to === 'REJECTED' ? (actor.adminUserId ?? null) : undefined,
        publishedAt: to === 'PUBLISHED' ? (product.publishedAt ?? new Date()) : undefined,
        archivedAt: to === 'ARCHIVED' ? new Date() : null,
      },
    });

    await this.reindex(productId);
    await this.audit.record(actor, {
      action: `product.${to.toLowerCase()}`,
      objectType: 'Product',
      objectId: productId,
      before: { lifecycle: product.lifecycle },
      after: { lifecycle: to },
      reason: note,
      severity: to === 'PUBLISHED' ? 'NOTICE' : 'INFO',
    });

    return { lifecycle: updated.lifecycle };
  }

  /**
   * CAT-002 / CAT-004 / BUY-005 / ADM-011 all converge here: one place that
   * decides whether a product is complete enough to sell.
   */
  async publishCheck(productId: string): Promise<PublishCheck> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        media: true,
        skus: { include: { inventory: true } },
        category: { include: { attributeSchema: true } },
        seller: { select: { onboardingStatus: true } },
        sizeChart: { select: { id: true } },
      },
    });
    if (!product) throw AppError.notFound('Product', productId);

    const blockers: PublishCheck['blockers'] = [];
    const warnings: PublishCheck['warnings'] = [];

    const titleLocales = localeCompleteness({
      ru: product.titleRu,
      uz: product.titleUz,
      en: product.titleEn,
    });
    const descriptionLocales = localeCompleteness({
      ru: product.descriptionRu,
      uz: product.descriptionUz,
      en: product.descriptionEn,
    });
    const compositionLocales = localeCompleteness({
      ru: product.compositionRu,
      uz: product.compositionUz,
    });

    // ADM-011: a required locale may not be empty.
    if (!titleLocales.complete) {
      blockers.push({
        code: 'LOCALE_TITLE',
        message: `Title is missing for: ${titleLocales.missing.join(', ')}`,
        field: 'title',
      });
    }
    if (!compositionLocales.complete) {
      blockers.push({
        code: 'LOCALE_COMPOSITION',
        message: `Composition is missing for: ${compositionLocales.missing.join(', ')}`,
        field: 'composition',
      });
    }
    if (!descriptionLocales.complete) {
      warnings.push({
        code: 'LOCALE_DESCRIPTION',
        message: `Description is missing for: ${descriptionLocales.missing.join(', ')}`,
      });
    }

    // CAT-004: media standard.
    const mainMedia = product.media.filter((media) => media.role === 'MAIN');
    if (mainMedia.length === 0) {
      blockers.push({ code: 'MEDIA_MAIN_MISSING', message: 'A main image is required', field: 'media' });
    }
    if (product.media.length < 2) {
      warnings.push({ code: 'MEDIA_FEW', message: 'Fewer than two images; add more angles' });
    }
    const withoutAlt = product.media.filter((media) => !media.altRu.trim() || !media.altUz.trim());
    if (withoutAlt.length > 0) {
      // NFR-009 (WCAG 2.2 AA) needs alt text, so this blocks rather than warns.
      blockers.push({
        code: 'MEDIA_ALT_MISSING',
        message: `${withoutAlt.length} image(s) have no alt text in a required locale`,
        field: 'media',
      });
    }
    const withoutRights = product.media.filter((media) => media.rightsConfirmedAt == null);
    if (withoutRights.length > 0) {
      blockers.push({
        code: 'MEDIA_RIGHTS',
        message: `${withoutRights.length} image(s) have no confirmed content rights`,
        field: 'media',
      });
    }
    const criticalIssues = product.media.flatMap((media) => media.qualityIssues);
    if (criticalIssues.length > 0) {
      blockers.push({
        code: 'MEDIA_QUALITY',
        message: `Media quality issues: ${[...new Set(criticalIssues)].join(', ')}`,
        field: 'media',
      });
    }

    // CAT-005 / BUY-005: priced, sized, buyable SKUs.
    const activeSkus = product.skus.filter((sku) => sku.isActive);
    if (activeSkus.length === 0) {
      blockers.push({ code: 'NO_SKU', message: 'At least one active SKU is required', field: 'skus' });
    }
    if (activeSkus.some((sku) => sku.priceMinor <= 0n)) {
      blockers.push({ code: 'PRICE_MISSING', message: 'Every active SKU needs a price', field: 'skus' });
    }
    if (activeSkus.some((sku) => !sku.sizeLabel.trim())) {
      blockers.push({ code: 'SIZE_MISSING', message: 'Every SKU needs a size label', field: 'skus' });
    }
    if (activeSkus.every((sku) => (sku.inventory?.onHand ?? 0) === 0)) {
      warnings.push({ code: 'NO_STOCK', message: 'No stock on any size; the product will not be sellable' });
    }

    // CAT-003: a chart is strongly expected for anything wearable.
    if (!product.sizeChartId && !NON_SIZED_SLOTS.includes(product.category.slot ?? '')) {
      warnings.push({
        code: 'SIZE_CHART_MISSING',
        message: 'No size chart; the fit recommendation will fall back to chart-only',
      });
    }

    // CAT-002: the category's required attributes.
    const schema = product.category.attributeSchema;
    if (schema) {
      const fields = (schema.fields as Array<{ key: string; required?: boolean; label?: string }>) ?? [];
      const attributes = (product.attributes as Record<string, unknown>) ?? {};
      for (const field of fields) {
        if (!field.required) continue;
        const value = attributes[field.key];
        if (value === undefined || value === null || value === '') {
          blockers.push({
            code: 'ATTRIBUTE_REQUIRED',
            message: `Required attribute "${field.label ?? field.key}" is empty`,
            field: `attributes.${field.key}`,
          });
        }
      }
    }

    // CAT-010: the product must resolve to a live seller.
    if (product.seller.onboardingStatus !== 'ACTIVE') {
      blockers.push({
        code: 'SELLER_NOT_ACTIVE',
        message: `The seller is ${product.seller.onboardingStatus}, not ACTIVE`,
        field: 'seller',
      });
    }

    if (!product.styleTags.length) {
      warnings.push({
        code: 'NO_STYLE_TAGS',
        message: 'No style tags; the AI stylist will rarely pick this item',
      });
    }

    return {
      ready: blockers.length === 0,
      blockers,
      warnings,
      localeCompleteness: {
        title: { complete: titleLocales.complete, missing: titleLocales.missing },
        description: { complete: descriptionLocales.complete, missing: descriptionLocales.missing },
        composition: { complete: compositionLocales.complete, missing: compositionLocales.missing },
      },
    };
  }

  // ──────────────────────────────────────────────────────── SKUs & stock

  async upsertSkus(productId: string, skus: SkuInput[], actor: AuthenticatedActor, sellerId?: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, ...(sellerId ? { sellerId } : {}) },
      select: { id: true },
    });
    if (!product) throw AppError.notFound('Product', productId);

    const results: Array<{ id: string; sizeLabel: string; created: boolean }> = [];

    for (const input of skus) {
      const priceMinor = BigInt(input.priceMinor);
      if (priceMinor <= 0n) throw AppError.validation(`Price must be positive for size ${input.sizeLabel}`);

      const data = {
        sellerSku: input.sellerSku ?? null,
        barcode: input.barcode ?? null,
        sizeLabel: input.sizeLabel.trim(),
        sizeOrder: Math.round(sizeSortKey(input.sizeLabel)),
        colorName: input.colorName ?? '',
        priceMinor,
        compareAtMinor: input.compareAtMinor ? BigInt(input.compareAtMinor) : null,
        measurements: (input.measurements ?? {}) as Prisma.InputJsonValue,
        weightGrams: input.weightGrams ?? null,
        isActive: input.isActive ?? true,
      };

      const existing = input.id
        ? await this.prisma.sku.findFirst({ where: { id: input.id, productId } })
        : await this.prisma.sku.findFirst({
            where: { productId, sizeLabel: data.sizeLabel, colorName: data.colorName },
          });

      let skuId: string;
      if (existing) {
        // CAT-006: a price change is journalled, never silently overwritten.
        if (existing.priceMinor !== priceMinor || existing.compareAtMinor !== data.compareAtMinor) {
          await this.prisma.priceHistory.create({
            data: {
              skuId: existing.id,
              priceMinor: existing.priceMinor,
              compareAtMinor: existing.compareAtMinor,
              currency: existing.currency,
              source: actor.kind === 'seller' ? 'SELLER' : 'ADMIN',
              changedByAdminId: actor.adminUserId ?? null,
              changedBySellerUserId: actor.sellerUserId ?? null,
              validTo: new Date(),
            },
          });
        }
        await this.prisma.sku.update({ where: { id: existing.id }, data });
        skuId = existing.id;
        results.push({ id: skuId, sizeLabel: data.sizeLabel, created: false });
      } else {
        const created = await this.prisma.sku.create({ data: { ...data, productId } });
        skuId = created.id;
        results.push({ id: skuId, sizeLabel: data.sizeLabel, created: true });
      }

      if (input.onHand != null || input.safetyStock != null) {
        await this.inventory.setStock(
          skuId,
          { onHand: input.onHand, safetyStock: input.safetyStock },
          {
            reason: 'admin/seller SKU upsert',
            actorType: actor.kind.toUpperCase(),
            actorId: actor.adminUserId ?? actor.sellerUserId,
          },
        );
      } else {
        // A new SKU always gets an inventory row so `available` is defined.
        await this.prisma.inventory.upsert({
          where: { skuId },
          create: { skuId, onHand: 0 },
          update: {},
        });
      }
    }

    await this.reindex(productId);
    await this.audit.record(actor, {
      action: 'sku.upsert',
      objectType: 'Product',
      objectId: productId,
      after: { skus: results },
    });
    return { skus: results };
  }

  async setStock(
    skuId: string,
    input: { onHand?: number; safetyStock?: number; lowStockThreshold?: number },
    actor: AuthenticatedActor,
    sellerId?: string,
  ) {
    const sku = await this.prisma.sku.findFirst({
      where: { id: skuId, ...(sellerId ? { product: { sellerId } } : {}) },
      select: { id: true },
    });
    if (!sku) throw AppError.notFound('Sku', skuId);

    const snapshot = await this.inventory.setStock(skuId, input, {
      reason: 'manual stock update',
      actorType: actor.kind.toUpperCase(),
      actorId: actor.adminUserId ?? actor.sellerUserId,
    });
    await this.audit.record(actor, {
      action: 'inventory.update',
      objectType: 'Sku',
      objectId: skuId,
      after: snapshot,
    });
    return snapshot;
  }

  async addMedia(
    productId: string,
    input: {
      url: string;
      role?: string;
      altRu: string;
      altUz: string;
      altEn?: string | null;
      width?: number;
      height?: number;
      placeholder?: string | null;
      rightsConfirmed?: boolean;
      sortOrder?: number;
    },
    actor: AuthenticatedActor,
    sellerId?: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, ...(sellerId ? { sellerId } : {}) },
      select: { id: true },
    });
    if (!product) throw AppError.notFound('Product', productId);

    // CAT-004: flag quality problems at upload time rather than at publish.
    const qualityIssues: string[] = [];
    if (input.width != null && input.width < 800) qualityIssues.push('width_below_800');
    if (input.height != null && input.width != null && input.height < input.width) {
      qualityIssues.push('not_portrait');
    }

    const media = await this.prisma.media.create({
      data: {
        productId,
        url: input.url,
        role: (input.role ?? 'MAIN') as never,
        altRu: input.altRu,
        altUz: input.altUz,
        altEn: input.altEn ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        placeholder: input.placeholder ?? null,
        sortOrder: input.sortOrder ?? 0,
        rightsConfirmedAt: input.rightsConfirmed ? new Date() : null,
        qualityIssues,
      },
    });
    await this.audit.record(actor, {
      action: 'media.add',
      objectType: 'Product',
      objectId: productId,
      after: { mediaId: media.id, role: media.role, qualityIssues },
    });
    return media;
  }

  async deleteMedia(mediaId: string, actor: AuthenticatedActor, sellerId?: string) {
    const media = await this.prisma.media.findFirst({
      where: { id: mediaId, ...(sellerId ? { product: { sellerId } } : {}) },
      select: { id: true, productId: true },
    });
    if (!media) throw AppError.notFound('Media', mediaId);
    await this.prisma.media.delete({ where: { id: mediaId } });
    await this.audit.record(actor, {
      action: 'media.delete',
      objectType: 'Product',
      objectId: media.productId,
      before: { mediaId },
    });
    return { deleted: true };
  }

  // ──────────────────────────────────────────── bulk import (ADM-004)

  /**
   * CSV import with a dry run. Every row is validated first and the whole
   * report comes back before anything is written, which is what ADM-004's
   * "ошибки не создают hidden partial chaos" asks for.
   *
   * Expected header (order-independent):
   *   external_id,seller_sku,barcode,title_ru,title_uz,brand,category,
   *   color_name,color_family,size,price,compare_at,stock,composition_ru,
   *   composition_uz,style_tags,season,material,image_url
   */
  async importCsv(
    input: { fileName: string; content: string; sellerId: string; dryRun: boolean },
    actor: AuthenticatedActor,
  ) {
    const rows = parseCsv(input.content);
    if (rows.length === 0) throw AppError.validation('The file has no data rows');
    if (rows.length > 5000) throw AppError.validation('At most 5000 rows per import');

    const job = await this.prisma.importJob.create({
      data: {
        kind: 'PRODUCTS_CSV',
        fileName: input.fileName,
        dryRun: input.dryRun,
        status: 'RUNNING',
        totalRows: rows.length,
        sellerId: input.sellerId,
        createdByAdminId: actor.adminUserId ?? null,
        createdBySellerUserId: actor.sellerUserId ?? null,
        startedAt: new Date(),
      },
    });

    const errors: Array<{ row: number; field: string; message: string }> = [];
    const planned: Array<{ row: number; action: 'create' | 'update'; externalId: string; size: string }> = [];

    const [brands, categories] = await Promise.all([
      this.prisma.brand.findMany({ select: { id: true, slug: true, name: true } }),
      this.prisma.category.findMany({ select: { id: true, slug: true, nameRu: true } }),
    ]);
    const brandBySlug = new Map(brands.map((brand) => [brand.slug.toLowerCase(), brand]));
    const brandByName = new Map(brands.map((brand) => [brand.name.toLowerCase(), brand]));
    const categoryBySlug = new Map(categories.map((category) => [category.slug.toLowerCase(), category]));

    // Pass one: validate everything.
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2; // header is row 1
      const externalId = (row.external_id ?? '').trim();
      if (!externalId) {
        errors.push({ row: rowNumber, field: 'external_id', message: 'Required' });
        continue;
      }
      if (!(row.title_ru ?? '').trim()) {
        errors.push({ row: rowNumber, field: 'title_ru', message: 'Required' });
      }
      if (!(row.title_uz ?? '').trim()) {
        // ADM-011: UZ is a required locale, so a missing value is an error.
        errors.push({ row: rowNumber, field: 'title_uz', message: 'Required (UZ is a mandatory locale)' });
      }
      const brandKey = (row.brand ?? '').trim().toLowerCase();
      if (!brandBySlug.has(brandKey) && !brandByName.has(brandKey)) {
        errors.push({ row: rowNumber, field: 'brand', message: `Unknown brand "${row.brand}"` });
      }
      const categoryKey = (row.category ?? '').trim().toLowerCase();
      if (!categoryBySlug.has(categoryKey)) {
        errors.push({ row: rowNumber, field: 'category', message: `Unknown category "${row.category}"` });
      }
      if (!(row.size ?? '').trim()) {
        errors.push({ row: rowNumber, field: 'size', message: 'Required' });
      }
      const price = Number.parseFloat((row.price ?? '').replace(/[\s,]/g, ''));
      if (!Number.isFinite(price) || price <= 0) {
        errors.push({ row: rowNumber, field: 'price', message: 'Must be a positive number (soum)' });
      }
      const stock = Number.parseInt((row.stock ?? '0').trim(), 10);
      if (!Number.isFinite(stock) || stock < 0) {
        errors.push({ row: rowNumber, field: 'stock', message: 'Must be a non-negative integer' });
      }

      const existing = await this.prisma.product.findFirst({
        where: { sellerId: input.sellerId, externalId },
        select: { id: true },
      });
      planned.push({
        row: rowNumber,
        action: existing ? 'update' : 'create',
        externalId,
        size: (row.size ?? '').trim(),
      });
    }

    if (input.dryRun || errors.length > 0) {
      const report = {
        errors,
        planned,
        summary: {
          total: rows.length,
          toCreate: planned.filter((entry) => entry.action === 'create').length,
          toUpdate: planned.filter((entry) => entry.action === 'update').length,
          invalid: errors.length,
        },
      };
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: errors.length > 0 ? 'FAILED' : 'DRY_RUN_OK',
          failedRows: errors.length,
          report: report as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
      return { jobId: job.id, dryRun: true, ...report };
    }

    // Pass two: write. CAT-001 — upsert by (seller, externalId), so a repeated
    // import updates instead of creating a duplicate.
    let created = 0;
    let updated = 0;

    for (const row of rows) {
      const externalId = (row.external_id ?? '').trim();
      const brandKey = (row.brand ?? '').trim().toLowerCase();
      const brand = brandBySlug.get(brandKey) ?? brandByName.get(brandKey)!;
      const category = categoryBySlug.get((row.category ?? '').trim().toLowerCase())!;
      const priceMinor = BigInt(Math.round(Number.parseFloat((row.price ?? '0').replace(/[\s,]/g, '')) * 100));
      const compareAt = (row.compare_at ?? '').trim();
      const compareAtMinor = compareAt
        ? BigInt(Math.round(Number.parseFloat(compareAt.replace(/[\s,]/g, '')) * 100))
        : null;

      const existing = await this.prisma.product.findFirst({
        where: { sellerId: input.sellerId, externalId },
      });

      let productId: string;
      if (existing) {
        await this.prisma.product.update({
          where: { id: existing.id },
          data: {
            titleRu: row.title_ru!.trim(),
            titleUz: row.title_uz!.trim(),
            brandId: brand.id,
            categoryId: category.id,
            colorName: (row.color_name ?? '').trim() || existing.colorName,
            colorFamily: (row.color_family ?? '').trim() || existing.colorFamily,
            compositionRu: (row.composition_ru ?? existing.compositionRu).trim(),
            compositionUz: (row.composition_uz ?? existing.compositionUz).trim(),
            season: (row.season ?? existing.season).trim(),
            styleTags: splitList(row.style_tags) ?? existing.styleTags,
            materials: splitList(row.material) ?? existing.materials,
            version: { increment: 1 },
          },
        });
        productId = existing.id;
        updated += 1;
      } else {
        const product = await this.prisma.product.create({
          data: {
            slug: await this.uniqueSlug(`${brand.name} ${row.title_ru}`),
            externalId,
            sellerId: input.sellerId,
            brandId: brand.id,
            categoryId: category.id,
            titleRu: row.title_ru!.trim(),
            titleUz: row.title_uz!.trim(),
            colorName: (row.color_name ?? 'Multi').trim(),
            colorFamily: (row.color_family ?? 'multicolor').trim(),
            compositionRu: (row.composition_ru ?? '').trim(),
            compositionUz: (row.composition_uz ?? '').trim(),
            season: (row.season ?? 'ALL_SEASON').trim(),
            styleTags: splitList(row.style_tags) ?? [],
            materials: splitList(row.material) ?? [],
            lifecycle: 'DRAFT',
          },
        });
        productId = product.id;
        created += 1;
      }

      const sizeLabel = (row.size ?? '').trim();
      const sku = await this.prisma.sku.upsert({
        where: {
          productId_sizeLabel_colorName: {
            productId,
            sizeLabel,
            colorName: (row.color_name ?? '').trim() || '',
          },
        },
        create: {
          productId,
          sizeLabel,
          sizeOrder: Math.round(sizeSortKey(sizeLabel)),
          colorName: (row.color_name ?? '').trim() || '',
          sellerSku: (row.seller_sku ?? '').trim() || null,
          barcode: (row.barcode ?? '').trim() || null,
          priceMinor,
          compareAtMinor,
        },
        update: {
          priceMinor,
          compareAtMinor,
          sellerSku: (row.seller_sku ?? '').trim() || undefined,
          barcode: (row.barcode ?? '').trim() || undefined,
        },
      });

      await this.inventory.setStock(
        sku.id,
        { onHand: Number.parseInt((row.stock ?? '0').trim(), 10) },
        { kind: 'IMPORT', reason: `CSV import ${input.fileName}`, actorType: 'ADMIN', actorId: actor.adminUserId },
      );

      const imageUrl = (row.image_url ?? '').trim();
      if (imageUrl) {
        const hasMedia = await this.prisma.media.count({ where: { productId, url: imageUrl } });
        if (hasMedia === 0) {
          await this.prisma.media.create({
            data: {
              productId,
              url: imageUrl,
              role: 'MAIN',
              altRu: row.title_ru!.trim(),
              altUz: row.title_uz!.trim(),
              rightsConfirmedAt: new Date(),
            },
          });
        }
      }

      await this.reindex(productId);
    }

    const report = { errors: [], summary: { total: rows.length, created, updated, invalid: 0 } };
    await this.prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        createdRows: created,
        updatedRows: updated,
        report: report as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });

    await this.audit.record(actor, {
      action: 'catalog.import',
      objectType: 'ImportJob',
      objectId: job.id,
      after: { fileName: input.fileName, created, updated },
      severity: 'NOTICE',
    });

    logger.info({ jobId: job.id, created, updated }, 'catalogue import completed');
    return { jobId: job.id, dryRun: false, ...report };
  }

  async importJobs(sellerId?: string, limit = 20) {
    return this.prisma.importJob.findMany({
      where: sellerId ? { sellerId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** The CSV template the admin UI offers for download. */
  csvTemplate(): string {
    const headers = [
      'external_id',
      'seller_sku',
      'barcode',
      'title_ru',
      'title_uz',
      'brand',
      'category',
      'color_name',
      'color_family',
      'size',
      'price',
      'compare_at',
      'stock',
      'composition_ru',
      'composition_uz',
      'style_tags',
      'season',
      'material',
      'image_url',
    ];
    const example = [
      'SKU-1001',
      'TRS-001-M',
      '4780001234567',
      'Шерстяные брюки прямого кроя',
      'Jundan tikilgan to‘g‘ri shim',
      'altyn-atelier',
      'trousers',
      'Тёмно-синий',
      'navy',
      'M',
      '1200000',
      '1500000',
      '6',
      '70% шерсть, 30% вискоза',
      '70% jun, 30% viskoza',
      'old_money|business_casual',
      'FW',
      'wool',
      'https://cdn.example.uz/trousers-navy-1.jpg',
    ];
    return `${headers.join(',')}\n${example.map(csvEscape).join(',')}\n`;
  }

  // ───────────────────────────────────────────────────────── internals

  /** BUY-002: rebuild the transliterated search blob after any change. */
  async reindex(productId: string): Promise<void> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        brand: { select: { name: true, slug: true } },
        category: { select: { nameRu: true, nameUz: true, nameEn: true, slug: true } },
        skus: { select: { sizeLabel: true, sellerSku: true, barcode: true } },
      },
    });
    if (!product) return;

    const document = buildSearchDocument([
      product.titleRu,
      product.titleUz,
      product.titleEn,
      product.brand.name,
      product.brand.slug,
      product.category.nameRu,
      product.category.nameUz,
      product.category.nameEn,
      product.category.slug,
      product.colorName,
      product.colorFamily,
      ...product.materials,
      ...product.styleTags,
      ...product.occasions,
      product.season,
      product.silhouette,
      ...product.skus.map((sku) => sku.sizeLabel),
      ...product.skus.map((sku) => sku.sellerSku),
      ...product.skus.map((sku) => sku.barcode),
    ]);

    await this.prisma.product.update({
      where: { id: productId },
      data: { searchDocument: document },
    });
  }

  async reindexAll(): Promise<number> {
    const products = await this.prisma.product.findMany({ select: { id: true } });
    for (const product of products) await this.reindex(product.id);
    return products.length;
  }

  private async assertReferences(input: Pick<ProductInput, 'sellerId' | 'brandId' | 'categoryId'>) {
    const [seller, brand, category] = await Promise.all([
      this.prisma.seller.findUnique({ where: { id: input.sellerId }, select: { id: true } }),
      this.prisma.brand.findUnique({ where: { id: input.brandId }, select: { id: true } }),
      this.prisma.category.findUnique({ where: { id: input.categoryId }, select: { id: true } }),
    ]);
    if (!seller) throw AppError.notFound('Seller', input.sellerId);
    if (!brand) throw AppError.notFound('Brand', input.brandId);
    if (!category) throw AppError.notFound('Category', input.categoryId);
  }

  private async uniqueSlug(source: string): Promise<string> {
    const base = slugify(source) || 'product';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.prisma.product.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

const NON_SIZED_SLOTS = ['BAG', 'ACCESSORY', 'HEADWEAR'];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function slugify(value: string): string {
  const translit: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'sch', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
    ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
  };
  return value
    .toLowerCase()
    .split('')
    .map((char) => translit[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function serialize(value: unknown): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry)),
  ) as Record<string, unknown>;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(/[|;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A small RFC-4180-ish parser: quotes, escaped quotes and embedded newlines. */
export function parseCsv(content: string): Array<Record<string, string | undefined>> {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }

  if (rows.length < 2) return [];
  const header = rows[0]!.map((cell) => cell.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((cells) => {
    const record: Record<string, string | undefined> = {};
    header.forEach((key, index) => {
      record[key] = cells[index];
    });
    return record;
  });
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export { REQUIRED_LOCALES };
