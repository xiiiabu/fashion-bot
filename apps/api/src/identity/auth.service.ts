/**
 * Buyer authentication — spec §4.1.
 *
 * TG-001 Telegram `initData` is verified server-side (signature + auth_date).
 *        `initDataUnsafe` never reaches this service.
 * TG-003 Verification mints *our* short-lived session with rotation and
 *        revocation; the Telegram payload is never a long-lived bearer token.
 * TG-005 `username` and `photo_url` are optional and are not identity. A user
 *        with neither can complete a purchase.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type Locale as PrismaLocale } from '@prisma/client';
import {
  type Locale,
  decodeDeepLink,
  deepLinkToRoute,
  resolveLocale,
  verifyInitData,
} from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { constantTimeEqual, hmacHex, randomToken, sha256, signJwt, verifyJwt } from '../common/crypto';
import { AuditService } from '../common/audit.service';

export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresIn: number;
  readonly refreshExpiresIn: number;
  readonly sessionId: string;
}

export interface AuthResult extends SessionTokens {
  readonly userId: string;
  readonly isNewUser: boolean;
  readonly locale: Locale;
  /** TG-004: where the deep link should land after authentication. */
  readonly startRoute: string | null;
}

interface SessionContext {
  readonly userAgent?: string | null;
  readonly ipHash?: string | null;
  readonly platform?: string | null;
  readonly correlationId?: string | null;
}

@Injectable()
export class AuthService {
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The Mini App's only entry point: POST /auth/telegram. */
  async authenticateWithTelegram(initData: string, context: SessionContext): Promise<AuthResult> {
    const verification = verifyInitData(initData, this.config.TELEGRAM_BOT_TOKEN, {
      maxAgeSeconds: this.config.TELEGRAM_INITDATA_MAX_AGE,
    });

    if (!verification.ok) {
      // TG-001 acceptance criterion: an invalid or stale payload creates no
      // authenticated session. We log the reason but tell the client nothing
      // that would help forge a better payload.
      logger.warn({ reason: verification.reason }, 'telegram initData rejected');
      if (verification.reason === 'NO_BOT_TOKEN') {
        throw new AppError('FEATURE_DISABLED', {
          message: 'Telegram authentication is not configured on this deployment',
          details: { hint: 'Set TELEGRAM_BOT_TOKEN, or use /auth/dev in development' },
        });
      }
      throw AppError.unauthenticated('Telegram authorization data could not be verified');
    }

    const { user: telegramUser, startParam, authDate } = verification;
    const locale = resolveLocale(telegramUser.language_code);

    const { userId, isNewUser } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.telegramIdentity.findUnique({
        where: { telegramId: BigInt(telegramUser.id) },
        include: { user: true },
      });

      if (existing) {
        if (existing.user.isBlocked) {
          throw AppError.forbidden('This account is blocked', { reason: existing.user.blockedReason });
        }
        await tx.telegramIdentity.update({
          where: { id: existing.id },
          data: {
            // TG-005: these mirror Telegram but are display-only.
            username: telegramUser.username ?? null,
            languageCode: telegramUser.language_code ?? null,
            isPremium: telegramUser.is_premium ?? false,
            allowsWriteToPm: telegramUser.allows_write_to_pm ?? false,
            lastAuthDate: authDate,
          },
        });
        await tx.user.update({
          where: { id: existing.userId },
          data: {
            firstName: telegramUser.first_name ?? existing.user.firstName,
            lastName: telegramUser.last_name ?? existing.user.lastName,
            displayUsername: telegramUser.username ?? null,
            photoUrl: telegramUser.photo_url ?? existing.user.photoUrl,
            lastSeenAt: new Date(),
          },
        });
        return { userId: existing.userId, isNewUser: false };
      }

      const created = await tx.user.create({
        data: {
          locale: locale as PrismaLocale,
          firstName: telegramUser.first_name ?? null,
          lastName: telegramUser.last_name ?? null,
          displayUsername: telegramUser.username ?? null,
          photoUrl: telegramUser.photo_url ?? null,
          lastSeenAt: new Date(),
          telegramIdentity: {
            create: {
              telegramId: BigInt(telegramUser.id),
              username: telegramUser.username ?? null,
              languageCode: telegramUser.language_code ?? null,
              isPremium: telegramUser.is_premium ?? false,
              allowsWriteToPm: telegramUser.allows_write_to_pm ?? false,
              lastAuthDate: authDate,
            },
          },
        },
      });
      return { userId: created.id, isNewUser: true };
    });

    const tokens = await this.issueSession(userId, context);
    await this.audit.record(
      { kind: 'user', userId, roles: [], permissions: new Set() },
      {
        action: isNewUser ? 'auth.register' : 'auth.login',
        objectType: 'User',
        objectId: userId,
        after: { method: 'telegram', isNewUser },
        correlationId: context.correlationId,
        ipHash: context.ipHash,
        userAgent: context.userAgent,
      },
    );

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    return {
      ...tokens,
      userId,
      isNewUser,
      locale: user.locale as Locale,
      startRoute: startParam ? deepLinkToRoute(decodeDeepLink(startParam)) : null,
    };
  }

  /**
   * Development-only sign-in so the Mini App can be demoed in a plain browser.
   * Guarded three ways: the flag, a shared secret, and a hard refusal in
   * production (enforced in loadConfig as well).
   */
  async authenticateDev(
    input: { telegramId?: number; firstName?: string; locale?: string; secret: string },
    context: SessionContext,
  ): Promise<AuthResult> {
    if (!this.config.DEV_AUTH_ENABLED || this.config.isProduction) {
      throw new AppError('FEATURE_DISABLED', { message: 'Development authentication is disabled' });
    }
    if (
      !this.config.DEV_AUTH_SECRET ||
      !constantTimeEqual(input.secret ?? '', this.config.DEV_AUTH_SECRET)
    ) {
      throw AppError.unauthenticated('Invalid development secret');
    }

    const telegramId = BigInt(input.telegramId ?? 777_000_001);
    const locale = resolveLocale(input.locale ?? 'ru');

    const identity = await this.prisma.telegramIdentity.findUnique({
      where: { telegramId },
      include: { user: true },
    });

    let userId: string;
    let isNewUser = false;
    if (identity) {
      userId = identity.userId;
      await this.prisma.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date() },
      });
    } else {
      const created = await this.prisma.user.create({
        data: {
          locale: locale as PrismaLocale,
          firstName: input.firstName ?? 'Demo',
          displayUsername: 'demo_shopper',
          lastSeenAt: new Date(),
          telegramIdentity: {
            create: { telegramId, username: 'demo_shopper', languageCode: locale, lastAuthDate: new Date() },
          },
        },
      });
      userId = created.id;
      isNewUser = true;
    }

    const tokens = await this.issueSession(userId, context);
    logger.warn({ userId }, 'DEV_AUTH session issued — never enable this in production');
    return { ...tokens, userId, isNewUser, locale, startRoute: null };
  }

  /** TG-003: short-lived access token + rotating refresh token. */
  async issueSession(userId: string, context: SessionContext, parentId?: string): Promise<SessionTokens> {
    const refreshToken = randomToken(48);
    const refreshTokenHash = sha256(refreshToken);
    const expiresAt = new Date(Date.now() + this.config.SESSION_REFRESH_TTL * 1000);

    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash,
        parentId: parentId ?? null,
        userAgent: context.userAgent ?? null,
        ipHash: context.ipHash ?? null,
        platform: context.platform ?? null,
        expiresAt,
      },
    });

    const accessToken = signJwt(
      { sub: userId, sid: session.id, kind: 'user' },
      this.config.SESSION_JWT_SECRET,
      this.config.SESSION_ACCESS_TTL,
    );

    return {
      accessToken,
      refreshToken,
      accessExpiresIn: this.config.SESSION_ACCESS_TTL,
      refreshExpiresIn: this.config.SESSION_REFRESH_TTL,
      sessionId: session.id,
    };
  }

  /**
   * Refresh with rotation and reuse detection: presenting an already-rotated
   * refresh token revokes the whole chain, which is the standard defence
   * against a stolen token being replayed (SEC-001 threat model).
   */
  async refresh(refreshToken: string, context: SessionContext): Promise<SessionTokens> {
    const hash = sha256(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: hash } });

    if (!session) throw AppError.unauthenticated('Unknown refresh token');

    if (session.revokedAt) {
      // Reuse of a rotated token: assume compromise and kill every session.
      await this.revokeAllForUser(session.userId, 'refresh_token_reuse');
      logger.warn({ userId: session.userId }, 'refresh token reuse detected — all sessions revoked');
      throw AppError.unauthenticated('Session revoked');
    }

    if (session.expiresAt < new Date()) {
      throw AppError.unauthenticated('Session expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.isBlocked || user.deletedAt) {
      throw AppError.unauthenticated('Account unavailable');
    }

    const [, tokens] = await this.prisma.$transaction([
      this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokedReason: 'rotated', lastUsedAt: new Date() },
      }),
      this.prisma.session.findFirstOrThrow({ where: { id: session.id } }),
    ]);
    void tokens;

    return this.issueSession(session.userId, context, session.id);
  }

  async revoke(sessionId: string, reason = 'logout'): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  /** Called by the auth guard on every request. */
  async resolveAccessToken(
    token: string,
  ): Promise<{ userId: string; sessionId: string } | null> {
    const payload = verifyJwt<{ sub: string; sid: string; kind: string; exp: number; iat: number }>(
      token,
      this.config.SESSION_JWT_SECRET,
    );
    if (!payload || payload.kind !== 'user') return null;

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: { id: true, userId: true, revokedAt: true, expiresAt: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
    if (session.userId !== payload.sub) return null;

    return { userId: session.userId, sessionId: session.id };
  }

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, platform: true, userAgent: true, issuedAt: true, lastUsedAt: true },
      orderBy: { issuedAt: 'desc' },
    });
  }

  /** Housekeeping for the scheduled job. */
  async purgeExpiredSessions(): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
          { revokedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } },
        ],
      },
    });
    return result.count;
  }

  /**
   * Signature for the bot -> API service channel, so the bot can look up a
   * user by Telegram id without a user session.
   */
  verifyServiceSignature(payload: string, signature: string): boolean {
    if (!this.config.TELEGRAM_BOT_TOKEN) return false;
    const expected = hmacHex(payload, this.config.TELEGRAM_BOT_TOKEN);
    return constantTimeEqual(expected, signature);
  }

  async findUserByTelegramId(telegramId: bigint): Promise<{ id: string; locale: Locale } | null> {
    const identity = await this.prisma.telegramIdentity.findUnique({
      where: { telegramId },
      select: { user: { select: { id: true, locale: true } } },
    });
    if (!identity) return null;
    return { id: identity.user.id, locale: identity.user.locale as Locale };
  }

  /** Idempotent upsert used by the bot when a user presses /start. */
  async upsertFromBot(input: {
    telegramId: bigint;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    languageCode?: string | null;
    chatId?: bigint | null;
  }): Promise<{ userId: string; locale: Locale; isNewUser: boolean }> {
    const locale = resolveLocale(input.languageCode);
    const existing = await this.prisma.telegramIdentity.findUnique({
      where: { telegramId: input.telegramId },
      select: { userId: true, user: { select: { locale: true } } },
    });

    if (existing) {
      await this.prisma.telegramIdentity.update({
        where: { telegramId: input.telegramId },
        data: {
          username: input.username ?? null,
          chatId: input.chatId ?? undefined,
          botBlocked: false,
          lastAuthDate: new Date(),
        },
      });
      return { userId: existing.userId, locale: existing.user.locale as Locale, isNewUser: false };
    }

    const created = await this.prisma.user.create({
      data: {
        locale: locale as PrismaLocale,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        displayUsername: input.username ?? null,
        telegramIdentity: {
          create: {
            telegramId: input.telegramId,
            username: input.username ?? null,
            languageCode: input.languageCode ?? null,
            chatId: input.chatId ?? null,
            lastAuthDate: new Date(),
          },
        },
      },
    });
    return { userId: created.id, locale, isNewUser: true };
  }

  async markBotBlocked(telegramId: bigint, blocked: boolean): Promise<void> {
    await this.prisma.telegramIdentity
      .update({ where: { telegramId }, data: { botBlocked: blocked } })
      .catch(() => undefined);
  }
}

export type { Prisma };
