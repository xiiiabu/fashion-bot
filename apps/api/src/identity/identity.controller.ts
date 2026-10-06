/**
 * Auth and profile endpoints — API group "Auth & profile" (§14.2):
 * /auth/telegram, /me, /consents, /addresses, /privacy-requests.
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { COLOR_FAMILIES, FIT_PREFERENCES, LOCALES, OCCASIONS, STYLE_TAGS, type Locale } from '@fashion/core';
import { AuthService } from './auth.service';
import { ProfileService, CONSENT_DOCUMENT_VERSIONS } from './profile.service';
import { OptionalAuth, Public } from './guards';
import {
  Actor,
  type AppRequest,
  CorrelationId,
  CurrentUserId,
  RateLimit,
  RequestLocale,
  zodBody,
} from '../common/http';
import type { AuthenticatedActor } from '../common/http';
import { loadConfig } from '../common/config';

const telegramAuthSchema = z.object({
  initData: z.string().min(1).max(8192),
  platform: z.string().max(64).optional(),
});

const devAuthSchema = z.object({
  secret: z.string().min(1),
  telegramId: z.number().int().positive().optional(),
  firstName: z.string().max(64).optional(),
  locale: z.enum(LOCALES).optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(16) });

const consentSchema = z.object({
  consents: z
    .array(
      z.object({
        scope: z.enum([
          'TERMS',
          'PRIVACY',
          'PERSONALIZATION',
          'FIT_PROFILE',
          'MARKETING',
          'PHOTO_ANALYSIS',
          'ANALYTICS',
        ]),
        granted: z.boolean(),
      }),
    )
    .min(1)
    .max(10),
  source: z.string().max(64).default('miniapp'),
});

const localeSchema = z.object({ locale: z.enum(LOCALES) });

const styleProfileSchema = z.object({
  styles: z.array(z.enum(STYLE_TAGS)).max(8).optional(),
  colors: z.array(z.enum(COLOR_FAMILIES)).max(10).optional(),
  dislikedColors: z.array(z.enum(COLOR_FAMILIES)).max(10).optional(),
  favouriteBrandIds: z.array(z.string().uuid()).max(30).optional(),
  budgetPerItemMinor: z.string().regex(/^\d+$/).nullable().optional(),
  preferredFit: z.enum(FIT_PREFERENCES).nullable().optional(),
  sizes: z.record(z.string(), z.string().max(12)).optional(),
  occasions: z.array(z.enum(OCCASIONS)).max(8).optional(),
  completed: z.boolean().optional(),
});

const fitProfileSchema = z.object({
  heightMm: z.number().int().nullable().optional(),
  weightGrams: z.number().int().nullable().optional(),
  measurements: z.record(z.string(), z.number().int().nullable()).optional(),
  preferredFit: z.enum(FIT_PREFERENCES).nullable().optional(),
  usualSizes: z.record(z.string(), z.string().max(12)).optional(),
  consentPersonalizedFit: z.boolean().optional(),
});

const addressSchema = z.object({
  label: z.string().max(40).optional(),
  recipientName: z.string().min(2).max(120),
  phone: z.string().min(7).max(24),
  city: z.string().min(2).max(80),
  district: z.string().max(80).nullable().optional(),
  street: z.string().min(2).max(160),
  building: z.string().min(1).max(40),
  apartment: z.string().max(40).nullable().optional(),
  entrance: z.string().max(20).nullable().optional(),
  floor: z.string().max(20).nullable().optional(),
  landmark: z.string().max(200).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  geoConsent: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

const privacyRequestSchema = z.object({
  kind: z.enum(['ACCESS', 'CORRECTION', 'DELETION', 'ANONYMIZATION', 'CONSENT_WITHDRAWAL', 'PROCESSING_INFO']),
  details: z.string().max(2000).optional(),
});

@Controller()
export class IdentityController {
  private readonly config = loadConfig();

  constructor(
    private readonly auth: AuthService,
    private readonly profile: ProfileService,
  ) {}

  /** TG-001/TG-003. The only way the Mini App obtains a session. */
  @Public()
  @RateLimit({ bucket: 'auth' })
  @Post('auth/telegram')
  async telegram(
    @Body(zodBody(telegramAuthSchema)) body: z.infer<typeof telegramAuthSchema>,
    @Req() request: AppRequest,
  ) {
    const result = await this.auth.authenticateWithTelegram(body.initData, {
      userAgent: request.header('user-agent'),
      ipHash: request.ipHash,
      platform: body.platform ?? null,
      correlationId: request.correlationId,
    });
    return { ...result, consentVersions: CONSENT_DOCUMENT_VERSIONS };
  }

  /** Development-only. Refuses to run with NODE_ENV=production. */
  @Public()
  @RateLimit({ bucket: 'auth' })
  @Post('auth/dev')
  async dev(
    @Body(zodBody(devAuthSchema)) body: z.infer<typeof devAuthSchema>,
    @Req() request: AppRequest,
  ) {
    const result = await this.auth.authenticateDev(body, {
      userAgent: request.header('user-agent'),
      ipHash: request.ipHash,
      platform: 'dev',
      correlationId: request.correlationId,
    });
    return { ...result, consentVersions: CONSENT_DOCUMENT_VERSIONS };
  }

  @Public()
  @RateLimit({ bucket: 'auth' })
  @Post('auth/refresh')
  async refresh(
    @Body(zodBody(refreshSchema)) body: z.infer<typeof refreshSchema>,
    @Req() request: AppRequest,
  ) {
    return this.auth.refresh(body.refreshToken, {
      userAgent: request.header('user-agent'),
      ipHash: request.ipHash,
      correlationId: request.correlationId,
    });
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Actor() actor: AuthenticatedActor): Promise<void> {
    if (actor.sessionId) await this.auth.revoke(actor.sessionId, 'logout');
  }

  @Post('auth/logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentUserId() userId: string): Promise<void> {
    await this.auth.revokeAllForUser(userId, 'logout_all');
  }

  /** Tells the Mini App what this deployment supports before it authenticates. */
  @Public()
  @Get('auth/config')
  authConfig() {
    return {
      telegramConfigured: this.config.telegramConfigured,
      devAuthEnabled: this.config.DEV_AUTH_ENABLED && !this.config.isProduction,
      botUsername: this.config.TELEGRAM_BOT_USERNAME || null,
      locales: LOCALES,
      defaultCurrency: this.config.DEFAULT_CURRENCY,
      consentVersions: CONSENT_DOCUMENT_VERSIONS,
      /** Payments are not live in this release (§8.4 decision gate). */
      paymentsLive: this.config.PAYMENTS_LIVE,
      paymentProviders: this.config.PAYMENT_PROVIDERS,
    };
  }

  @Get('me')
  async me(@CurrentUserId() userId: string) {
    return this.profile.getMe(userId);
  }

  @Get('me/sessions')
  async sessions(@CurrentUserId() userId: string) {
    return { items: await this.auth.listSessions(userId) };
  }

  @Patch('me/locale')
  async setLocale(
    @CurrentUserId() userId: string,
    @Body(zodBody(localeSchema)) body: z.infer<typeof localeSchema>,
  ) {
    await this.profile.setLocale(userId, body.locale);
    return { locale: body.locale };
  }

  @Patch('me/phone')
  async setPhone(
    @CurrentUserId() userId: string,
    @Body(zodBody(z.object({ phone: z.string().min(7).max(24) }))) body: { phone: string },
  ) {
    await this.profile.setPhone(userId, body.phone);
    return { ok: true };
  }

  // ───────────────────────────────────────────────────────── consents

  @Public()
  @Get('consents/versions')
  consentVersions() {
    return { versions: CONSENT_DOCUMENT_VERSIONS };
  }

  @Post('consents')
  async setConsents(
    @CurrentUserId() userId: string,
    @Body(zodBody(consentSchema)) body: z.infer<typeof consentSchema>,
    @RequestLocale() locale: Locale,
    @Req() request: AppRequest,
    @CorrelationId() correlationId: string,
  ) {
    await this.profile.recordConsents(userId, body.consents, {
      locale,
      source: body.source,
      ipHash: request.ipHash,
      correlationId,
    });
    return this.profile.getMe(userId);
  }

  // ───────────────────────────────────────────── style and fit profile

  @Put('me/style-profile')
  async setStyleProfile(
    @CurrentUserId() userId: string,
    @Body(zodBody(styleProfileSchema)) body: z.infer<typeof styleProfileSchema>,
  ) {
    return this.profile.upsertStyleProfile(userId, body);
  }

  @Delete('me/style-profile')
  @HttpCode(204)
  async clearStyleProfile(@CurrentUserId() userId: string): Promise<void> {
    await this.profile.clearStyleProfile(userId);
  }

  @Put('me/fit-profile')
  async setFitProfile(
    @CurrentUserId() userId: string,
    @Body(zodBody(fitProfileSchema)) body: z.infer<typeof fitProfileSchema>,
  ) {
    return this.profile.upsertFitProfile(userId, body);
  }

  @Delete('me/fit-profile')
  @HttpCode(204)
  async deleteFitProfile(@CurrentUserId() userId: string): Promise<void> {
    await this.profile.deleteFitProfile(userId);
  }

  // ────────────────────────────────────────────────────── addresses

  @Get('addresses')
  async listAddresses(@CurrentUserId() userId: string) {
    return { items: await this.profile.listAddresses(userId) };
  }

  @Post('addresses')
  async createAddress(
    @CurrentUserId() userId: string,
    @Body(zodBody(addressSchema)) body: z.infer<typeof addressSchema>,
  ) {
    return this.profile.createAddress(userId, body);
  }

  @Patch('addresses/:id')
  async updateAddress(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body(zodBody(addressSchema.partial())) body: Partial<z.infer<typeof addressSchema>>,
  ) {
    return this.profile.updateAddress(userId, id, body);
  }

  @Delete('addresses/:id')
  @HttpCode(204)
  async deleteAddress(@CurrentUserId() userId: string, @Param('id') id: string): Promise<void> {
    await this.profile.deleteAddress(userId, id);
  }

  // ──────────────────────────────────────────────── privacy centre

  @Patch('me/personalization')
  async setPersonalization(
    @CurrentUserId() userId: string,
    @Body(zodBody(z.object({ enabled: z.boolean() }))) body: { enabled: boolean },
  ) {
    await this.profile.setPersonalization(userId, body.enabled);
    return { personalizationEnabled: body.enabled };
  }

  @Get('privacy-requests')
  async listPrivacyRequests(@CurrentUserId() userId: string) {
    return { items: await this.profile.listPrivacyRequests(userId) };
  }

  @Post('privacy-requests')
  async createPrivacyRequest(
    @CurrentUserId() userId: string,
    @Body(zodBody(privacyRequestSchema)) body: z.infer<typeof privacyRequestSchema>,
  ) {
    return this.profile.createPrivacyRequest(userId, body.kind, body.details);
  }

  /** §15.2 user rights: immediate machine-readable access. */
  @RateLimit({ max: 5, windowMs: 3_600_000 })
  @Get('me/export')
  async exportData(@CurrentUserId() userId: string) {
    return this.profile.exportUserData(userId);
  }

  @RateLimit({ max: 3, windowMs: 3_600_000 })
  @Post('me/delete')
  async deleteAccount(@CurrentUserId() userId: string, @Actor() actor: AuthenticatedActor) {
    await this.profile.createPrivacyRequest(userId, 'DELETION', 'Requested from privacy centre');
    await this.profile.deleteAccount(userId, actor);
    return { deleted: true, retained: ['orders', 'ledger_entries'] };
  }

  @OptionalAuth()
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', time: new Date().toISOString() };
  }
}
