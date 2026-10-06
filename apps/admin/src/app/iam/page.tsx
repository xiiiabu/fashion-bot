'use client';

/**
 * Access control — spec §10.7, ADM-002 (MFA) and ADM-003 (RBAC).
 *
 * Two things this screen is deliberate about:
 *
 *  - Roles are shown with what they actually grant, expanded from the same
 *    table the API denies by default against. "Give them FINANCE_OPERATOR"
 *    should not be a guess about what that means.
 *  - An account without MFA is marked, not merely listed. ADM-002 requires it
 *    for every operator, and the gap is the thing worth seeing from across the
 *    room.
 *
 * Accounts are disabled, never deleted: the audit trail references them, and a
 * dangling actor id in an investigation is worse than a row marked inactive.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ADMIN_ROLES, ROLE_PERMISSIONS, SELLER_ROLES } from '@fashion/core';
import { errorMessage, useApp } from '@/lib/app-context';
import { iam, sellers, type AdminUserRow, type SellerRow } from '@/lib/endpoints';
import { date, dateTime, number } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  CopyId,
  ErrorState,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Pill,
  Select,
  Table,
  Tabs,
} from '@/components/ui';

/** What each role is for, in one line. The permission list is the detail. */
const ROLE_PURPOSE: Record<string, string> = {
  SUPER_ADMIN: 'Полный доступ. Выдаётся минимуму людей и проверяется в аудите.',
  CATALOG_MANAGER: 'Товары, бренды, размерные сетки, остатки.',
  ORDER_MANAGER: 'Заказы, подзаказы, отправления, возвраты.',
  FINANCE_OPERATOR: 'Реестр, выплаты, сверка, корректировки.',
  CONTENT_MANAGER: 'Витрина, страницы, подборки.',
  AI_MERCHANDISER: 'Правила стилиста, подборки, оценка качества выдачи.',
  SUPPORT_AGENT: 'Обращения покупателей и просмотр заказов.',
  SELLER_OWNER: 'Полный доступ к кабинету продавца, включая сотрудников.',
  SELLER_CATALOG: 'Товары и остатки продавца.',
  SELLER_ORDER: 'Подтверждение и сборка заказов.',
  SELLER_FINANCE: 'Баланс, выплаты, выгрузки.',
  SELLER_VIEWER: 'Только просмотр.',
};

type Pane = 'admins' | 'roles' | 'sellerUsers';

export default function IamPage() {
  const { can } = useApp();
  const [pane, setPane] = useState<Pane>('admins');

  return (
    <>
      <PageHeader title="Доступы" subtitle="Сотрудники платформы, роли и доступ продавцов" />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'admins', label: 'Сотрудники платформы' },
          { value: 'roles', label: 'Роли и права' },
          { value: 'sellerUsers', label: 'Доступ продавцам' },
        ]}
      />

      {pane === 'admins' && <Admins canWrite={can('iam:write')} />}
      {pane === 'roles' && <Roles />}
      {pane === 'sellerUsers' && <SellerUsers canWrite={can('iam:write')} />}
    </>
  );
}

/* ── Platform staff ──────────────────────────────────────────────────────── */

function Admins({ canWrite }: { canWrite: boolean }) {
  const { toast, principal } = useApp();
  const [data, setData] = useState<{ items: AdminUserRow[]; roles: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [toggling, setToggling] = useState<AdminUserRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await iam.admins());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (action: () => Promise<unknown>, successMessage: string) => {
      setBusy(true);
      try {
        await action();
        toast(successMessage, 'success');
        setCreating(false);
        setEditing(null);
        setToggling(null);
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, load],
  );

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />;

  const withoutMfa = data.items.filter((row) => !row.mfaEnabledAt && !row.disabledAt);

  return (
    <>
      {withoutMfa.length > 0 && (
        <div className="mb-4">
          <Note tone="warn" title="Есть учётные записи без второго фактора">
            {withoutMfa.length} активных сотрудников ещё не включили MFA. ADM-002 требует её для
            каждого оператора: вход будет требовать настройку при следующем входе, но до тех пор
            доступ держится на одном пароле.
          </Note>
        </div>
      )}

      <Card
        title={`Сотрудники · ${number(data.items.length)}`}
        padded={false}
        action={
          canWrite ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Добавить сотрудника
            </Button>
          ) : undefined
        }
      >
        <Table>
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th>Роли</th>
              <th>MFA</th>
              <th>Последний вход</th>
              <th>Создан</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => {
              const isSelf = row.id === principal?.id;
              return (
                <tr key={row.id} className={row.disabledAt ? 'opacity-55' : undefined}>
                  <td>
                    <span className="block font-medium">
                      {row.name}
                      {isSelf && (
                        <Pill className="ml-1.5" tone="neutral">
                          вы
                        </Pill>
                      )}
                    </span>
                    <span className="t-mono block text-[11.5px] text-[var(--fg-faint)]">{row.email}</span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {row.roles.map((role) => (
                        <Pill key={role} tone={role === 'SUPER_ADMIN' ? 'dark' : 'accent'} title={ROLE_PURPOSE[role]}>
                          {role}
                        </Pill>
                      ))}
                    </div>
                  </td>
                  <td>
                    {row.mfaEnabledAt ? (
                      <Pill tone="success" title={dateTime(row.mfaEnabledAt)}>
                        включена
                      </Pill>
                    ) : (
                      <Pill tone="warn">не настроена</Pill>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-[var(--fg-muted)]">
                    {row.lastLoginAt ? dateTime(row.lastLoginAt) : 'не входил'}
                  </td>
                  <td className="whitespace-nowrap text-[var(--fg-muted)]">{date(row.createdAt)}</td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {canWrite && (
                        <Button size="xs" variant="ghost" onClick={() => setEditing(row)}>
                          Роли
                        </Button>
                      )}
                      {canWrite && !isSelf && (
                        <Button
                          size="xs"
                          variant={row.disabledAt ? 'outline' : 'ghost'}
                          onClick={() => setToggling(row)}
                        >
                          {row.disabledAt ? 'Включить' : 'Отключить'}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
        Учётные записи отключаются, а не удаляются: на них ссылается журнал аудита, и запись о
        действии без субъекта бесполезна для разбора.
      </p>

      {creating && (
        <CreateAdmin
          roles={data.roles}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={(body) => void act(() => iam.createAdmin(body), 'Сотрудник добавлен')}
        />
      )}

      {editing && (
        <EditRoles
          user={editing}
          roles={data.roles}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(next) => void act(() => iam.setRoles(editing.id, next), 'Роли обновлены')}
        />
      )}

      {toggling && (
        <ConfirmModal
          open
          onClose={() => setToggling(null)}
          onConfirm={() =>
            void act(
              () => iam.setDisabled(toggling.id, !toggling.disabledAt),
              toggling.disabledAt ? 'Доступ восстановлен' : 'Доступ отключён',
            )
          }
          busy={busy}
          danger={!toggling.disabledAt}
          title={toggling.disabledAt ? 'Восстановить доступ' : 'Отключить доступ'}
          confirmLabel={toggling.disabledAt ? 'Восстановить' : 'Отключить'}
          body={
            toggling.disabledAt ? (
              <p>
                {toggling.name} снова сможет войти со своим паролем и вторым фактором.
              </p>
            ) : (
              <p>
                {toggling.name} потеряет доступ немедленно, активные сессии прекратятся. История
                действий в аудите сохранится.
              </p>
            )
          }
        />
      )}
    </>
  );
}

function CreateAdmin({
  roles,
  busy,
  onClose,
  onSubmit,
}: {
  roles: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { email: string; name: string; password: string; roles: string[] }) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const valid =
    /.+@.+\..+/.test(email) && name.trim().length >= 2 && password.length >= 12 && selected.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Новый сотрудник"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() => onSubmit({ email: email.trim(), name: name.trim(), password, roles: selected })}
          >
            Создать
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <Field label="Имя" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field label="Email" required hint="Он же логин">
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field
          label="Временный пароль"
          required
          hint="Минимум 12 символов. Сотрудник настроит второй фактор при первом входе."
        >
          <Input
            type="text"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
          />
        </Field>
        <RolePicker roles={roles} selected={selected} onChange={setSelected} />
      </div>
    </Modal>
  );
}

function EditRoles({
  user,
  roles,
  busy,
  onClose,
  onSubmit,
}: {
  user: AdminUserRow;
  roles: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (roles: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(user.roles);
  const changed = JSON.stringify([...selected].sort()) !== JSON.stringify([...user.roles].sort());

  return (
    <Modal
      open
      onClose={onClose}
      title={`Роли · ${user.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} disabled={!changed || selected.length === 0} onClick={() => onSubmit(selected)}>
            Сохранить
          </Button>
        </>
      }
    >
      <RolePicker roles={roles} selected={selected} onChange={setSelected} />
      {selected.includes('SUPER_ADMIN') && !user.roles.includes('SUPER_ADMIN') && (
        <div className="mt-3">
          <Note tone="warn">
            SUPER_ADMIN даёт полный доступ, включая выплаты и согласования. Эта выдача попадёт в
            аудит с уровнем CRITICAL.
          </Note>
        </div>
      )}
    </Modal>
  );
}

function RolePicker({
  roles,
  selected,
  onChange,
}: {
  roles: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (role: string) => {
    onChange(selected.includes(role) ? selected.filter((item) => item !== role) : [...selected, role]);
  };

  return (
    <div>
      <span className="t-label mb-1.5 block">Роли</span>
      <ul className="space-y-1.5">
        {roles.map((role) => {
          const checked = selected.includes(role);
          const grants = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS];
          const count = grants?.[0] === '*' ? 'все права' : `${grants?.length ?? 0} прав`;
          return (
            <li key={role}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--bg-sunken)]">
                <input
                  type="checkbox"
                  className="mt-[3px]"
                  checked={checked}
                  onChange={() => toggle(role)}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">
                    {role}
                    <span className="ml-1.5 text-[11px] font-normal text-[var(--fg-faint)]">{count}</span>
                  </span>
                  <span className="block text-[11.5px] leading-snug text-[var(--fg-muted)]">
                    {ROLE_PURPOSE[role] ?? 'Описание не задано'}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Roles reference (ADM-003) ───────────────────────────────────────────── */

function Roles() {
  const all = useMemo(
    () => [...ADMIN_ROLES.map((role) => ({ role, kind: 'admin' as const })), ...SELLER_ROLES.map((role) => ({ role, kind: 'seller' as const }))],
    [],
  );

  return (
    <>
      <div className="mb-4">
        <Note tone="neutral" title="Что здесь показано">
          Это та же таблица прав, по которой API отказывает по умолчанию. Если права нет в списке
          роли — действие будет отклонено сервером, независимо от того, видна ли кнопка в интерфейсе.
        </Note>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {all.map(({ role, kind }) => {
          const grants = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS];
          const isWildcard = grants?.[0] === '*';
          return (
            <Card
              key={role}
              title={
                <span className="flex items-center gap-2">
                  {role}
                  <Pill tone={kind === 'seller' ? 'info' : isWildcard ? 'dark' : 'accent'}>
                    {kind === 'seller' ? 'продавец' : 'платформа'}
                  </Pill>
                </span>
              }
            >
              <p className="text-[12.5px] leading-relaxed text-[var(--fg-muted)]">
                {ROLE_PURPOSE[role] ?? 'Описание не задано'}
              </p>
              {isWildcard ? (
                <p className="mt-2.5 text-[13px] font-medium">Все права без исключения</p>
              ) : (
                <div className="mt-2.5 flex flex-wrap gap-1">
                  {(grants ?? []).map((permission) => (
                    <span
                      key={permission}
                      className="t-mono rounded-[var(--radius-sm)] bg-[var(--bg-sunken)] px-1.5 py-[1px] text-[11px] text-[var(--fg-muted)]"
                    >
                      {permission}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}

/* ── Seller access ───────────────────────────────────────────────────────── */

function SellerUsers({ canWrite }: { canWrite: boolean }) {
  const { toast } = useApp();
  const [list, setList] = useState<SellerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<SellerRow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sellers
      .list({ limit: 100 })
      .then((page) => {
        if (!cancelled) setList(page.rows);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Note tone="danger">{error}</Note>;
  if (!list) return <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />;

  return (
    <>
      <div className="mb-4">
        <Note tone="neutral">
          Здесь создаётся первый вход в кабинет продавца — обычно владелец. Дальше продавец управляет
          своими сотрудниками сам, на экране «Сотрудники» в кабинете.
        </Note>
      </div>

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Продавец</th>
              <th>Статус</th>
              <th>ID</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.id}>
                <td className="font-medium">{row.displayName}</td>
                <td className="text-[12.5px] text-[var(--fg-muted)]">{row.onboardingStatus}</td>
                <td>
                  <CopyId value={row.id} />
                </td>
                <td className="text-right">
                  {canWrite && (
                    <Button size="xs" variant="outline" onClick={() => setTarget(row)}>
                      Создать доступ
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {target && (
        <CreateSellerUser
          seller={target}
          busy={busy}
          onClose={() => setTarget(null)}
          onSubmit={async (body) => {
            setBusy(true);
            try {
              await iam.createSellerUser(target.id, body);
              toast('Доступ создан', 'success');
              setTarget(null);
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </>
  );
}

function CreateSellerUser({
  seller,
  busy,
  onClose,
  onSubmit,
}: {
  seller: SellerRow;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { email: string; name: string; password: string; role: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<string>('SELLER_OWNER');

  const valid = /.+@.+\..+/.test(email) && name.trim().length >= 2 && password.length >= 12;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Доступ в кабинет · ${seller.displayName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() => onSubmit({ email: email.trim(), name: name.trim(), password, role })}
          >
            Создать
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <Field label="Имя" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field label="Email" required>
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Временный пароль" required hint="Минимум 12 символов">
          <Input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
        </Field>
        <Field label="Роль" hint={ROLE_PURPOSE[role]}>
          <Select value={role} onChange={(event) => setRole(event.target.value)}>
            {SELLER_ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
