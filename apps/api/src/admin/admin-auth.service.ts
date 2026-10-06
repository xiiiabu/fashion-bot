/**
 * Admin and seller-cabinet authentication — spec ADM-002, SEC-008, SEL-001/002.
 *
 * ADM-002 MFA for admin / finance / super admin, plus session management.
 *         "Critical roles не входят только по password."
 * SEC-008 Least privilege, session timeout, lockout and an access audit.
 * SEL-001 A seller principal always carries its organisation id, which every
 *         seller-scoped query is pinned to.
 */

import { Injectable } from '@nestjs/common';
import type { AdminRole, SellerRole } from '@prisma/client';
import { type Role, requiresMfa } from '@fashion/core';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import {
  generateTotpSecret,
  hashPassword,
  randomToken,
  sha256,
  signJwt,
  totpUri,
  verifyJwt,
  verifyPassword,
  verifyTotp,
} from '../common/crypto';
import { AuditService } from '../common/audit.service';
import type { AuthenticatedActor } from '../common/http';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface AdminPrincipal {
  readonly kind: 'admin' | 'seller';
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: string[];
  readonly sellerId?: string;
  readonly sessionId: string;
  readonly mfaVerified: boolean;
}

export interface LoginResult {
  readonly status: 'OK' | 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  readonly accessToken?: string;
  readonly expiresIn?: number;
  /** Short-lived token that only allows completing the MFA step. */
  readonly mfaToken?: string;
  readonly enrollment?: { secret: string; uri: string };
  readonly principal?: {
    id: string;
    email: string;
    name: string;
    roles: string[];
    kind: 'admin' | 'seller';
    sellerId?: string;
    sellerName?: string;
  };
}

@Injectable()
export class AdminAuthService {
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async login(
    input: { email: string; password: string },
    context: { ipHash?: string | null; userAgent?: string | null; correlationId?: string },
  ): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();

    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    if (admin) return this.loginAdmin(admin, input.password, context);

    const sellerUser = await this.prisma.sellerUser.findUnique({
      where: { email },
      include: { seller: { select: { id: true, displayName: true, suspendedAt: true, onboardingStatus: true } } },
    });
    if (sellerUser) return this.loginSeller(sellerUser, input.password, context);

    // Same message and timing shape for an unknown account as for a wrong
    // password, so the endpoint does not enumerate users.
    await hashPassword(input.password).catch(() => undefined);
    throw AppError.unauthenticated('Invalid email or password');
  }

  private async loginAdmin(
    admin: {
      id: string;
      email: string;
      name: string;
      passwordHash: string;
      roles: AdminRole[];
      mfaSecret: string | null;
      mfaEnabledAt: Date | null;
      failedLoginCount: number;
      lockedUntil: Date | null;
      disabledAt: Date | null;
    },
    password: string,
    context: { ipHash?: string | null; userAgent?: string | null; correlationId?: string },
  ): Promise<LoginResult> {
    if (admin.disabledAt) throw AppError.forbidden('This account is disabled');
    this.assertNotLocked(admin.lockedUntil);

    const ok = await verifyPassword(password, admin.passwordHash);
    if (!ok) {
      await this.registerFailure('admin', admin.id, admin.failedLoginCount);
      await this.audit.record(null, {
        action: 'admin.login_failed',
        objectType: 'AdminUser',
        objectId: admin.id,
        severity: 'WARNING',
        ipHash: context.ipHash,
        correlationId: context.correlationId,
      });
      throw AppError.unauthenticated('Invalid email or password');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const roles = admin.roles as unknown as Role[];

    // ADM-002: a critical role cannot get a usable session from a password.
    if (requiresMfa(roles)) {
      if (!admin.mfaSecret || !admin.mfaEnabledAt) {
        const secret = generateTotpSecret();
        await this.prisma.adminUser.update({ where: { id: admin.id }, data: { mfaSecret: secret } });
        return {
          status: 'MFA_ENROLLMENT_REQUIRED',
          mfaToken: this.mfaToken('admin', admin.id),
          enrollment: { secret, uri: totpUri(secret, admin.email) },
        };
      }
      return { status: 'MFA_REQUIRED', mfaToken: this.mfaToken('admin', admin.id) };
    }

    const session = await this.createSession('admin', admin.id, false, context);
    return {
      status: 'OK',
      accessToken: session.token,
      expiresIn: this.config.ADMIN_SESSION_TTL,
      principal: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        roles: admin.roles,
        kind: 'admin',
      },
    };
  }

  private async loginSeller(
    sellerUser: {
      id: string;
      email: string;
      name: string;
      passwordHash: string;
      role: SellerRole;
      mfaSecret: string | null;
      mfaEnabledAt: Date | null;
      failedLoginCount: number;
      lockedUntil: Date | null;
      disabledAt: Date | null;
      sellerId: string;
      seller: { id: string; displayName: string; suspendedAt: Date | null; onboardingStatus: string };
    },
    password: string,
    context: { ipHash?: string | null; userAgent?: string | null; correlationId?: string },
  ): Promise<LoginResult> {
    if (sellerUser.disabledAt) throw AppError.forbidden('This account is disabled');
    if (sellerUser.seller.suspendedAt) throw AppError.forbidden('This seller account is suspended');
    this.assertNotLocked(sellerUser.lockedUntil);

    const ok = await verifyPassword(password, sellerUser.passwordHash);
    if (!ok) {
      await this.registerFailure('seller', sellerUser.id, sellerUser.failedLoginCount);
      throw AppError.unauthenticated('Invalid email or password');
    }

    await this.prisma.sellerUser.update({
      where: { id: sellerUser.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const roles = [sellerUser.role] as unknown as Role[];
    if (requiresMfa(roles)) {
      if (!sellerUser.mfaSecret || !sellerUser.mfaEnabledAt) {
        const secret = generateTotpSecret();
        await this.prisma.sellerUser.update({
          where: { id: sellerUser.id },
          data: { mfaSecret: secret },
        });
        return {
          status: 'MFA_ENROLLMENT_REQUIRED',
          mfaToken: this.mfaToken('seller', sellerUser.id),
          enrollment: { secret, uri: totpUri(secret, sellerUser.email, 'Fashion Seller Cabinet') },
        };
      }
      return { status: 'MFA_REQUIRED', mfaToken: this.mfaToken('seller', sellerUser.id) };
    }

    const session = await this.createSession('seller', sellerUser.id, false, context);
    return {
      status: 'OK',
      accessToken: session.token,
      expiresIn: this.config.ADMIN_SESSION_TTL,
      principal: {
        id: sellerUser.id,
        email: sellerUser.email,
        name: sellerUser.name,
        roles: [sellerUser.role],
        kind: 'seller',
        sellerId: sellerUser.sellerId,
        sellerName: sellerUser.seller.displayName,
      },
    };
  }

  /** Step two: the TOTP code. Also finalises enrolment on first success. */
  async verifyMfa(
    mfaToken: string,
    code: string,
    context: { ipHash?: string | null; userAgent?: string | null; correlationId?: string },
  ): Promise<LoginResult> {
    const payload = verifyJwt<{ sub: string; kind: string; principal: 'admin' | 'seller'; exp: number; iat: number }>(
      mfaToken,
      this.config.ADMIN_JWT_SECRET,
    );
    if (!payload || payload.kind !== 'mfa') throw AppError.unauthenticated('MFA session expired');

    if (payload.principal === 'admin') {
      const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
      if (!admin?.mfaSecret) throw AppError.unauthenticated('MFA is not set up');
      if (!verifyTotp(admin.mfaSecret, code)) {
        await this.registerFailure('admin', admin.id, admin.failedLoginCount);
        throw AppError.unauthenticated('Invalid authentication code');
      }
      if (!admin.mfaEnabledAt) {
        await this.prisma.adminUser.update({
          where: { id: admin.id },
          data: { mfaEnabledAt: new Date() },
        });
      }
      const session = await this.createSession('admin', admin.id, true, context);
      await this.audit.record(
        { kind: 'admin', adminUserId: admin.id, email: admin.email, roles: admin.roles, permissions: new Set() },
        {
          action: 'admin.login',
          objectType: 'AdminUser',
          objectId: admin.id,
          after: { mfa: true },
          severity: 'NOTICE',
          ipHash: context.ipHash,
          correlationId: context.correlationId,
        },
      );
      return {
        status: 'OK',
        accessToken: session.token,
        expiresIn: this.config.ADMIN_SESSION_TTL,
        principal: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          roles: admin.roles,
          kind: 'admin',
        },
      };
    }

    const sellerUser = await this.prisma.sellerUser.findUnique({
      where: { id: payload.sub },
      include: { seller: { select: { id: true, displayName: true } } },
    });
    if (!sellerUser?.mfaSecret) throw AppError.unauthenticated('MFA is not set up');
    if (!verifyTotp(sellerUser.mfaSecret, code)) {
      await this.registerFailure('seller', sellerUser.id, sellerUser.failedLoginCount);
      throw AppError.unauthenticated('Invalid authentication code');
    }
    if (!sellerUser.mfaEnabledAt) {
      await this.prisma.sellerUser.update({
        where: { id: sellerUser.id },
        data: { mfaEnabledAt: new Date() },
      });
    }
    const session = await this.createSession('seller', sellerUser.id, true, context);
    return {
      status: 'OK',
      accessToken: session.token,
      expiresIn: this.config.ADMIN_SESSION_TTL,
      principal: {
        id: sellerUser.id,
        email: sellerUser.email,
        name: sellerUser.name,
        roles: [sellerUser.role],
        kind: 'seller',
        sellerId: sellerUser.sellerId,
        sellerName: sellerUser.seller.displayName,
      },
    };
  }

  /** Called by the guard on every admin/seller request. */
  async resolveToken(token: string): Promise<AdminPrincipal | null> {
    const payload = verifyJwt<{
      sub: string;
      sid: string;
      kind: string;
      principal: 'admin' | 'seller';
      exp: number;
      iat: number;
    }>(token, this.config.ADMIN_JWT_SECRET);
    if (!payload || payload.kind !== 'admin-session') return null;

    const session = await this.prisma.adminSession.findUnique({
      where: { id: payload.sid },
      include: { adminUser: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

    // SEC-008: a sliding session, but never beyond the configured ceiling.
    if (Date.now() - session.lastUsedAt.getTime() > 60_000) {
      await this.prisma.adminSession
        .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }

    if (payload.principal === 'admin') {
      if (session.adminUser.disabledAt) return null;
      return {
        kind: 'admin',
        id: session.adminUser.id,
        email: session.adminUser.email,
        name: session.adminUser.name,
        roles: session.adminUser.roles,
        sessionId: session.id,
        mfaVerified: session.mfaVerified,
      };
    }

    // A seller session reuses AdminSession but points at a SellerUser; the
    // bridging row carries the seller user id in `userAgent`-independent form.
    const sellerUser = await this.prisma.sellerUser.findUnique({
      where: { id: payload.sub },
      include: { seller: { select: { id: true, suspendedAt: true } } },
    });
    if (!sellerUser || sellerUser.disabledAt || sellerUser.seller.suspendedAt) return null;

    return {
      kind: 'seller',
      id: sellerUser.id,
      email: sellerUser.email,
      name: sellerUser.name,
      roles: [sellerUser.role],
      sellerId: sellerUser.sellerId,
      sessionId: session.id,
      mfaVerified: session.mfaVerified,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.adminSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listSessions(principalId: string) {
    return this.prisma.adminSession.findMany({
      where: { adminUserId: principalId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, ipHash: true, userAgent: true, createdAt: true, lastUsedAt: true, mfaVerified: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** SEC-008: an operator may kill every other session from their own. */
  async revokeOtherSessions(principalId: string, keepSessionId: string): Promise<number> {
    const result = await this.prisma.adminSession.updateMany({
      where: { adminUserId: principalId, id: { not: keepSessionId }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  // ─────────────────────────────────────────────────── IAM (ADM-001/ADM-002)

  async createAdminUser(
    input: { email: string; name: string; password: string; roles: AdminRole[] },
    actor: AuthenticatedActor,
  ) {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.adminUser.findUnique({ where: { email } });
    if (existing) throw AppError.conflict('CONFLICT', 'An admin with this email already exists');
    assertPasswordStrength(input.password);

    const created = await this.prisma.adminUser.create({
      data: {
        email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        roles: input.roles,
      },
      select: { id: true, email: true, name: true, roles: true, createdAt: true },
    });

    await this.audit.record(actor, {
      action: 'iam.admin_create',
      objectType: 'AdminUser',
      objectId: created.id,
      after: { email: created.email, roles: created.roles },
      severity: 'CRITICAL',
    });
    return created;
  }

  async updateAdminRoles(adminUserId: string, roles: AdminRole[], actor: AuthenticatedActor) {
    const before = await this.prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { roles: true, email: true },
    });
    if (!before) throw AppError.notFound('AdminUser', adminUserId);

    // Never let the last super admin remove their own privilege.
    if (before.roles.includes('SUPER_ADMIN') && !roles.includes('SUPER_ADMIN')) {
      const remaining = await this.prisma.adminUser.count({
        where: { roles: { has: 'SUPER_ADMIN' }, disabledAt: null, id: { not: adminUserId } },
      });
      if (remaining === 0) {
        throw AppError.validation('At least one active super admin must remain');
      }
    }

    const updated = await this.prisma.adminUser.update({
      where: { id: adminUserId },
      data: { roles },
      select: { id: true, email: true, roles: true },
    });
    await this.audit.record(actor, {
      action: 'iam.admin_roles',
      objectType: 'AdminUser',
      objectId: adminUserId,
      before: { roles: before.roles },
      after: { roles },
      severity: 'CRITICAL',
    });
    return updated;
  }

  async setAdminDisabled(adminUserId: string, disabled: boolean, actor: AuthenticatedActor) {
    await this.prisma.adminUser.update({
      where: { id: adminUserId },
      data: { disabledAt: disabled ? new Date() : null },
    });
    if (disabled) {
      await this.prisma.adminSession.updateMany({
        where: { adminUserId, revokedAt: null },
        data: { revokedAt: new Date(), },
      });
    }
    await this.audit.record(actor, {
      action: disabled ? 'iam.admin_disable' : 'iam.admin_enable',
      objectType: 'AdminUser',
      objectId: adminUserId,
      severity: 'CRITICAL',
    });
    return { disabled };
  }

  async listAdminUsers() {
    return this.prisma.adminUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        name: true,
        roles: true,
        mfaEnabledAt: true,
        lastLoginAt: true,
        disabledAt: true,
        createdAt: true,
      },
    });
  }

  /** SEL-002: the seller owner manages their own team. */
  async createSellerUser(
    sellerId: string,
    input: { email: string; name: string; password: string; role: SellerRole },
    actor: AuthenticatedActor,
  ) {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.sellerUser.findUnique({ where: { email } });
    if (existing) throw AppError.conflict('CONFLICT', 'A user with this email already exists');
    assertPasswordStrength(input.password);

    const created = await this.prisma.sellerUser.create({
      data: {
        sellerId,
        email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        role: input.role,
      },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    await this.audit.record(actor, {
      action: 'iam.seller_user_create',
      objectType: 'SellerUser',
      objectId: created.id,
      after: { email: created.email, role: created.role, sellerId },
      severity: 'WARNING',
    });
    return created;
  }

  async listSellerUsers(sellerId: string) {
    return this.prisma.sellerUser.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        mfaEnabledAt: true,
        lastLoginAt: true,
        disabledAt: true,
      },
    });
  }

  async changePassword(
    principal: { kind: 'admin' | 'seller'; id: string },
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    assertPasswordStrength(input.newPassword);

    if (principal.kind === 'admin') {
      const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: principal.id } });
      if (!(await verifyPassword(input.currentPassword, admin.passwordHash))) {
        throw AppError.unauthenticated('Current password is incorrect');
      }
      await this.prisma.adminUser.update({
        where: { id: principal.id },
        data: { passwordHash: await hashPassword(input.newPassword) },
      });
    } else {
      const sellerUser = await this.prisma.sellerUser.findUniqueOrThrow({ where: { id: principal.id } });
      if (!(await verifyPassword(input.currentPassword, sellerUser.passwordHash))) {
        throw AppError.unauthenticated('Current password is incorrect');
      }
      await this.prisma.sellerUser.update({
        where: { id: principal.id },
        data: { passwordHash: await hashPassword(input.newPassword) },
      });
    }
  }

  // ───────────────────────────────────────────────────────────── internals

  private mfaToken(principal: 'admin' | 'seller', id: string): string {
    // Two minutes: long enough to read a code off a phone, short enough that a
    // leaked intermediate token is worthless.
    return signJwt({ sub: id, kind: 'mfa', principal }, this.config.ADMIN_JWT_SECRET, 120);
  }

  private async createSession(
    principal: 'admin' | 'seller',
    principalId: string,
    mfaVerified: boolean,
    context: { ipHash?: string | null; userAgent?: string | null },
  ): Promise<{ token: string; sessionId: string }> {
    // Seller sessions need an AdminUser row to hang off, so each seller user
    // is mirrored by a shadow AdminUser with no roles. That keeps one session
    // table (and therefore one revocation path) for both surfaces.
    const adminUserId =
      principal === 'admin' ? principalId : await this.shadowAdminUserId(principalId);

    const raw = randomToken(32);
    const session = await this.prisma.adminSession.create({
      data: {
        adminUserId,
        tokenHash: sha256(raw),
        ipHash: context.ipHash ?? null,
        userAgent: context.userAgent?.slice(0, 300) ?? null,
        mfaVerified,
        expiresAt: new Date(Date.now() + this.config.ADMIN_SESSION_TTL * 1000),
      },
    });

    const token = signJwt(
      { sub: principalId, sid: session.id, kind: 'admin-session', principal },
      this.config.ADMIN_JWT_SECRET,
      this.config.ADMIN_SESSION_TTL,
    );
    return { token, sessionId: session.id };
  }

  private async shadowAdminUserId(sellerUserId: string): Promise<string> {
    const sellerUser = await this.prisma.sellerUser.findUniqueOrThrow({
      where: { id: sellerUserId },
      select: { email: true, name: true },
    });
    const shadowEmail = `seller+${sellerUserId}@sessions.local`;
    const existing = await this.prisma.adminUser.findUnique({
      where: { email: shadowEmail },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.adminUser.create({
      data: {
        email: shadowEmail,
        name: `${sellerUser.name} (seller session)`,
        // Unusable password: this row exists only to anchor sessions.
        passwordHash: await hashPassword(randomToken(32)),
        roles: [],
      },
      select: { id: true },
    });
    return created.id;
  }

  private assertNotLocked(lockedUntil: Date | null): void {
    if (lockedUntil && lockedUntil > new Date()) {
      throw new AppError('RATE_LIMITED', {
        message: 'Too many failed attempts — try again shortly',
        details: { retryAfterSeconds: Math.ceil((lockedUntil.getTime() - Date.now()) / 1000) },
      });
    }
  }

  /** SEC-006: lock the account rather than letting a password be guessed. */
  private async registerFailure(
    principal: 'admin' | 'seller',
    id: string,
    currentCount: number,
  ): Promise<void> {
    const next = currentCount + 1;
    const lockedUntil = next >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;
    if (principal === 'admin') {
      await this.prisma.adminUser.update({
        where: { id },
        data: { failedLoginCount: next, lockedUntil },
      });
    } else {
      await this.prisma.sellerUser.update({
        where: { id },
        data: { failedLoginCount: next, lockedUntil },
      });
    }
    if (lockedUntil) {
      logger.warn({ principal, id }, 'account locked after repeated failed logins');
      await this.prisma.alert.create({
        data: {
          code: 'ACCOUNT_LOCKED',
          severity: 'WARNING',
          title: 'Account locked after repeated failed logins',
          objectType: principal === 'admin' ? 'AdminUser' : 'SellerUser',
          objectId: id,
        },
      });
    }
  }
}

function assertPasswordStrength(password: string): void {
  // Deliberately simple and explicit rather than a regex nobody can read.
  const problems: string[] = [];
  if (password.length < 12) problems.push('at least 12 characters');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/\d/.test(password)) problems.push('a digit');
  if (problems.length > 0) {
    throw AppError.validation(`Password must contain ${problems.join(', ')}`);
  }
}
