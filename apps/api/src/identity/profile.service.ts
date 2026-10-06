/**
 * Buyer profile, consent and privacy centre — spec §4.2.
 *
 * USR-002 versioned terms/privacy/consent, storing version, language, time and source
 * USR-003 skippable style quiz; buying never requires it
 * USR-004 voluntary fit profile, every field individually deletable
 * USR-005 address book and recipients; geo only with consent
 * USR-006 privacy centre: consent, personalisation off, deletion, requests
 * §15.2  minimisation, purpose limitation, retention, user rights
 */

import { Injectable } from '@nestjs/common';
import {
  type ConsentScope,
  type Locale as PrismaLocale,
  type PrivacyRequestKind,
  Prisma,
} from '@prisma/client';
import {
  type AddressView,
  type FitPreference,
  type FitProfileView,
  type Locale,
  type MeView,
  type StyleProfileView,
  MEASUREMENT_KEYS,
  money,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';
import { AuditService } from '../common/audit.service';
import { nullableMoney, toMinor } from '../common/money.util';
import type { AuthenticatedActor } from '../common/http';

/** USR-002: the consent texts in force. Bump the version when the text changes. */
export const CONSENT_DOCUMENT_VERSIONS: Record<ConsentScope, string> = {
  TERMS: '2026-09-01',
  PRIVACY: '2026-09-01',
  PERSONALIZATION: '2026-09-01',
  FIT_PROFILE: '2026-09-01',
  MARKETING: '2026-09-01',
  PHOTO_ANALYSIS: '2026-09-01',
  ANALYTICS: '2026-09-01',
};

/** Consents that must exist before an order can be placed. */
export const REQUIRED_CONSENTS: ConsentScope[] = ['TERMS', 'PRIVACY'];

const MAX_MEASUREMENT_MM = 3000;

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getMe(userId: string): Promise<MeView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        telegramIdentity: true,
        styleProfile: true,
        fitProfile: true,
        consents: { orderBy: { grantedAt: 'desc' } },
      },
    });
    if (!user || user.deletedAt) throw AppError.notFound('User', userId);

    const [orders, wishlist, cart] = await Promise.all([
      this.prisma.order.count({ where: { userId, status: { notIn: ['DRAFT', 'QUOTED'] } } }),
      this.prisma.wishlistItem.count({ where: { userId } }),
      this.prisma.cartItem.count({ where: { cart: { userId, isActive: true } } }),
    ]);

    // Latest state per scope: a later revocation overrides an earlier grant.
    const consents: MeView['consents'] = {};
    for (const consent of user.consents) {
      if (consents[consent.scope]) continue;
      consents[consent.scope] = {
        granted: consent.granted && !consent.revokedAt,
        version: consent.documentVersion,
        at: (consent.revokedAt ?? consent.grantedAt).toISOString(),
      };
    }

    return {
      id: user.id,
      telegramId: user.telegramIdentity ? user.telegramIdentity.telegramId.toString() : null,
      firstName: user.firstName,
      username: user.displayUsername,
      photoUrl: user.photoUrl,
      locale: user.locale as Locale,
      phone: user.phone,
      consents,
      styleProfile: user.styleProfile ? mapStyleProfile(user.styleProfile) : null,
      fitProfile: user.fitProfile ? mapFitProfile(user.fitProfile) : null,
      personalizationEnabled: user.personalizationEnabled,
      isNewUser: orders === 0,
      stats: { orders, wishlist, cartItems: cart },
    };
  }

  async setLocale(userId: string, locale: Locale): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { locale: locale as PrismaLocale },
    });
  }

  /** USR-002: record scope, version, language, timestamp and source. */
  async recordConsents(
    userId: string,
    grants: Array<{ scope: ConsentScope; granted: boolean }>,
    context: { locale: Locale; source: string; ipHash?: string | null; correlationId?: string },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const grant of grants) {
        // Revoking closes the open grant so the history stays readable.
        if (!grant.granted) {
          await tx.consent.updateMany({
            where: { userId, scope: grant.scope, granted: true, revokedAt: null },
            data: { revokedAt: now },
          });
        }
        await tx.consent.create({
          data: {
            userId,
            scope: grant.scope,
            granted: grant.granted,
            documentVersion: CONSENT_DOCUMENT_VERSIONS[grant.scope],
            locale: context.locale as PrismaLocale,
            source: context.source,
            ipHash: context.ipHash ?? null,
            revokedAt: grant.granted ? null : now,
          },
        });

        // UAT-19: withdrawing fit consent must stop new personalised fit uses
        // immediately, not at the next login.
        if (grant.scope === 'FIT_PROFILE' && !grant.granted) {
          await tx.fitProfile.updateMany({
            where: { userId },
            data: { consentPersonalizedFit: false },
          });
        }
        if (grant.scope === 'PERSONALIZATION') {
          await tx.user.update({
            where: { id: userId },
            data: { personalizationEnabled: grant.granted },
          });
        }
      }
    });

    await this.audit.record(
      { kind: 'user', userId, roles: [], permissions: new Set() },
      {
        action: 'consent.update',
        objectType: 'User',
        objectId: userId,
        after: grants,
        correlationId: context.correlationId,
        severity: 'NOTICE',
      },
    );
  }

  /** Order placement checks this (§15.1: proof of acceptance must exist). */
  async assertRequiredConsents(userId: string): Promise<void> {
    const consents = await this.prisma.consent.findMany({
      where: { userId, scope: { in: REQUIRED_CONSENTS }, granted: true, revokedAt: null },
      select: { scope: true, documentVersion: true },
    });
    const missing = REQUIRED_CONSENTS.filter(
      (scope) =>
        !consents.some(
          (consent) =>
            consent.scope === scope && consent.documentVersion === CONSENT_DOCUMENT_VERSIONS[scope],
        ),
    );
    if (missing.length > 0) {
      throw new AppError('CONSENT_REQUIRED', {
        message: 'Terms and privacy notice must be accepted',
        details: {
          missing,
          versions: Object.fromEntries(missing.map((scope) => [scope, CONSENT_DOCUMENT_VERSIONS[scope]])),
        },
      });
    }
  }

  // ───────────────────────────────────────────── style quiz (USR-003)

  async upsertStyleProfile(
    userId: string,
    input: {
      styles?: string[];
      colors?: string[];
      dislikedColors?: string[];
      favouriteBrandIds?: string[];
      budgetPerItemMinor?: string | null;
      preferredFit?: FitPreference | null;
      sizes?: Record<string, string>;
      occasions?: string[];
      completed?: boolean;
    },
  ): Promise<StyleProfileView> {
    const data = {
      styles: input.styles ?? undefined,
      colors: input.colors ?? undefined,
      dislikedColors: input.dislikedColors ?? undefined,
      favouriteBrandIds: input.favouriteBrandIds ?? undefined,
      budgetPerItemMinor:
        input.budgetPerItemMinor === null
          ? null
          : input.budgetPerItemMinor !== undefined
            ? toMinor(input.budgetPerItemMinor)
            : undefined,
      preferredFit: input.preferredFit === null ? null : (input.preferredFit ?? undefined),
      sizes: input.sizes ? (input.sizes as Prisma.InputJsonValue) : undefined,
      occasions: input.occasions ?? undefined,
      completedAt: input.completed ? new Date() : undefined,
    };

    const profile = await this.prisma.styleProfile.upsert({
      where: { userId },
      create: {
        userId,
        styles: input.styles ?? [],
        colors: input.colors ?? [],
        dislikedColors: input.dislikedColors ?? [],
        favouriteBrandIds: input.favouriteBrandIds ?? [],
        budgetPerItemMinor: input.budgetPerItemMinor ? toMinor(input.budgetPerItemMinor) : null,
        preferredFit: input.preferredFit ?? null,
        sizes: (input.sizes ?? {}) as Prisma.InputJsonValue,
        occasions: input.occasions ?? [],
        completedAt: input.completed ? new Date() : null,
      },
      update: data,
    });
    return mapStyleProfile(profile);
  }

  async clearStyleProfile(userId: string): Promise<void> {
    await this.prisma.styleProfile.deleteMany({ where: { userId } });
  }

  // ──────────────────────────────────────────── fit profile (USR-004)

  async upsertFitProfile(
    userId: string,
    input: {
      heightMm?: number | null;
      weightGrams?: number | null;
      measurements?: Record<string, number | null>;
      preferredFit?: FitPreference | null;
      usualSizes?: Record<string, string>;
      consentPersonalizedFit?: boolean;
    },
  ): Promise<FitProfileView> {
    const existing = await this.prisma.fitProfile.findUnique({ where: { userId } });
    const current = (existing?.measurements as Record<string, number>) ?? {};

    // USR-004 acceptance criterion: each field can be deleted. Sending null
    // for a measurement removes it rather than storing a zero.
    const merged: Record<string, number> = { ...current };
    for (const [key, value] of Object.entries(input.measurements ?? {})) {
      if (!MEASUREMENT_KEYS.includes(key as (typeof MEASUREMENT_KEYS)[number])) {
        throw AppError.validation(`Unknown measurement "${key}"`, {
          allowed: [...MEASUREMENT_KEYS],
        });
      }
      if (value === null) {
        delete merged[key];
        continue;
      }
      if (!Number.isInteger(value) || value <= 0 || value > MAX_MEASUREMENT_MM) {
        throw AppError.validation(`Measurement "${key}" must be an integer in millimetres (1..3000)`);
      }
      merged[key] = value;
    }

    if (input.heightMm != null && (input.heightMm < 1000 || input.heightMm > 2300)) {
      throw AppError.validation('heightMm must be between 1000 and 2300');
    }
    if (input.weightGrams != null && (input.weightGrams < 30_000 || input.weightGrams > 250_000)) {
      throw AppError.validation('weightGrams must be between 30000 and 250000');
    }

    const profile = await this.prisma.fitProfile.upsert({
      where: { userId },
      create: {
        userId,
        heightMm: input.heightMm ?? null,
        weightGrams: input.weightGrams ?? null,
        measurements: merged as Prisma.InputJsonValue,
        preferredFit: input.preferredFit ?? null,
        usualSizes: (input.usualSizes ?? {}) as Prisma.InputJsonValue,
        consentPersonalizedFit: input.consentPersonalizedFit ?? false,
      },
      update: {
        heightMm: input.heightMm === null ? null : (input.heightMm ?? undefined),
        weightGrams: input.weightGrams === null ? null : (input.weightGrams ?? undefined),
        measurements: merged as Prisma.InputJsonValue,
        preferredFit: input.preferredFit === null ? null : (input.preferredFit ?? undefined),
        usualSizes: input.usualSizes ? (input.usualSizes as Prisma.InputJsonValue) : undefined,
        consentPersonalizedFit: input.consentPersonalizedFit ?? undefined,
      },
    });

    await this.audit.record(
      { kind: 'user', userId, roles: [], permissions: new Set() },
      {
        action: 'fitprofile.update',
        objectType: 'FitProfile',
        objectId: profile.id,
        // §15.2 "body data is high-risk": record that it changed, not what to.
        after: { fieldsPresent: Object.keys(merged), consent: profile.consentPersonalizedFit },
        severity: 'NOTICE',
      },
    );

    return mapFitProfile(profile);
  }

  async deleteFitProfile(userId: string): Promise<void> {
    await this.prisma.fitProfile.deleteMany({ where: { userId } });
    await this.audit.record(
      { kind: 'user', userId, roles: [], permissions: new Set() },
      { action: 'fitprofile.delete', objectType: 'FitProfile', objectId: userId, severity: 'NOTICE' },
    );
  }

  // ─────────────────────────────────────────── address book (USR-005)

  async listAddresses(userId: string): Promise<AddressView[]> {
    const rows = await this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(mapAddress);
  }

  async createAddress(userId: string, input: CreateAddressInput): Promise<AddressView> {
    const count = await this.prisma.address.count({ where: { userId, deletedAt: null } });
    if (count >= 20) throw AppError.validation('Address book limit reached (20)');

    const address = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault || count === 0) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.address.create({
        data: {
          userId,
          label: input.label ?? '',
          recipientName: input.recipientName,
          phone: normalizePhone(input.phone),
          city: input.city,
          district: input.district ?? null,
          street: input.street,
          building: input.building,
          apartment: input.apartment ?? null,
          entrance: input.entrance ?? null,
          floor: input.floor ?? null,
          landmark: input.landmark ?? null,
          postalCode: input.postalCode ?? null,
          // USR-005: coordinates are stored only when the shopper consented.
          lat: input.geoConsent ? (input.lat ?? null) : null,
          lng: input.geoConsent ? (input.lng ?? null) : null,
          geoConsentAt: input.geoConsent ? new Date() : null,
          isDefault: input.isDefault || count === 0,
        },
      });
    });
    return mapAddress(address);
  }

  async updateAddress(userId: string, addressId: string, input: Partial<CreateAddressInput>): Promise<AddressView> {
    const existing = await this.prisma.address.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    });
    if (!existing) throw AppError.notFound('Address', addressId);

    const address = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.address.update({
        where: { id: addressId },
        data: {
          label: input.label ?? undefined,
          recipientName: input.recipientName ?? undefined,
          phone: input.phone ? normalizePhone(input.phone) : undefined,
          city: input.city ?? undefined,
          district: input.district === null ? null : (input.district ?? undefined),
          street: input.street ?? undefined,
          building: input.building ?? undefined,
          apartment: input.apartment === null ? null : (input.apartment ?? undefined),
          entrance: input.entrance === null ? null : (input.entrance ?? undefined),
          floor: input.floor === null ? null : (input.floor ?? undefined),
          landmark: input.landmark === null ? null : (input.landmark ?? undefined),
          postalCode: input.postalCode === null ? null : (input.postalCode ?? undefined),
          lat: input.geoConsent === false ? null : (input.lat ?? undefined),
          lng: input.geoConsent === false ? null : (input.lng ?? undefined),
          geoConsentAt: input.geoConsent === false ? null : input.geoConsent ? new Date() : undefined,
          isDefault: input.isDefault ?? undefined,
        },
      });
    });
    return mapAddress(address);
  }

  async deleteAddress(userId: string, addressId: string): Promise<void> {
    // Soft delete: ORD-004 keeps an address snapshot on the order, but an
    // order row may still reference the address id for support lookups.
    const result = await this.prisma.address.updateMany({
      where: { id: addressId, userId, deletedAt: null },
      data: { deletedAt: new Date(), isDefault: false },
    });
    if (result.count === 0) throw AppError.notFound('Address', addressId);
  }

  // ─────────────────────────────────────── privacy centre (USR-006)

  async setPersonalization(userId: string, enabled: boolean): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { personalizationEnabled: enabled } });
    await this.recordConsents(userId, [{ scope: 'PERSONALIZATION', granted: enabled }], {
      locale: 'ru',
      source: 'privacy_center',
    });
  }

  async createPrivacyRequest(
    userId: string,
    kind: PrivacyRequestKind,
    details?: string,
  ): Promise<{ id: string; dueAt: Date }> {
    const open = await this.prisma.privacyRequest.findFirst({
      where: { userId, kind, status: { in: ['RECEIVED', 'IN_PROGRESS'] } },
    });
    if (open) {
      return { id: open.id, dueAt: open.dueAt ?? new Date() };
    }

    // 30 days is the working SLA the operations runbook commits to; the legal
    // deadline is confirmed by counsel per §15.2.
    const dueAt = new Date(Date.now() + 30 * 86_400_000);
    const request = await this.prisma.privacyRequest.create({
      data: { userId, kind, details: details ?? null, dueAt },
    });

    await this.audit.record(
      { kind: 'user', userId, roles: [], permissions: new Set() },
      {
        action: 'privacy.request',
        objectType: 'PrivacyRequest',
        objectId: request.id,
        after: { kind },
        severity: 'NOTICE',
      },
    );
    return { id: request.id, dueAt };
  }

  async listPrivacyRequests(userId: string) {
    return this.prisma.privacyRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, kind: true, status: true, createdAt: true, completedAt: true, dueAt: true },
    });
  }

  /**
   * USR-006 / §15.2 user rights: a machine-readable copy of everything we hold.
   * Deliberately assembled here rather than exported from the DB so the shape
   * is reviewable and no internal column leaks by accident.
   */
  async exportUserData(userId: string): Promise<Record<string, unknown>> {
    const [user, addresses, consents, orders, wishlist, feedback, outfits, reviews] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        include: { styleProfile: true, fitProfile: true, telegramIdentity: true },
      }),
      this.prisma.address.findMany({ where: { userId, deletedAt: null } }),
      this.prisma.consent.findMany({ where: { userId }, orderBy: { grantedAt: 'asc' } }),
      this.prisma.order.findMany({
        where: { userId },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.wishlistItem.findMany({ where: { userId } }),
      this.prisma.fitFeedback.findMany({ where: { userId } }),
      this.prisma.outfitSession.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.prisma.review.findMany({ where: { userId } }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        locale: user.locale,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.displayUsername,
        phone: user.phone,
        telegramId: user.telegramIdentity?.telegramId?.toString() ?? null,
        personalizationEnabled: user.personalizationEnabled,
        createdAt: user.createdAt,
      },
      styleProfile: user.styleProfile,
      fitProfile: user.fitProfile,
      addresses,
      consents,
      orders: orders.map((order) => ({
        number: order.number,
        status: order.status,
        placedAt: order.placedAt,
        grandTotalMinor: order.grandTotalMinor.toString(),
        currency: order.currency,
        items: order.items.map((item) => ({
          title: item.productTitle,
          brand: item.brandName,
          size: item.sizeLabel,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor.toString(),
        })),
      })),
      wishlist: wishlist.map((item) => ({ productId: item.productId, addedAt: item.createdAt })),
      fitFeedback: feedback,
      stylistSessions: outfits.map((session) => ({
        query: session.rawQuery,
        createdAt: session.createdAt,
        totalMinor: session.totalMinor?.toString() ?? null,
      })),
      reviews,
    };
  }

  /**
   * USR-006 account deletion. Orders and ledger entries must survive for
   * accounting and legal retention (§15.1), so the account is anonymised
   * rather than hard-deleted, and everything voluntary is removed outright.
   */
  async deleteAccount(userId: string, actor: AuthenticatedActor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.fitProfile.deleteMany({ where: { userId } });
      await tx.styleProfile.deleteMany({ where: { userId } });
      await tx.wishlistItem.deleteMany({ where: { userId } });
      await tx.stockSubscription.deleteMany({ where: { userId } });
      await tx.address.updateMany({
        where: { userId },
        data: {
          deletedAt: new Date(),
          recipientName: '[deleted]',
          phone: '[deleted]',
          street: '[deleted]',
          building: '[deleted]',
          apartment: null,
          landmark: null,
          lat: null,
          lng: null,
        },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'account_deleted' },
      });
      await tx.telegramIdentity.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: new Date(),
          anonymizedAt: new Date(),
          firstName: null,
          lastName: null,
          displayUsername: null,
          photoUrl: null,
          phone: null,
          personalizationEnabled: false,
        },
      });
      await tx.privacyRequest.updateMany({
        where: { userId, kind: 'DELETION', status: { in: ['RECEIVED', 'IN_PROGRESS'] } },
        data: { status: 'COMPLETED', completedAt: new Date(), resolution: 'Account anonymised' },
      });
    });

    await this.audit.record(actor, {
      action: 'account.delete',
      objectType: 'User',
      objectId: userId,
      after: { method: 'anonymize', retained: 'orders, ledger (legal retention)' },
      severity: 'CRITICAL',
    });
  }

  async setPhone(userId: string, phone: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { phone: normalizePhone(phone) } });
  }
}

export interface CreateAddressInput {
  label?: string;
  recipientName: string;
  phone: string;
  city: string;
  district?: string | null;
  street: string;
  building: string;
  apartment?: string | null;
  entrance?: string | null;
  floor?: string | null;
  landmark?: string | null;
  postalCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  geoConsent?: boolean;
  isDefault?: boolean;
}

function mapAddress(row: {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  city: string;
  district: string | null;
  street: string;
  building: string;
  apartment: string | null;
  landmark: string | null;
  postalCode: string | null;
  isDefault: boolean;
  lat: number | null;
  lng: number | null;
}): AddressView {
  return {
    id: row.id,
    label: row.label,
    recipientName: row.recipientName,
    phone: row.phone,
    city: row.city,
    district: row.district,
    street: row.street,
    building: row.building,
    apartment: row.apartment,
    landmark: row.landmark,
    postalCode: row.postalCode,
    isDefault: row.isDefault,
    lat: row.lat,
    lng: row.lng,
  };
}

function mapStyleProfile(row: {
  styles: string[];
  colors: string[];
  dislikedColors: string[];
  favouriteBrandIds: string[];
  budgetPerItemMinor: bigint | null;
  currency: string;
  preferredFit: string | null;
  sizes: unknown;
  completedAt: Date | null;
}): StyleProfileView {
  return {
    styles: row.styles as StyleProfileView['styles'],
    colors: row.colors as StyleProfileView['colors'],
    dislikedColors: row.dislikedColors as StyleProfileView['dislikedColors'],
    favouriteBrandIds: row.favouriteBrandIds,
    budgetPerItem: nullableMoney(row.budgetPerItemMinor, row.currency),
    preferredFit: row.preferredFit as FitPreference | null,
    sizes: (row.sizes as Record<string, string>) ?? {},
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function mapFitProfile(row: {
  heightMm: number | null;
  weightGrams: number | null;
  measurements: unknown;
  preferredFit: string | null;
  usualSizes: unknown;
  consentPersonalizedFit: boolean;
  updatedAt: Date;
}): FitProfileView {
  return {
    heightMm: row.heightMm,
    weightGrams: row.weightGrams,
    measurements: (row.measurements as Record<string, number>) ?? {},
    preferredFit: row.preferredFit as FitPreference | null,
    usualSizes: (row.usualSizes as Record<string, string>) ?? {},
    consentPersonalizedFit: row.consentPersonalizedFit,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Uzbek numbers normalise to +998XXXXXXXXX; anything else is kept as typed. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  if (phone.startsWith('+')) return `+${digits}`;
  return digits;
}

export { money };
