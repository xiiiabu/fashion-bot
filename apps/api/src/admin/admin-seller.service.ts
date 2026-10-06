/**
 * Seller, brand, contract and reference-data administration — spec §10
 * (Sellers & contracts, Brands) and Appendix C (the brand onboarding checklist).
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type SellerOnboardingStatus } from '@prisma/client';
import { type Locale, pickLocalized } from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { AuditService } from '../common/audit.service';
import type { AuthenticatedActor } from '../common/http';
import { toMoney } from '../common/money.util';
import { slugify } from './admin-catalog.service';

export interface SellerInput {
  legalName: string;
  displayName: string;
  slug?: string;
  taxId?: string | null;
  registrationNumber?: string | null;
  legalAddress?: string | null;
  signatoryName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  settlementMode?: 'NATIVE_SPLIT' | 'PLATFORM_SETTLEMENT';
  handlingDays?: number;
  cutoffLocalTime?: string;
  payoutScheduleDays?: number;
  returnReserveBps?: number;
  logoUrl?: string | null;
  description?: string | null;
}

/** Appendix C: the ten steps a brand has to clear before it can sell. */
const ONBOARDING_CHECKLIST = [
  { key: 'kyb', label: 'KYB: legal details, bank details, signatory authority' },
  { key: 'agreement', label: 'Seller agreement: commission, settlement, refunds, PSP fee, SLA, authenticity' },
  { key: 'brand_profile', label: 'Brand profile and permission to use logo/media' },
  { key: 'catalog_mapping', label: 'Catalogue mapping: categories, attributes, SKU ids, barcodes, size charts' },
  { key: 'media_qa', label: 'Media/content QA and localisations' },
  { key: 'stock_method', label: 'Stock update method and cut-off/SLA' },
  { key: 'operations', label: 'Order confirmation, packaging, handover and return process' },
  { key: 'finance', label: 'Finance contacts, payout account, acts/reports' },
  { key: 'users', label: 'Seller users/roles and security onboarding' },
  { key: 'uat', label: 'Pilot UAT and production readiness sign-off' },
] as const;

@Injectable()
export class AdminSellerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(options: { limit?: number; offset?: number; search?: string }) {
    const where: Prisma.SellerWhereInput = options.search
      ? {
          OR: [
            { displayName: { contains: options.search, mode: 'insensitive' } },
            { legalName: { contains: options.search, mode: 'insensitive' } },
            { slug: { contains: options.search, mode: 'insensitive' } },
            { taxId: { contains: options.search } },
          ],
        }
      : {};

    const [total, rows] = await Promise.all([
      this.prisma.seller.count({ where }),
      this.prisma.seller.findMany({
        where,
        orderBy: [{ onboardingStatus: 'asc' }, { displayName: 'asc' }],
        take: Math.min(options.limit ?? 25, 100),
        skip: options.offset ?? 0,
        include: {
          _count: { select: { products: true, brands: true, users: true, subOrders: true } },
        },
      }),
    ]);

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        displayName: row.displayName,
        legalName: row.legalName,
        onboardingStatus: row.onboardingStatus,
        verified: row.verified,
        settlementMode: row.settlementMode,
        handlingDays: row.handlingDays,
        qualityScore: row.qualityScore,
        payoutHold: toMoney(row.payoutHoldMinor, row.currency),
        returnReserveBps: row.returnReserveBps,
        counts: row._count,
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async detail(sellerId: string) {
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      include: {
        brands: true,
        users: {
          select: { id: true, email: true, name: true, role: true, mfaEnabledAt: true, lastLoginAt: true, disabledAt: true },
        },
        contracts: { orderBy: [{ number: 'asc' }, { version: 'desc' }] },
        commissionRules: { orderBy: { version: 'desc' }, take: 10 },
        payoutAccounts: true,
        deliveryMethods: { include: { zone: true } },
        returnPolicies: { orderBy: { version: 'desc' } },
        inventoryFeeds: {
          select: { id: true, name: true, tokenPrefix: true, scopes: true, lastUsedAt: true, revokedAt: true },
        },
        _count: { select: { products: true, subOrders: true, orderItems: true } },
      },
    });
    if (!seller) throw AppError.notFound('Seller', sellerId);

    // Appendix C: show the checklist state so onboarding is auditable.
    const checklist = ONBOARDING_CHECKLIST.map((step) => ({
      ...step,
      done: this.checklistDone(step.key, seller),
    }));

    return {
      ...seller,
      payoutHold: toMoney(seller.payoutHoldMinor, seller.currency),
      checklist,
      checklistComplete: checklist.every((step) => step.done),
    };
  }

  private checklistDone(
    key: (typeof ONBOARDING_CHECKLIST)[number]['key'],
    seller: {
      taxId: string | null;
      signatoryName: string | null;
      contracts: unknown[];
      brands: Array<{ contentRightsConfirmedAt: Date | null }>;
      payoutAccounts: unknown[];
      users: unknown[];
      deliveryMethods: unknown[];
      returnPolicies: unknown[];
      inventoryFeeds: unknown[];
      _count: { products: number };
      onboardingStatus: SellerOnboardingStatus;
    },
  ): boolean {
    switch (key) {
      case 'kyb':
        return Boolean(seller.taxId && seller.signatoryName);
      case 'agreement':
        return seller.contracts.length > 0;
      case 'brand_profile':
        return seller.brands.length > 0 && seller.brands.every((brand) => brand.contentRightsConfirmedAt != null);
      case 'catalog_mapping':
      case 'media_qa':
        return seller._count.products > 0;
      case 'stock_method':
        return seller.inventoryFeeds.length > 0 || seller._count.products > 0;
      case 'operations':
        return seller.deliveryMethods.length > 0 && seller.returnPolicies.length > 0;
      case 'finance':
        return seller.payoutAccounts.length > 0;
      case 'users':
        return seller.users.length > 0;
      case 'uat':
        return seller.onboardingStatus === 'ACTIVE';
      default:
        return false;
    }
  }

  async create(input: SellerInput, actor: AuthenticatedActor) {
    const slug = await this.uniqueSellerSlug(input.slug ?? input.displayName);
    const seller = await this.prisma.seller.create({
      data: {
        slug,
        legalName: input.legalName,
        displayName: input.displayName,
        taxId: input.taxId ?? null,
        registrationNumber: input.registrationNumber ?? null,
        legalAddress: input.legalAddress ?? null,
        signatoryName: input.signatoryName ?? null,
        contactEmail: input.contactEmail ?? null,
        contactPhone: input.contactPhone ?? null,
        settlementMode: input.settlementMode ?? 'PLATFORM_SETTLEMENT',
        handlingDays: input.handlingDays ?? 1,
        cutoffLocalTime: input.cutoffLocalTime ?? '15:00',
        payoutScheduleDays: input.payoutScheduleDays ?? 7,
        returnReserveBps: input.returnReserveBps ?? 0,
        logoUrl: input.logoUrl ?? null,
        description: input.description ?? null,
        onboardingStatus: 'KYB_PENDING',
      },
    });

    await this.audit.record(actor, {
      action: 'seller.create',
      objectType: 'Seller',
      objectId: seller.id,
      after: { slug, legalName: input.legalName },
      severity: 'NOTICE',
    });
    return seller;
  }

  async update(sellerId: string, input: Partial<SellerInput>, actor: AuthenticatedActor) {
    const before = await this.prisma.seller.findUnique({ where: { id: sellerId } });
    if (!before) throw AppError.notFound('Seller', sellerId);

    const updated = await this.prisma.seller.update({
      where: { id: sellerId },
      data: {
        legalName: input.legalName ?? undefined,
        displayName: input.displayName ?? undefined,
        taxId: input.taxId === null ? null : (input.taxId ?? undefined),
        registrationNumber: input.registrationNumber === null ? null : (input.registrationNumber ?? undefined),
        legalAddress: input.legalAddress === null ? null : (input.legalAddress ?? undefined),
        signatoryName: input.signatoryName === null ? null : (input.signatoryName ?? undefined),
        contactEmail: input.contactEmail === null ? null : (input.contactEmail ?? undefined),
        contactPhone: input.contactPhone === null ? null : (input.contactPhone ?? undefined),
        settlementMode: input.settlementMode ?? undefined,
        handlingDays: input.handlingDays ?? undefined,
        cutoffLocalTime: input.cutoffLocalTime ?? undefined,
        payoutScheduleDays: input.payoutScheduleDays ?? undefined,
        returnReserveBps: input.returnReserveBps ?? undefined,
        logoUrl: input.logoUrl === null ? null : (input.logoUrl ?? undefined),
        description: input.description === null ? null : (input.description ?? undefined),
      },
    });

    await this.audit.recordChange(
      actor,
      'Seller',
      sellerId,
      'seller.update',
      { ...before, payoutHoldMinor: before.payoutHoldMinor.toString() },
      { ...updated, payoutHoldMinor: updated.payoutHoldMinor.toString() },
      { severity: 'NOTICE' },
    );
    return updated;
  }

  /**
   * CAT-010 depends on this: only an ACTIVE seller's products are visible, so
   * activating a seller is a gate, not a label. The checklist must be clear.
   */
  async setOnboardingStatus(
    sellerId: string,
    status: SellerOnboardingStatus,
    actor: AuthenticatedActor,
    note?: string,
  ) {
    const seller = await this.detail(sellerId);

    if (status === 'ACTIVE' && !seller.checklistComplete) {
      throw AppError.validation('The onboarding checklist is not complete', {
        missing: seller.checklist.filter((step) => !step.done).map((step) => step.key),
      });
    }

    const updated = await this.prisma.seller.update({
      where: { id: sellerId },
      data: {
        onboardingStatus: status,
        verified: status === 'ACTIVE' ? true : undefined,
        suspendedAt: status === 'SUSPENDED' ? new Date() : null,
      },
    });

    // Suspending a seller must take their catalogue out of circulation too.
    if (status === 'SUSPENDED' || status === 'OFFBOARDED') {
      await this.prisma.sellerUser.updateMany({
        where: { sellerId },
        data: { disabledAt: new Date() },
      });
    }

    await this.audit.record(actor, {
      action: 'seller.onboarding',
      objectType: 'Seller',
      objectId: sellerId,
      before: { status: seller.onboardingStatus },
      after: { status },
      reason: note,
      severity: 'CRITICAL',
    });
    return { onboardingStatus: updated.onboardingStatus };
  }

  // ───────────────────────────────────────────────────────── brands

  async listBrands() {
    const rows = await this.prisma.brand.findMany({
      orderBy: [{ featured: 'desc' }, { name: 'asc' }],
      include: {
        seller: { select: { id: true, displayName: true } },
        _count: { select: { products: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      seller: row.seller,
      logoUrl: row.logoUrl,
      coverUrl: row.coverUrl,
      verified: row.verified,
      featured: row.featured,
      country: row.country,
      contentRightsConfirmedAt: row.contentRightsConfirmedAt?.toISOString() ?? null,
      productCount: row._count.products,
    }));
  }

  async createBrand(
    input: {
      name: string;
      slug?: string;
      sellerId?: string | null;
      logoUrl?: string | null;
      coverUrl?: string | null;
      description?: string | null;
      country?: string | null;
      verified?: boolean;
      featured?: boolean;
      contentRightsConfirmed?: boolean;
    },
    actor: AuthenticatedActor,
  ) {
    const slug = input.slug ? slugify(input.slug) : slugify(input.name);
    const existing = await this.prisma.brand.findUnique({ where: { slug } });
    if (existing) throw AppError.conflict('CONFLICT', `A brand with slug "${slug}" already exists`);

    const brand = await this.prisma.brand.create({
      data: {
        slug,
        name: input.name,
        sellerId: input.sellerId ?? null,
        logoUrl: input.logoUrl ?? null,
        coverUrl: input.coverUrl ?? null,
        description: input.description ?? null,
        country: input.country ?? null,
        verified: input.verified ?? false,
        featured: input.featured ?? false,
        // Appendix C step 3: rights must be explicitly confirmed.
        contentRightsConfirmedAt: input.contentRightsConfirmed ? new Date() : null,
      },
    });
    await this.audit.record(actor, {
      action: 'brand.create',
      objectType: 'Brand',
      objectId: brand.id,
      after: { slug, name: input.name },
    });
    return brand;
  }

  async updateBrand(
    brandId: string,
    input: Partial<{
      name: string;
      logoUrl: string | null;
      coverUrl: string | null;
      description: string | null;
      country: string | null;
      verified: boolean;
      featured: boolean;
      sortOrder: number;
      contentRightsConfirmed: boolean;
    }>,
    actor: AuthenticatedActor,
  ) {
    const before = await this.prisma.brand.findUnique({ where: { id: brandId } });
    if (!before) throw AppError.notFound('Brand', brandId);

    const brand = await this.prisma.brand.update({
      where: { id: brandId },
      data: {
        name: input.name ?? undefined,
        logoUrl: input.logoUrl === null ? null : (input.logoUrl ?? undefined),
        coverUrl: input.coverUrl === null ? null : (input.coverUrl ?? undefined),
        description: input.description === null ? null : (input.description ?? undefined),
        country: input.country === null ? null : (input.country ?? undefined),
        verified: input.verified ?? undefined,
        featured: input.featured ?? undefined,
        sortOrder: input.sortOrder ?? undefined,
        contentRightsConfirmedAt:
          input.contentRightsConfirmed === undefined
            ? undefined
            : input.contentRightsConfirmed
              ? new Date()
              : null,
      },
    });
    await this.audit.recordChange(actor, 'Brand', brandId, 'brand.update', before, brand);
    return brand;
  }

  // ─────────────────────────────────────────────────────── contracts

  async listContracts(sellerId: string) {
    return this.prisma.contract.findMany({
      where: { sellerId },
      orderBy: [{ number: 'asc' }, { version: 'desc' }],
    });
  }

  async createContract(
    sellerId: string,
    input: {
      number: string;
      effectiveFrom: Date | string;
      effectiveTo?: Date | string | null;
      signedAt?: Date | string | null;
      commissionBaseNote?: string | null;
      pspFeeBearer?: string;
      payoutScheduleNote?: string | null;
      documentUrl?: string | null;
    },
    actor: AuthenticatedActor,
  ) {
    const latest = await this.prisma.contract.findFirst({
      where: { sellerId, number: input.number },
      orderBy: { version: 'desc' },
    });

    const contract = await this.prisma.contract.create({
      data: {
        sellerId,
        number: input.number,
        version: (latest?.version ?? 0) + 1,
        effectiveFrom: new Date(input.effectiveFrom),
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
        signedAt: input.signedAt ? new Date(input.signedAt) : null,
        // D-03 and D-05 live here: the commission base and payout schedule are
        // contract terms, recorded per contract rather than assumed in code.
        commissionBaseNote: input.commissionBaseNote ?? null,
        pspFeeBearer: input.pspFeeBearer ?? 'PLATFORM',
        payoutScheduleNote: input.payoutScheduleNote ?? null,
        documentUrl: input.documentUrl ?? null,
      },
    });

    await this.audit.record(actor, {
      action: 'contract.create',
      objectType: 'Contract',
      objectId: contract.id,
      after: { sellerId, number: contract.number, version: contract.version },
      severity: 'CRITICAL',
    });
    return contract;
  }

  // ────────────────────────────────────────────── reference data

  async listCategories(locale: Locale) {
    const rows = await this.prisma.category.findMany({
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }],
      include: {
        parent: { select: { id: true, slug: true } },
        attributeSchema: { select: { id: true, code: true, name: true } },
        _count: { select: { products: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: pickLocalized({ ru: row.nameRu, uz: row.nameUz, en: row.nameEn }, locale),
      nameRu: row.nameRu,
      nameUz: row.nameUz,
      nameEn: row.nameEn,
      parent: row.parent,
      slot: row.slot,
      gender: row.gender,
      isActive: row.isActive,
      attributeSchema: row.attributeSchema,
      productCount: row._count.products,
    }));
  }

  async listSizeCharts() {
    const rows = await this.prisma.sizeChart.findMany({
      orderBy: { code: 'asc' },
      include: {
        brand: { select: { id: true, name: true } },
        category: { select: { id: true, slug: true } },
        _count: { select: { products: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      brand: row.brand,
      category: row.category,
      system: row.system,
      gender: row.gender,
      rowCount: Array.isArray(row.rows) ? (row.rows as unknown[]).length : 0,
      rows: row.rows,
      note: { ru: row.noteRu, uz: row.noteUz, en: row.noteEn },
      productCount: row._count.products,
    }));
  }

  async upsertSizeChart(
    input: {
      code: string;
      brandId?: string | null;
      categoryId?: string | null;
      system?: string;
      gender?: 'WOMEN' | 'MEN' | 'UNISEX' | 'KIDS' | null;
      rows: Array<{
        sizeLabel: string;
        order: number;
        body?: Record<string, number>;
        garment?: Record<string, number>;
      }>;
      noteRu?: string | null;
      noteUz?: string | null;
      noteEn?: string | null;
    },
    actor: AuthenticatedActor,
  ) {
    if (input.rows.length === 0) throw AppError.validation('A size chart needs at least one row');

    // CAT-003: a chart with no measurements is not a chart; the fit engine
    // would silently fall back to chart-only, so reject it at the source.
    const hasMeasurements = input.rows.some(
      (row) =>
        Object.keys(row.body ?? {}).length > 0 || Object.keys(row.garment ?? {}).length > 0,
    );
    if (!hasMeasurements) {
      throw AppError.validation('At least one row must carry body or garment measurements (in mm)');
    }

    const chart = await this.prisma.sizeChart.upsert({
      where: { code: input.code },
      create: {
        code: input.code,
        brandId: input.brandId ?? null,
        categoryId: input.categoryId ?? null,
        system: input.system ?? 'letter',
        gender: input.gender ?? null,
        rows: input.rows as unknown as Prisma.InputJsonValue,
        noteRu: input.noteRu ?? null,
        noteUz: input.noteUz ?? null,
        noteEn: input.noteEn ?? null,
      },
      update: {
        brandId: input.brandId ?? undefined,
        categoryId: input.categoryId ?? undefined,
        system: input.system ?? undefined,
        gender: input.gender ?? undefined,
        rows: input.rows as unknown as Prisma.InputJsonValue,
        noteRu: input.noteRu ?? undefined,
        noteUz: input.noteUz ?? undefined,
        noteEn: input.noteEn ?? undefined,
      },
    });

    await this.audit.record(actor, {
      action: 'sizechart.upsert',
      objectType: 'SizeChart',
      objectId: chart.id,
      after: { code: chart.code, rows: input.rows.length },
    });
    return chart;
  }

  /** SEL-007: a scoped, rotatable stock-feed credential. */
  async createInventoryFeed(
    sellerId: string,
    input: { name: string; scopes?: string[] },
    actor: AuthenticatedActor,
  ): Promise<{ id: string; token: string; tokenPrefix: string }> {
    const { randomToken, sha256 } = await import('../common/crypto');
    const token = randomToken(24);
    const prefix = token.slice(0, 8);

    const feed = await this.prisma.inventoryFeed.create({
      data: {
        sellerId,
        name: input.name,
        tokenHash: sha256(token),
        tokenPrefix: prefix,
        scopes: input.scopes ?? ['inventory:write', 'price:write'],
      },
    });

    await this.audit.record(actor, {
      action: 'feed.create',
      objectType: 'InventoryFeed',
      objectId: feed.id,
      after: { sellerId, name: input.name, scopes: feed.scopes },
      severity: 'WARNING',
    });

    // The raw token is shown once and never stored.
    return { id: feed.id, token, tokenPrefix: prefix };
  }

  async revokeInventoryFeed(feedId: string, actor: AuthenticatedActor, sellerId?: string) {
    const feed = await this.prisma.inventoryFeed.findFirst({
      where: { id: feedId, ...(sellerId ? { sellerId } : {}) },
    });
    if (!feed) throw AppError.notFound('InventoryFeed', feedId);
    await this.prisma.inventoryFeed.update({
      where: { id: feedId },
      data: { revokedAt: new Date() },
    });
    await this.audit.record(actor, {
      action: 'feed.revoke',
      objectType: 'InventoryFeed',
      objectId: feedId,
      severity: 'WARNING',
    });
    return { revoked: true };
  }

  /** FUL-001: delivery methods per seller and zone. */
  async upsertDeliveryMethod(
    sellerId: string,
    input: {
      code: string;
      zoneId?: string | null;
      kind?: 'COURIER' | 'PICKUP_POINT' | 'STORE_PICKUP' | 'EXPRESS_COURIER';
      nameRu: string;
      nameUz: string;
      nameEn?: string | null;
      priceMinor: string;
      freeOverMinor?: string | null;
      minDays: number;
      maxDays: number;
      isActive?: boolean;
      pickupAddress?: string | null;
    },
    actor: AuthenticatedActor,
  ) {
    if (input.minDays > input.maxDays) {
      throw AppError.validation('minDays cannot exceed maxDays');
    }
    // `zoneId` is a nullable part of the unique key, so Prisma's compound
    // `where` cannot express "the row with no zone". Match it explicitly.
    const existing = await this.prisma.sellerDeliveryMethod.findFirst({
      where: { sellerId, code: input.code, zoneId: input.zoneId ?? null },
      select: { id: true },
    });

    const payload = {
      kind: input.kind ?? 'COURIER',
      nameRu: input.nameRu,
      nameUz: input.nameUz,
      nameEn: input.nameEn ?? null,
      priceMinor: BigInt(input.priceMinor),
      freeOverMinor: input.freeOverMinor ? BigInt(input.freeOverMinor) : null,
      minDays: input.minDays,
      maxDays: input.maxDays,
      isActive: input.isActive ?? true,
      pickupAddress: input.pickupAddress ?? null,
    } as const;

    const method = existing
      ? await this.prisma.sellerDeliveryMethod.update({ where: { id: existing.id }, data: payload })
      : await this.prisma.sellerDeliveryMethod.create({
          data: { sellerId, code: input.code, zoneId: input.zoneId ?? null, ...payload },
        });
    await this.audit.record(actor, {
      action: 'delivery.upsert',
      objectType: 'SellerDeliveryMethod',
      objectId: method.id,
      after: { sellerId, code: input.code },
    });
    return method;
  }

  /** FUL-005: the seller's return policy, versioned. */
  async upsertReturnPolicy(
    sellerId: string,
    input: {
      code: string;
      windowDays: number;
      conditionsRu: string;
      conditionsUz: string;
      conditionsEn?: string | null;
      whoPaysReturn?: 'BUYER' | 'SELLER' | 'PLATFORM';
      nonReturnableCategories?: string[];
      nonReturnableReasons?: string[];
      isDefault?: boolean;
    },
    actor: AuthenticatedActor,
  ) {
    const latest = await this.prisma.returnPolicy.findUnique({ where: { code: input.code } });
    const policy = await this.prisma.returnPolicy.upsert({
      where: { code: input.code },
      create: {
        code: input.code,
        sellerId,
        windowDays: input.windowDays,
        conditionsRu: input.conditionsRu,
        conditionsUz: input.conditionsUz,
        conditionsEn: input.conditionsEn ?? null,
        whoPaysReturn: input.whoPaysReturn ?? 'BUYER',
        nonReturnableCategories: input.nonReturnableCategories ?? [],
        nonReturnableReasons: input.nonReturnableReasons ?? [],
        isDefault: input.isDefault ?? false,
      },
      update: {
        windowDays: input.windowDays,
        conditionsRu: input.conditionsRu,
        conditionsUz: input.conditionsUz,
        conditionsEn: input.conditionsEn ?? undefined,
        whoPaysReturn: input.whoPaysReturn ?? undefined,
        nonReturnableCategories: input.nonReturnableCategories ?? undefined,
        nonReturnableReasons: input.nonReturnableReasons ?? undefined,
        isDefault: input.isDefault ?? undefined,
        version: (latest?.version ?? 0) + 1,
      },
    });
    await this.audit.record(actor, {
      action: 'returnpolicy.upsert',
      objectType: 'ReturnPolicy',
      objectId: policy.id,
      after: { code: policy.code, windowDays: policy.windowDays, version: policy.version },
      severity: 'NOTICE',
    });
    return policy;
  }

  async addPayoutAccount(
    sellerId: string,
    input: {
      bankName: string;
      accountName: string;
      accountNumber: string;
      mfo?: string | null;
      inn?: string | null;
      isDefault?: boolean;
    },
    actor: AuthenticatedActor,
  ) {
    // Only a masked form is persisted; the full number belongs in the vault.
    const digits = input.accountNumber.replace(/\D/g, '');
    const masked = digits.length > 4 ? `•••• ${digits.slice(-4)}` : '••••';

    const account = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.payoutAccount.updateMany({ where: { sellerId }, data: { isDefault: false } });
      }
      return tx.payoutAccount.create({
        data: {
          sellerId,
          bankName: input.bankName,
          accountName: input.accountName,
          accountNumberMasked: masked,
          mfo: input.mfo ?? null,
          inn: input.inn ?? null,
          isDefault: input.isDefault ?? true,
        },
      });
    });

    await this.audit.record(actor, {
      action: 'payoutaccount.create',
      objectType: 'PayoutAccount',
      objectId: account.id,
      after: { sellerId, bankName: input.bankName, masked },
      severity: 'CRITICAL',
    });
    return account;
  }

  private async uniqueSellerSlug(source: string): Promise<string> {
    const base = slugify(source) || 'seller';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.prisma.seller.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}
