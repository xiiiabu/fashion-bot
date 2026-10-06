/**
 * Role / permission model — spec §3.2, ADM-001 (RBAC down to action+object,
 * deny by default), ADM-002 (MFA for admin/finance/super admin), ADM-005
 * (dual approval), SEL-001/SEL-002 (seller tenant roles).
 *
 * Permissions are `object:action` strings. A role holds an explicit list;
 * nothing is implied, nothing is inherited by accident. `*` is allowed only in
 * the super-admin role, and even there every use is audited.
 */

export const ADMIN_ROLES = [
  'SUPER_ADMIN',
  'CATALOG_MANAGER',
  'ORDER_MANAGER',
  'FINANCE_OPERATOR',
  'CONTENT_MANAGER',
  'AI_MERCHANDISER',
  'SUPPORT_AGENT',
  'ANALYST',
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const SELLER_ROLES = ['SELLER_OWNER', 'SELLER_CATALOG', 'SELLER_ORDER', 'SELLER_FINANCE', 'SELLER_VIEWER'] as const;
export type SellerRole = (typeof SELLER_ROLES)[number];

export type Role = AdminRole | SellerRole;

export const PERMISSIONS = [
  // catalogue
  'product:read', 'product:write', 'product:publish', 'product:archive', 'product:import',
  'sku:read', 'sku:write',
  'inventory:read', 'inventory:write',
  'price:read', 'price:write',
  'media:read', 'media:write',
  'sizechart:read', 'sizechart:write',
  'category:read', 'category:write',
  'brand:read', 'brand:write',
  // organisations
  'seller:read', 'seller:write', 'seller:approve',
  'contract:read', 'contract:write',
  'commissionrule:read', 'commissionrule:write',
  // commerce
  'order:read', 'order:write', 'order:cancel', 'order:readPii',
  'shipment:read', 'shipment:write',
  'return:read', 'return:write', 'return:approve', 'return:inspect',
  // money
  'payment:read', 'payment:refund',
  'ledger:read', 'adjustment:write', 'adjustment:approve',
  'payout:read', 'payout:create', 'payout:approve',
  'reconciliation:read', 'reconciliation:resolve',
  'export:financial',
  // content
  'cms:read', 'cms:write', 'cms:publish',
  'review:read', 'review:moderate',
  // ai
  'ai:read', 'ai:writeRules', 'ai:curate', 'ai:evaluate',
  // platform
  'iam:read', 'iam:write',
  'audit:read',
  'config:read', 'config:write',
  'featureflag:write',
  'analytics:read',
  'support:read', 'support:write',
  'privacyrequest:read', 'privacyrequest:process',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** ADM-001: deny by default — a role sees exactly what is listed. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[] | ['*']> = {
  SUPER_ADMIN: ['*'],

  CATALOG_MANAGER: [
    'product:read', 'product:write', 'product:publish', 'product:archive', 'product:import',
    'sku:read', 'sku:write',
    'inventory:read', 'inventory:write',
    'price:read', 'price:write',
    'media:read', 'media:write',
    'sizechart:read', 'sizechart:write',
    'category:read', 'category:write',
    'brand:read', 'brand:write',
    'seller:read',
    'review:read', 'review:moderate',
    'analytics:read',
  ],

  ORDER_MANAGER: [
    'order:read', 'order:write', 'order:cancel', 'order:readPii',
    'shipment:read', 'shipment:write',
    'return:read', 'return:write', 'return:approve',
    'product:read', 'sku:read', 'inventory:read',
    'seller:read',
    'support:read', 'support:write',
    'analytics:read',
  ],

  /**
   * ADM-005 is dual control, not escalation: two finance operators check each
   * other, so the role holds both the write and the approve permissions. One
   * operator still cannot move money alone — the API refuses an approval from
   * the person who created the request, whatever their role.
   *
   * Without the approve permissions here, the only possible checker would be a
   * SUPER_ADMIN, which turns every refund into an escalation and in practice
   * means the separation gets bypassed.
   */
  FINANCE_OPERATOR: [
    'payment:read', 'payment:refund',
    'ledger:read', 'adjustment:write', 'adjustment:approve',
    'payout:read', 'payout:create', 'payout:approve',
    'reconciliation:read', 'reconciliation:resolve',
    'export:financial',
    'order:read',
    'return:read',
    'seller:read', 'contract:read', 'commissionrule:read',
    'analytics:read',
  ],

  CONTENT_MANAGER: [
    'cms:read', 'cms:write', 'cms:publish',
    'product:read', 'brand:read', 'category:read',
    'media:read', 'media:write',
    'review:read', 'review:moderate',
    'analytics:read',
  ],

  AI_MERCHANDISER: [
    'ai:read', 'ai:writeRules', 'ai:curate', 'ai:evaluate',
    'product:read', 'sku:read', 'inventory:read', 'category:read', 'brand:read',
    'cms:read',
    'analytics:read',
  ],

  SUPPORT_AGENT: [
    'support:read', 'support:write',
    'order:read',
    'return:read', 'return:write',
    'payment:read',
    'product:read', 'sku:read',
    'privacyrequest:read',
  ],

  ANALYST: ['analytics:read', 'order:read', 'product:read', 'ledger:read', 'ai:read'],

  // SEL-002: seller roles are scoped to one organisation by the tenant guard.
  SELLER_OWNER: [
    'product:read', 'product:write', 'sku:read', 'sku:write',
    'inventory:read', 'inventory:write', 'price:read', 'price:write',
    'media:read', 'media:write', 'sizechart:read', 'sizechart:write',
    'order:read', 'order:write', 'shipment:read', 'shipment:write',
    'return:read', 'return:write', 'return:inspect',
    'ledger:read', 'payout:read', 'export:financial',
    'contract:read', 'commissionrule:read',
    'iam:read', 'iam:write',
    'analytics:read',
  ],
  SELLER_CATALOG: [
    'product:read', 'product:write', 'sku:read', 'sku:write',
    'inventory:read', 'inventory:write', 'price:read', 'price:write',
    'media:read', 'media:write', 'sizechart:read', 'sizechart:write',
    'analytics:read',
  ],
  SELLER_ORDER: [
    'order:read', 'order:write',
    'shipment:read', 'shipment:write',
    'return:read', 'return:write', 'return:inspect',
    'product:read', 'sku:read', 'inventory:read',
    'analytics:read',
  ],
  SELLER_FINANCE: [
    'ledger:read', 'payout:read', 'export:financial',
    'order:read', 'return:read', 'contract:read', 'commissionrule:read',
    'analytics:read',
  ],
  SELLER_VIEWER: ['product:read', 'sku:read', 'inventory:read', 'order:read', 'analytics:read'],
};

/** ADM-002: these roles may not authenticate with a password alone. */
export const MFA_REQUIRED_ROLES: readonly Role[] = [
  'SUPER_ADMIN',
  'FINANCE_OPERATOR',
  'ORDER_MANAGER',
  'CATALOG_MANAGER',
  'SELLER_OWNER',
  'SELLER_FINANCE',
];

/**
 * ADM-005: actions that need a second person. The maker may never approve
 * their own action — enforced in the service, listed here so the UI can warn
 * before the operator does the work.
 */
export const DUAL_APPROVAL_ACTIONS = [
  'payout.release',
  'adjustment.create',
  'refund.large',
  'commissionrule.change',
  'config.payment_provider',
  'seller.contract_change',
] as const;

export type DualApprovalAction = (typeof DUAL_APPROVAL_ACTIONS)[number];

/** A refund at or above this share of the order needs dual approval. */
export const LARGE_REFUND_THRESHOLD_BPS = 5000;

export function permissionsForRoles(roles: Role[]): Set<Permission | '*'> {
  const out = new Set<Permission | '*'>();
  for (const role of roles) {
    const list = ROLE_PERMISSIONS[role];
    if (!list) continue;
    for (const permission of list) out.add(permission as Permission | '*');
  }
  return out;
}

export function hasPermission(granted: Set<Permission | '*'> | Array<Permission | '*'>, required: Permission): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  return set.has('*') || set.has(required);
}

export function requiresMfa(roles: Role[]): boolean {
  return roles.some((role) => MFA_REQUIRED_ROLES.includes(role));
}

export function isSellerRole(role: Role): role is SellerRole {
  return (SELLER_ROLES as readonly string[]).includes(role);
}

/**
 * ADM-007: PII visibility by role. A catalogue manager must not see a
 * customer's phone or full address; access to unmasked values is logged.
 */
export const PII_ROLES: readonly Role[] = [
  'SUPER_ADMIN',
  'ORDER_MANAGER',
  'SUPPORT_AGENT',
  'FINANCE_OPERATOR',
];

export function canSeePii(roles: Role[]): boolean {
  return roles.some((role) => PII_ROLES.includes(role));
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '•'.repeat(digits.length);
  return `${phone.slice(0, Math.min(5, phone.length))}•••••${digits.slice(-2)}`;
}

export function maskName(name: string | null | undefined): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  return parts.map((part) => `${part.charAt(0)}${'•'.repeat(Math.max(1, part.length - 1))}`).join(' ');
}

export function maskAddress(line: string | null | undefined): string {
  if (!line) return '';
  return line.replace(/\d+/g, (match) => '•'.repeat(match.length));
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '•'.repeat(email.length);
  return `${local.slice(0, 1)}•••@${domain}`;
}
