/**
 * Authentication and authorisation guards.
 *
 * ADM-001: deny by default. A controller without an explicit @Public() or a
 * satisfied guard does not serve a request.
 * SEL-001: the tenant guard pins every seller query to the caller's own
 * organisation, so cross-tenant IDOR is impossible by construction.
 */

import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  type Permission,
  type Role,
  hasPermission,
  permissionsForRoles,
  requiresMfa,
} from '@fashion/core';
import { AppError } from '../common/errors';
import type { AppRequest, AuthenticatedActor } from '../common/http';
import { requestContext } from '../common/logger';
import { AuthService } from './auth.service';
import { AdminAuthService } from '../admin/admin-auth.service';

export const PUBLIC_KEY = 'isPublic';
export const OPTIONAL_AUTH_KEY = 'optionalAuth';
export const PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_PERMISSION_KEY = 'requiredAnyPermission';
export const REQUIRE_MFA_KEY = 'requireMfa';
export const ADMIN_SURFACE_KEY = 'adminSurface';

/** Marks an endpoint as reachable without a session (catalogue reads, webhooks). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Marks a controller as part of the admin/seller surface.
 *
 * The buyer guard is global and denies by default (ADM-001), which is right
 * for the Mini App but would reject an admin bearer token before
 * AdminAuthGuard ever sees it. This metadata tells the buyer guard to stand
 * aside; authorisation is then entirely AdminAuthGuard's job, and it denies by
 * default too.
 */
export const AdminSurface = () => SetMetadata(ADMIN_SURFACE_KEY, true);

/** Session is attached when present, but absence is not an error. */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);

export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Holding *any one* of these is enough.
 *
 * `RequirePermissions` is an AND, which is right almost everywhere: an endpoint
 * that writes a product needs product:write, full stop. It is wrong for a
 * screen several different roles legitimately read for different reasons — the
 * maker/checker queue is read by the finance operators who work it and by the
 * auditors who review it, and no single permission describes both.
 */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(ANY_PERMISSION_KEY, permissions);

export const RequireMfa = () => SetMetadata(REQUIRE_MFA_KEY, true);

const ANONYMOUS: AuthenticatedActor = {
  kind: 'anonymous',
  roles: [],
  permissions: new Set<string>(),
};

/**
 * Buyer-session guard for the Mini App surface.
 * Accepts `Authorization: Bearer <access token>`.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // The admin and seller surfaces carry their own guard; a buyer session is
    // not what authenticates them.
    const isAdminSurface = this.reflector.getAllAndOverride<boolean>(ADMIN_SURFACE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isAdminSurface) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const optional = this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<AppRequest>();
    const token = bearerToken(request);

    if (!token) {
      request.actor = ANONYMOUS;
      if (isPublic || optional) return true;
      throw AppError.unauthenticated();
    }

    const resolved = await this.auth.resolveAccessToken(token);
    if (!resolved) {
      request.actor = ANONYMOUS;
      if (isPublic || optional) return true;
      throw AppError.unauthenticated('Session is no longer valid');
    }

    request.actor = {
      kind: 'user',
      userId: resolved.userId,
      sessionId: resolved.sessionId,
      roles: [],
      permissions: new Set<string>(),
    };
    const store = requestContext.getStore();
    if (store) store.userId = resolved.userId;
    return true;
  }
}

/**
 * Admin and seller-cabinet guard. One guard for both because the permission
 * model is one model (ROLE_PERMISSIONS) — the difference is the tenant scope.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const token = bearerToken(request);
    if (!token) throw AppError.unauthenticated();

    const principal = await this.adminAuth.resolveToken(token);
    if (!principal) throw AppError.unauthenticated('Session is no longer valid');

    const roles = principal.roles as Role[];
    const permissions = permissionsForRoles(roles);

    const actor: AuthenticatedActor = {
      kind: principal.kind,
      adminUserId: principal.kind === 'admin' ? principal.id : undefined,
      sellerUserId: principal.kind === 'seller' ? principal.id : undefined,
      sellerId: principal.sellerId,
      sessionId: principal.sessionId,
      email: principal.email,
      roles,
      permissions: permissions as Set<string>,
      mfaVerified: principal.mfaVerified,
    };
    request.actor = actor;

    const store = requestContext.getStore();
    if (store) {
      store.adminUserId = actor.adminUserId;
      store.sellerId = actor.sellerId;
    }

    // ADM-002: roles handling money or catalogue must have completed MFA for
    // this session, not merely have a secret enrolled.
    const mfaRequiredByRoute = this.reflector.getAllAndOverride<boolean>(REQUIRE_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if ((mfaRequiredByRoute || requiresMfa(roles)) && !principal.mfaVerified) {
      throw AppError.forbidden('Two-factor authentication is required for this role', {
        reason: 'MFA_REQUIRED',
      });
    }

    const required =
      this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    for (const permission of required) {
      if (!hasPermission(actor.permissions as Set<Permission | '*'>, permission)) {
        throw AppError.forbidden('Missing permission', { required: permission, roles });
      }
    }

    const anyOf =
      this.reflector.getAllAndOverride<Permission[]>(ANY_PERMISSION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (
      anyOf.length > 0 &&
      !anyOf.some((permission) =>
        hasPermission(actor.permissions as Set<Permission | '*'>, permission),
      )
    ) {
      throw AppError.forbidden('Missing permission', { requiredAnyOf: anyOf, roles });
    }

    return true;
  }
}

/**
 * SEL-001: for any seller-scoped route, resolve and pin the tenant.
 * An admin may pass ?sellerId= to act on a seller; a seller user may not.
 */
export function resolveTenant(actor: AuthenticatedActor | undefined, requestedSellerId?: string): string {
  if (!actor) throw AppError.unauthenticated();
  if (actor.kind === 'seller') {
    if (!actor.sellerId) throw AppError.forbidden('Seller account is not linked to an organisation');
    if (requestedSellerId && requestedSellerId !== actor.sellerId) {
      // The IDOR test in UAT-17 lands exactly here.
      throw AppError.forbidden('Cross-tenant access is not permitted', { scope: actor.sellerId });
    }
    return actor.sellerId;
  }
  if (actor.kind === 'admin') {
    if (!requestedSellerId) throw AppError.validation('sellerId is required for admin access');
    return requestedSellerId;
  }
  throw AppError.forbidden('Not a seller or admin principal');
}

function bearerToken(request: AppRequest): string | null {
  const header = request.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // The Mini App may also send the token as a query param on media redirects.
  const query = request.query?.access_token;
  if (typeof query === 'string' && query.length > 20) return query;
  return null;
}
