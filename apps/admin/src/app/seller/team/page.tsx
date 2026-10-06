'use client';

/**
 * Seller staff and documents — spec §11.7, ADM-003.
 *
 * A seller's roles are narrower than the platform's and deliberately so: the
 * person who confirms orders does not need to see the balance, and the person
 * who edits the catalogue should not be able to add colleagues. Each role is
 * shown with what it actually grants, from the same table the API denies
 * against.
 *
 * The contract is on this screen rather than in a settings page because it is
 * what the commission and payout numbers elsewhere in the cabinet rest on. A
 * seller questioning a deduction should be one click from the clause.
 */

import { useCallback, useEffect, useState } from 'react';
import { ROLE_PERMISSIONS, SELLER_ROLES } from '@fashion/core';
import { errorMessage, useApp } from '@/lib/app-context';
import { seller } from '@/lib/endpoints';
import { date, dateTime } from '@/lib/format';
import {
  Button,
  Card,
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

const ROLE_PURPOSE: Record<string, string> = {
  SELLER_OWNER: 'Всё в кабинете, включая сотрудников и финансы.',
  SELLER_CATALOG: 'Товары, фотографии, размеры и остатки.',
  SELLER_ORDER: 'Подтверждение заказов, сборка, возвраты.',
  SELLER_FINANCE: 'Баланс, выплаты, выгрузки для бухгалтерии.',
  SELLER_VIEWER: 'Только просмотр, без изменений.',
};

type Pane = 'people' | 'contracts';

export default function SellerTeamPage() {
  const [pane, setPane] = useState<Pane>('people');

  return (
    <>
      <PageHeader title="Сотрудники" subtitle="Доступ в кабинет и документы магазина" />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'people', label: 'Люди и роли' },
          { value: 'contracts', label: 'Договор' },
        ]}
      />

      {pane === 'people' ? <People /> : <Contracts />}
    </>
  );
}

/* ── People ──────────────────────────────────────────────────────────────── */

function People() {
  const { can, toast } = useApp();
  const [data, setData] = useState<Awaited<ReturnType<typeof seller.users>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await seller.users());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />;

  const withoutMfa = data.items.filter((user) => !user.mfaEnabledAt && !user.disabledAt);

  return (
    <>
      {withoutMfa.length > 0 && (
        <div className="mb-4">
          <Note tone="warn" title="Не у всех включён второй фактор">
            {withoutMfa.length} сотрудник(ов) входят только по паролю. Кабинет видит заказы
            покупателей и ваши деньги — второй фактор здесь не формальность. Он настраивается при
            входе.
          </Note>
        </div>
      )}

      <Card
        title="Сотрудники"
        padded={false}
        action={
          can('iam:write') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Добавить сотрудника
            </Button>
          ) : undefined
        }
      >
        <Table>
          <thead>
            <tr>
              <th>Имя</th>
              <th>Email</th>
              <th>Роль</th>
              <th>MFA</th>
              <th>Последний вход</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((user) => (
              <tr key={user.id} className={user.disabledAt ? 'opacity-55' : undefined}>
                <td className="font-medium">{user.name}</td>
                <td className="t-mono text-[12px]">{user.email}</td>
                <td>
                  <Pill
                    tone={user.role === 'SELLER_OWNER' ? 'dark' : 'accent'}
                    title={ROLE_PURPOSE[user.role]}
                  >
                    {user.role}
                  </Pill>
                </td>
                <td>
                  {user.mfaEnabledAt ? (
                    <Pill tone="success">включена</Pill>
                  ) : (
                    <Pill tone="warn">не настроена</Pill>
                  )}
                </td>
                <td className="whitespace-nowrap text-[var(--fg-muted)]">
                  {user.disabledAt
                    ? `отключён ${date(user.disabledAt)}`
                    : user.lastLoginAt
                      ? dateTime(user.lastLoginAt)
                      : 'не входил'}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card className="mt-5" title="Что может каждая роль">
        <ul className="space-y-3">
          {SELLER_ROLES.map((role) => {
            const grants = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] ?? [];
            return (
              <li key={role} className="border-b border-[var(--line)] pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Pill tone={role === 'SELLER_OWNER' ? 'dark' : 'accent'}>{role}</Pill>
                  <span className="text-[12.5px] text-[var(--fg-muted)]">{ROLE_PURPOSE[role]}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(grants as readonly string[]).map((permission) => (
                    <span
                      key={permission}
                      className="t-mono rounded-[var(--radius-sm)] bg-[var(--bg-sunken)] px-1.5 py-[1px] text-[11px] text-[var(--fg-muted)]"
                    >
                      {permission}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
          Права проверяются на сервере при каждом запросе. Если права нет — действие будет отклонено,
          даже если кнопка где-то осталась видимой.
        </p>
      </Card>

      {creating && (
        <CreateUser
          roles={data.roles}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={async (body) => {
            setBusy(true);
            try {
              await seller.createUser(body);
              toast('Сотрудник добавлен', 'success');
              setCreating(false);
              await load();
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

function CreateUser({
  roles,
  busy,
  onClose,
  onSubmit,
}: {
  roles: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { email: string; name: string; password: string; role: string }) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(roles.includes('SELLER_ORDER') ? 'SELLER_ORDER' : (roles[0] ?? ''));

  const valid = /.+@.+\..+/.test(email) && name.trim().length >= 2 && password.length >= 12 && role !== '';

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
            onClick={() => onSubmit({ name: name.trim(), email: email.trim(), password, role })}
          >
            Добавить
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <Field label="Имя" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field label="Email" required hint="Он же логин в кабинет">
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field
          label="Временный пароль"
          required
          hint="Минимум 12 символов. Передайте его лично — сотрудник сменит пароль и настроит второй фактор при первом входе."
        >
          <Input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
        </Field>
        <Field label="Роль" hint={ROLE_PURPOSE[role]}>
          <Select value={role} onChange={(event) => setRole(event.target.value)}>
            {roles.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {role === 'SELLER_OWNER' && (
        <div className="mt-3">
          <Note tone="warn">
            Владелец видит финансы и может добавлять сотрудников. Для человека, который только
            собирает заказы, достаточно SELLER_ORDER.
          </Note>
        </div>
      )}
    </Modal>
  );
}

/* ── Contracts ───────────────────────────────────────────────────────────── */

function Contracts() {
  const [items, setItems] = useState<Array<Record<string, unknown>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await seller.contracts();
      setItems(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <div className="skeleton h-[160px] rounded-[var(--radius-lg)]" />;

  if (items.length === 0) {
    return (
      <Note tone="warn" title="Договор не загружен">
        Без подписанного договора магазин не активируется. Обратитесь к менеджеру платформы.
      </Note>
    );
  }

  return (
    <>
      {items.map((contract) => {
        const current = !contract.effectiveTo || new Date(String(contract.effectiveTo)) > new Date();
        return (
          <Card
            key={String(contract.id)}
            className="mb-4"
            title={
              <span className="flex items-center gap-2">
                <span className="t-mono">{String(contract.number ?? '')}</span>
                <span className="text-[11.5px] font-normal text-[var(--fg-faint)]">
                  версия {String(contract.version ?? '')}
                </span>
                {current ? <Pill tone="success">действует</Pill> : <Pill tone="neutral">архив</Pill>}
              </span>
            }
          >
            <dl className="grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
              <Row label="Подписан" value={contract.signedAt ? date(String(contract.signedAt)) : '—'} />
              <Row
                label="Действует"
                value={`${date(String(contract.effectiveFrom ?? ''))}${
                  contract.effectiveTo ? ` — ${date(String(contract.effectiveTo))}` : ' — бессрочно'
                }`}
              />
              <Row label="Эквайринг за счёт" value={String(contract.pspFeeBearer ?? '—')} />
            </dl>

            {contract.commissionBaseNote ? (
              <div className="mt-3.5">
                <span className="t-label mb-1 block">База комиссии</span>
                <p className="rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3.5 py-2.5 text-[13px] leading-relaxed">
                  {String(contract.commissionBaseNote)}
                </p>
              </div>
            ) : null}

            {contract.payoutScheduleNote ? (
              <div className="mt-3">
                <span className="t-label mb-1 block">Выплаты</span>
                <p className="rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3.5 py-2.5 text-[13px] leading-relaxed">
                  {String(contract.payoutScheduleNote)}
                </p>
              </div>
            ) : null}

            {contract.documentUrl ? (
              <div className="mt-4">
                <a
                  href={String(contract.documentUrl)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] text-[var(--accent-deep)] underline"
                >
                  Открыть документ
                </a>
              </div>
            ) : null}
          </Card>
        );
      })}

      <p className="text-[12px] leading-relaxed text-[var(--fg-faint)]">
        Условия выше — то, по чему считаются комиссия и выплаты в разделе «Баланс и выплаты». Если
        цифры там расходятся с этим текстом, это повод для обращения, а не для догадок.
      </p>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="t-label">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
