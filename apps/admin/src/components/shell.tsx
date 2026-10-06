'use client';

/**
 * The operator shell: a dark sidebar, a thin top bar, and the page.
 *
 * The navigation is built from the signed-in principal. A seller sees the
 * seller cabinet; an admin sees only the sections their roles permit, so the
 * panel does not offer a finance screen to a content manager and then refuse
 * it (ADM-003). The API denies by default regardless — this is about not
 * wasting the operator's time.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Permission } from '@fashion/core';
import { useApp } from '@/lib/app-context';
import { cx } from './ui';

interface NavItem {
  href: string;
  label: string;
  /**
   * Hidden unless the principal holds this permission. It is the permission
   * the API actually guards the screen's read with — kept in step by typing it
   * as core's Permission, so a renamed permission breaks the build here rather
   * than quietly emptying the sidebar.
   */
  permission?: Permission;
  exact?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const ADMIN_NAV: NavGroup[] = [
  {
    title: 'Обзор',
    items: [
      { href: '/', label: 'Дашборд', exact: true },
      { href: '/approvals', label: 'Согласования', permission: 'audit:read' },
      { href: '/alerts', label: 'Алерты', permission: 'analytics:read' },
    ],
  },
  {
    title: 'Продажи',
    items: [
      { href: '/orders', label: 'Заказы', permission: 'order:read' },
      { href: '/returns', label: 'Возвраты', permission: 'return:read' },
    ],
  },
  {
    title: 'Каталог',
    items: [
      { href: '/products', label: 'Товары', permission: 'product:read' },
      { href: '/sellers', label: 'Продавцы', permission: 'seller:read' },
      { href: '/cms', label: 'Витрина', permission: 'cms:read' },
    ],
  },
  {
    title: 'Финансы',
    items: [
      { href: '/finance/ledger', label: 'Реестр', permission: 'ledger:read' },
      { href: '/finance/payouts', label: 'Выплаты', permission: 'payout:read' },
      { href: '/finance/reconciliation', label: 'Сверка', permission: 'reconciliation:read' },
      { href: '/finance/commission', label: 'Комиссия', permission: 'commissionrule:read' },
    ],
  },
  {
    title: 'Платформа',
    items: [
      { href: '/support', label: 'Поддержка', permission: 'support:read' },
      { href: '/iam', label: 'Доступы', permission: 'iam:read' },
      { href: '/audit', label: 'Аудит', permission: 'audit:read' },
      { href: '/settings', label: 'Настройки', permission: 'config:read' },
    ],
  },
];

const SELLER_NAV: NavGroup[] = [
  {
    title: 'Магазин',
    items: [
      { href: '/', label: 'Обзор', exact: true },
      { href: '/seller/orders', label: 'Заказы' },
      { href: '/seller/returns', label: 'Возвраты' },
    ],
  },
  {
    title: 'Товары',
    items: [{ href: '/seller/products', label: 'Каталог' }],
  },
  {
    title: 'Деньги',
    items: [
      { href: '/seller/finance', label: 'Баланс и выплаты' },
      { href: '/seller/analytics', label: 'Аналитика' },
    ],
  },
  {
    title: 'Настройки',
    items: [{ href: '/seller/team', label: 'Сотрудники' }],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { principal, can, isSeller } = useApp();
  const groups = isSeller ? SELLER_NAV : ADMIN_NAV;

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 flex w-[216px] flex-col"
      style={{ background: 'var(--sidebar)' }}
    >
      <div className="px-4 py-4">
        <p className="t-display text-[19px] leading-none" style={{ color: 'var(--sidebar-fg)' }}>
          Atlas
        </p>
        <p
          className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: 'var(--sidebar-fg-dim)' }}
        >
          {isSeller ? 'Кабинет продавца' : 'Панель управления'}
        </p>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 no-scrollbar">
        {groups.map((group, groupIndex) => {
          const visible = group.items.filter((item) => !item.permission || can(item.permission));
          if (visible.length === 0) return null;
          return (
            <div key={`${group.title}-${groupIndex}`} className="mb-4">
              <p
                className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: 'var(--sidebar-fg-dim)' }}
              >
                {group.title}
              </p>
              <ul>
                {visible.map((item) => {
                  const active = item.exact
                    ? pathname === item.href
                    : pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cx(
                          'block rounded-[var(--radius-sm)] px-2 py-[7px] text-[13px] transition-colors',
                          active ? 'bg-[var(--accent)] font-medium' : 'hover:bg-white/6',
                        )}
                        style={{
                          color: active ? 'var(--on-accent)' : 'var(--sidebar-fg)',
                        }}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div
        className="border-t px-4 py-3 text-[11.5px]"
        style={{ borderColor: 'var(--sidebar-line)', color: 'var(--sidebar-fg-dim)' }}
      >
        <p className="truncate" style={{ color: 'var(--sidebar-fg)' }}>
          {principal?.name || principal?.email}
        </p>
        <p className="truncate">
          {isSeller ? principal?.sellerName : principal?.roles.join(', ')}
        </p>
      </div>
    </aside>
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  const { principal, signOut, theme, toggleTheme } = useApp();
  return (
    <header className="sticky top-0 z-20 flex h-[52px] items-center gap-3 border-b border-[var(--line)] bg-[var(--bg)]/92 px-6 backdrop-blur-xl">
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        onClick={toggleTheme}
        aria-label="Переключить тему"
        className="rounded-[var(--radius-sm)] p-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg)]"
      >
        {theme === 'dark' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
          </svg>
        )}
      </button>
      <span className="hidden text-[12.5px] text-[var(--fg-muted)] sm:block">{principal?.email}</span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="rounded-[var(--radius-sm)] px-2 py-1 text-[12.5px] text-[var(--fg-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg)]"
      >
        Выйти
      </button>
    </header>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-[1400px] px-6 py-6">{children}</div>;
}
