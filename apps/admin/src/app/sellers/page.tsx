'use client';

/**
 * Sellers — spec §11.1 and §10.3, SEL-001 (onboarding) and SEL-008 (quality).
 *
 * This is the screen where a seller becomes able to trade, and where that
 * ability is taken away. Activation is a gate, not a label: CAT-010 makes only
 * an ACTIVE seller's catalogue visible, so the API refuses to activate a
 * seller whose checklist is incomplete. The panel shows that checklist next to
 * the button rather than letting the operator discover it as a 422.
 *
 * Suspension disables the seller's own users as a side effect, which is not
 * obvious from the word "suspend" — so the confirmation says it.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import {
  sellers,
  type QualityScore,
  type SellerBalance,
  type SellerRow,
} from '@/lib/endpoints';
import { bps, date, dateTime, money, number } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  CopyId,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Pill,
  Select,
  Table,
  Tabs,
  Textarea,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, SearchBox, useList } from '@/components/data-screen';
import { QualityCard } from '@/components/quality';
import {
  SELLER_ONBOARDING_STATUSES,
  onboardingLabel,
  onboardingTone,
  type SellerOnboardingStatus,
} from '@/lib/status';

const PAGE = 25;

const ONBOARDING_OPTIONS = SELLER_ONBOARDING_STATUSES.map((value) => ({
  value,
  label: onboardingLabel(value),
}));

/** These two cut a seller off from trading, and the seller will ask why. */
const REASON_REQUIRED = new Set<string>(['SUSPENDED', 'OFFBOARDED']);

export default function SellersPage() {
  const { can } = useApp();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useList<SellerRow>(
    (offset) =>
      sellers
        .list({ q: query || undefined, status: status || undefined, limit: PAGE, offset })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [query, status],
    PAGE,
  );

  return (
    <>
      <PageHeader
        title="Продавцы"
        subtitle={`${number(list.total)} в системе`}
        action={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="Название или ИНН" />
            <FilterSelect
              value={status}
              onChange={setStatus}
              options={ONBOARDING_OPTIONS}
              allLabel="Все статусы"
            />
          </>
        }
      />

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Продавец</th>
              <th>Статус</th>
              <th className="num">Качество</th>
              <th className="num">Товаров</th>
              <th className="num">Заказов</th>
              <th className="num">Сборка</th>
              <th className="num">Резерв</th>
              <th>Расчёты</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={9} emptyTitle="Продавцов не найдено">
              {(rows) =>
                rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setOpenId(row.id)}
                    className="cursor-pointer hover:bg-[var(--bg-sunken)]"
                  >
                    <td>
                      <span className="block font-medium">{row.displayName}</span>
                      <span className="text-[11.5px] text-[var(--fg-faint)]">{row.legalName}</span>
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1">
                        <Pill tone={onboardingTone(row.onboardingStatus)}>
                          {onboardingLabel(row.onboardingStatus)}
                        </Pill>
                        {row.verified && <Pill tone="info">проверен</Pill>}
                        {row.payoutHold?.amount !== '0' && <Pill tone="danger">удержание</Pill>}
                      </div>
                    </td>
                    <td className="num t-num">
                      {row.qualityScore === null ? '—' : Math.round(row.qualityScore * 100)}
                    </td>
                    <td className="num t-num">{number(row.counts?.products ?? 0)}</td>
                    <td className="num t-num">{number(row.counts?.subOrders ?? 0)}</td>
                    <td className="num t-num">{row.handlingDays} д</td>
                    <td className="num t-num">{bps(row.returnReserveBps)}</td>
                    <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                      {row.settlementMode === 'PLATFORM_SETTLEMENT' ? 'через платформу' : 'сплит PSP'}
                    </td>
                    <td className="text-right text-[var(--fg-faint)]">→</td>
                  </tr>
                ))
              }
            </ListBody>
          </tbody>
        </Table>
        <ListFooter state={list} />
      </Card>

      {openId && (
        <SellerDetail
          id={openId}
          canWrite={can('seller:write')}
          onClose={() => setOpenId(null)}
          onChanged={list.reload}
        />
      )}
    </>
  );
}

/* ── Detail ──────────────────────────────────────────────────────────────── */

type Pane = 'profile' | 'commerce' | 'finance' | 'people';

function SellerDetail({
  id,
  canWrite,
  onClose,
  onChanged,
}: {
  id: string;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useApp();
  const [pane, setPane] = useState<Pane>('profile');
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [balance, setBalance] = useState<SellerBalance | null>(null);
  const [quality, setQuality] = useState<QualityScore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [transition, setTransition] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const detail = await sellers.get(id);
      setData(detail);
      // Balance and quality are separate reads: either may legitimately be
      // empty (no ledger entries, no orders measured) without hiding the
      // profile, which is what an operator opened this for.
      void sellers
        .balance(id)
        .then(setBalance)
        .catch(() => setBalance(null));
      void sellers
        .quality(id)
        .then(setQuality)
        .catch(() => setQuality(null));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (body: Record<string, unknown>, successMessage: string) => {
      setBusy(true);
      try {
        await sellers.update(id, body);
        toast(successMessage, 'success');
        await load();
        onChanged();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [id, toast, load, onChanged],
  );

  const applyTransition = useCallback(async () => {
    setBusy(true);
    try {
      await sellers.setOnboarding(id, transition as SellerOnboardingStatus, note.trim() || undefined);
      toast(`Статус изменён: ${onboardingLabel(transition)}`, 'success');
      setTransition('');
      setNote('');
      setConfirming(false);
      await load();
      onChanged();
    } catch (caught) {
      // SEL-001: the API answers an incomplete checklist with the missing keys.
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [id, transition, note, toast, load, onChanged]);

  const current = String(data?.onboardingStatus ?? '');
  const checklist = (data?.checklist as Array<{ key: string; label: string; done: boolean }>) ?? [];
  const checklistComplete = Boolean(data?.checklistComplete);
  const users = (data?.users as Array<Record<string, unknown>>) ?? [];
  const brands = (data?.brands as Array<Record<string, unknown>>) ?? [];
  const contracts = (data?.contracts as Array<Record<string, unknown>>) ?? [];
  const payoutAccounts = (data?.payoutAccounts as Array<Record<string, unknown>>) ?? [];
  const deliveryMethods = (data?.deliveryMethods as Array<Record<string, unknown>>) ?? [];
  const outstanding = checklist.filter((step) => !step.done);
  const blockedByChecklist = transition === 'ACTIVE' && !checklistComplete;

  return (
    <Modal
      open
      onClose={onClose}
      width={780}
      title={
        data ? (
          <span className="flex items-center gap-2.5">
            {String(data.displayName)}
            <Pill tone={onboardingTone(current)}>{onboardingLabel(current)}</Pill>
          </span>
        ) : (
          'Продавец'
        )
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      {error && <Note tone="danger">{error}</Note>}
      {!data && !error && <div className="skeleton h-[220px] w-full rounded-[var(--radius-md)]" />}

      {data && (
        <>
          <Tabs
            className="mb-4"
            value={pane}
            onChange={setPane}
            options={[
              { value: 'profile', label: 'Профиль' },
              { value: 'commerce', label: 'Условия' },
              { value: 'finance', label: 'Финансы' },
              { value: 'people', label: 'Люди и документы' },
            ]}
          />

          {pane === 'profile' && (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
                <Row label="Юр. лицо" value={String(data.legalName ?? '—')} />
                <Row label="ИНН" value={<span className="t-mono">{String(data.taxId ?? '—')}</span>} />
                <Row
                  label="Рег. номер"
                  value={<span className="t-mono">{String(data.registrationNumber ?? '—')}</span>}
                />
                <Row label="Подписант" value={String(data.signatoryName ?? '—')} />
                <Row label="Адрес" value={String(data.legalAddress ?? '—')} />
                <Row
                  label="Контакт"
                  value={`${String(data.contactEmail ?? '—')} · ${String(data.contactPhone ?? '')}`}
                />
                <Row label="Создан" value={date(String(data.createdAt ?? ''))} />
                <Row label="ID" value={<CopyId value={id} />} />
              </dl>

              {data.description ? (
                <p className="mt-3 text-[13px] leading-relaxed text-[var(--fg-muted)]">
                  {String(data.description)}
                </p>
              ) : null}

              {/* SEL-001 / Appendix C: the gate, and what is still holding it shut. */}
              <Card className="mt-5" title="Чек-лист подключения">
                {checklist.length === 0 ? (
                  <p className="text-[13px] text-[var(--fg-muted)]">Чек-лист недоступен.</p>
                ) : (
                  <ul className="space-y-1.5 text-[13px]">
                    {checklist.map((step) => (
                      <li key={step.key} className="flex items-start gap-2">
                        <span className={step.done ? 'text-success' : 'text-[var(--fg-faint)]'}>
                          {step.done ? '✓' : '○'}
                        </span>
                        <span className={step.done ? 'text-[var(--fg-muted)]' : undefined}>{step.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {!checklistComplete && (
                  <div className="mt-3">
                    <Note tone="warn">
                      Активация заблокирована: не выполнено пунктов — {outstanding.length}. Пока
                      продавец не активен, его товары не попадают в каталог (CAT-010).
                    </Note>
                  </div>
                )}
              </Card>

              {canWrite && (
                <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--line)] p-3.5">
                  <h3 className="t-eyebrow mb-2.5">Изменить статус</h3>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Новый статус" className="min-w-[200px] flex-1">
                      <Select value={transition} onChange={(event) => setTransition(event.target.value)}>
                        <option value="">—</option>
                        {SELLER_ONBOARDING_STATUSES.filter((value) => value !== current).map((value) => (
                          <option key={value} value={value}>
                            {onboardingLabel(value)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button
                      variant={REASON_REQUIRED.has(transition) ? 'danger' : 'primary'}
                      disabled={
                        !transition ||
                        blockedByChecklist ||
                        (REASON_REQUIRED.has(transition) && note.trim().length < 3)
                      }
                      title={blockedByChecklist ? 'Сначала нужно закрыть чек-лист подключения' : undefined}
                      loading={busy}
                      onClick={() =>
                        REASON_REQUIRED.has(transition) ? setConfirming(true) : void applyTransition()
                      }
                    >
                      Применить
                    </Button>
                  </div>
                  <div className="mt-2.5">
                    <Field
                      label="Причина"
                      required={REASON_REQUIRED.has(transition)}
                      hint="Попадёт в аудит с уровнем CRITICAL. Для приостановки и отключения обязательна."
                    >
                      <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
                    </Field>
                  </div>
                </div>
              )}

              <ConfirmModal
                open={confirming}
                onClose={() => setConfirming(false)}
                onConfirm={applyTransition}
                busy={busy}
                danger
                confirmWord={transition === 'OFFBOARDED' ? 'ОТКЛЮЧИТЬ' : undefined}
                title={transition === 'SUSPENDED' ? 'Приостановить продавца' : 'Отключить продавца'}
                confirmLabel="Подтвердить"
                body={
                  <>
                    <p>
                      {transition === 'SUSPENDED'
                        ? 'Товары продавца уйдут из каталога, новые заказы перестанут поступать.'
                        : 'Продавец будет отключён от платформы.'}
                    </p>
                    <p className="mt-2">
                      Вместе с этим будут отключены все учётные записи сотрудников продавца — они
                      потеряют доступ к кабинету немедленно.
                    </p>
                    <p className="mt-2 text-[12.5px] text-[var(--fg-muted)]">
                      Уже оплаченные заказы нужно довести до конца, а баланс — выплатить: статус
                      продавца на реестр не влияет.
                    </p>
                  </>
                }
              />
            </>
          )}

          {pane === 'commerce' && (
            <CommerceSettings data={data} canWrite={canWrite} busy={busy} onSave={save} />
          )}

          {pane === 'finance' && (
            <>
              {balance ? (
                <Card title="Баланс по реестру">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
                    <Row label="Продажи" value={money(balance.salesGross)} />
                    <Row label="Комиссия" value={`−${money(balance.commission)}`} />
                    <Row label="Скидки продавца" value={`−${money(balance.discountsSellerFunded)}`} />
                    <Row label="Возвраты" value={`−${money(balance.refunds)}`} />
                    <Row label="Реверс комиссии" value={`+${money(balance.commissionReversals)}`} />
                    <Row label="Корректировки" value={money(balance.adjustments)} />
                    <Row label="Выплачено" value={money(balance.paidOut)} />
                    <Row label="Резерв под возвраты" value={money(balance.reserve)} />
                    <Row label="Удержано" value={money(balance.hold)} />
                    <Row
                      label="Доступно к выплате"
                      value={<strong className="t-money">{money(balance.availableForPayout)}</strong>}
                    />
                  </dl>
                  <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
                    Все суммы выведены из реестра операций, а не пересчитаны по заказам. Расхождение
                    между этими двумя способами — это инцидент, который ищется на экране «Реестр».
                  </p>
                </Card>
              ) : (
                <Note tone="neutral">Операций по реестру ещё нет.</Note>
              )}

              <div className="mt-4">
                <QualityCard quality={quality} />
              </div>

              {payoutAccounts.length > 0 && (
                <Card className="mt-4" title="Реквизиты выплат" padded={false}>
                  <Table>
                    <thead>
                      <tr>
                        <th>Банк</th>
                        <th>Счёт</th>
                        <th>МФО</th>
                        <th>Проверен</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payoutAccounts.map((account) => (
                        <tr key={String(account.id)}>
                          <td>{String(account.bankName ?? '—')}</td>
                          <td className="t-mono">{String(account.accountNumberMasked ?? '—')}</td>
                          <td className="t-mono">{String(account.mfo ?? '—')}</td>
                          <td>
                            {account.verifiedAt ? (
                              <Pill tone="success">{date(String(account.verifiedAt))}</Pill>
                            ) : (
                              // PAY-011: an unverified account must not receive money.
                              <Pill tone="danger">не проверен</Pill>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}
            </>
          )}

          {pane === 'people' && (
            <>
              <Card title="Сотрудники" padded={false}>
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
                    {users.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-[13px] text-[var(--fg-muted)]">
                          Сотрудников нет
                        </td>
                      </tr>
                    ) : (
                      users.map((user) => (
                        <tr key={String(user.id)} className={user.disabledAt ? 'opacity-55' : undefined}>
                          <td>{String(user.name ?? '—')}</td>
                          <td className="t-mono text-[12px]">{String(user.email ?? '')}</td>
                          <td>
                            <Pill>{String(user.role ?? '')}</Pill>
                          </td>
                          <td>
                            {user.mfaEnabledAt ? (
                              <Pill tone="success">включена</Pill>
                            ) : (
                              <Pill tone="warn">нет</Pill>
                            )}
                          </td>
                          <td className="text-[var(--fg-muted)]">
                            {user.disabledAt
                              ? `отключён ${date(String(user.disabledAt))}`
                              : user.lastLoginAt
                                ? dateTime(String(user.lastLoginAt))
                                : 'не входил'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </Table>
              </Card>

              {brands.length > 0 && (
                <Card className="mt-4" title="Бренды" padded={false}>
                  <Table>
                    <thead>
                      <tr>
                        <th>Бренд</th>
                        <th>Права на контент</th>
                        <th>Витрина</th>
                      </tr>
                    </thead>
                    <tbody>
                      {brands.map((brand) => (
                        <tr key={String(brand.id)}>
                          <td className="font-medium">{String(brand.name ?? '')}</td>
                          <td>
                            {/* CAT-010: media may not be published without this. */}
                            {brand.contentRightsConfirmedAt ? (
                              <Pill tone="success">
                                подтверждены {date(String(brand.contentRightsConfirmedAt))}
                              </Pill>
                            ) : (
                              <Pill tone="danger">не подтверждены</Pill>
                            )}
                          </td>
                          <td>{brand.featured ? <Pill tone="accent">в подборке</Pill> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}

              {contracts.length > 0 && (
                <Card className="mt-4" title="Договоры">
                  <ul className="space-y-3">
                    {contracts.map((contract) => (
                      <li
                        key={String(contract.id)}
                        className="border-b border-[var(--line)] pb-3 last:border-0 last:pb-0"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="t-mono text-[13px]">
                            {String(contract.number ?? '')} · в. {String(contract.version ?? '')}
                          </span>
                          <span className="text-[12px] text-[var(--fg-muted)]">
                            с {date(String(contract.effectiveFrom ?? ''))}
                            {contract.effectiveTo ? ` по ${date(String(contract.effectiveTo))}` : ''}
                          </span>
                        </div>
                        {contract.commissionBaseNote ? (
                          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--fg-muted)]">
                            {String(contract.commissionBaseNote)}
                          </p>
                        ) : null}
                        <p className="mt-1 text-[11.5px] text-[var(--fg-faint)]">
                          Эквайринг: {String(contract.pspFeeBearer ?? '—')}
                          {contract.payoutScheduleNote ? ` · ${String(contract.payoutScheduleNote)}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {deliveryMethods.length > 0 && (
                <Card className="mt-4" title="Способы доставки" padded={false}>
                  <Table>
                    <thead>
                      <tr>
                        <th>Способ</th>
                        <th className="num">Цена</th>
                        <th className="num">Срок</th>
                        <th>Активен</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveryMethods.map((method) => (
                        <tr key={String(method.id)}>
                          <td>{String(method.nameRu ?? method.code ?? '')}</td>
                          <td className="num t-money">
                            {money({
                              amount: String(method.priceMinor ?? '0'),
                              currency: String(method.currency ?? 'UZS'),
                            } as never)}
                          </td>
                          <td className="num t-num whitespace-nowrap">
                            {String(method.minDays ?? '')}–{String(method.maxDays ?? '')} д
                          </td>
                          <td>{method.isActive ? <Pill tone="success">да</Pill> : <Pill>нет</Pill>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/* ── Commercial settings ─────────────────────────────────────────────────── */

/**
 * Only the fields the API's update actually accepts are editable here.
 * `verified` follows activation and the payout hold is written by the finance
 * side, so both are shown read-only rather than as controls that look like
 * they work and silently do nothing.
 */
function CommerceSettings({
  data,
  canWrite,
  busy,
  onSave,
}: {
  data: Record<string, unknown>;
  canWrite: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>, successMessage: string) => Promise<void>;
}) {
  const initial = {
    handlingDays: String(data.handlingDays ?? ''),
    cutoff: String(data.cutoffLocalTime ?? ''),
    reserveBps: String(data.returnReserveBps ?? ''),
    payoutSchedule: String(data.payoutScheduleDays ?? ''),
    settlementMode: String(data.settlementMode ?? ''),
  };

  const [handlingDays, setHandlingDays] = useState(initial.handlingDays);
  const [cutoff, setCutoff] = useState(initial.cutoff);
  const [reserveBps, setReserveBps] = useState(initial.reserveBps);
  const [payoutSchedule, setPayoutSchedule] = useState(initial.payoutSchedule);
  const [settlementMode, setSettlementMode] = useState(initial.settlementMode);

  const heldMinor = String((data.payoutHold as { amount?: string } | undefined)?.amount ?? '0');
  const currency = String(data.currency ?? 'UZS');

  const dirty =
    handlingDays !== initial.handlingDays ||
    cutoff !== initial.cutoff ||
    reserveBps !== initial.reserveBps ||
    payoutSchedule !== initial.payoutSchedule ||
    settlementMode !== initial.settlementMode;

  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Дней на сборку" hint="Входит в обещанный покупателю срок доставки">
          <Input
            type="number"
            min={0}
            max={30}
            value={handlingDays}
            disabled={!canWrite}
            onChange={(event) => setHandlingDays(event.target.value)}
          />
        </Field>
        <Field
          label="Отсечка приёма заказов"
          hint="Местное время, после которого заказ считается принятым на следующий день"
        >
          <Input
            placeholder="14:00"
            value={cutoff}
            disabled={!canWrite}
            onChange={(event) => setCutoff(event.target.value)}
          />
        </Field>
        <Field
          label="Резерв под возвраты, б.п."
          hint={`${bps(Number(reserveBps) || 0)} выплаты удерживается до закрытия окна возврата`}
        >
          <Input
            type="number"
            min={0}
            max={5000}
            value={reserveBps}
            disabled={!canWrite}
            onChange={(event) => setReserveBps(event.target.value)}
          />
        </Field>
        <Field label="Период выплат, дней">
          <Input
            type="number"
            min={1}
            max={90}
            value={payoutSchedule}
            disabled={!canWrite}
            onChange={(event) => setPayoutSchedule(event.target.value)}
          />
        </Field>
        <Field label="Схема расчётов" hint="Определяет, кто получает деньги от платёжного провайдера">
          <Select
            value={settlementMode}
            disabled={!canWrite}
            onChange={(event) => setSettlementMode(event.target.value)}
          >
            <option value="PLATFORM_SETTLEMENT">Через платформу</option>
            <option value="NATIVE_SPLIT">Нативный сплит PSP</option>
          </Select>
        </Field>
      </div>

      {canWrite && (
        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="primary"
            disabled={!dirty}
            loading={busy}
            onClick={() =>
              void onSave(
                {
                  handlingDays: Number(handlingDays),
                  cutoffLocalTime: cutoff || null,
                  returnReserveBps: Number(reserveBps),
                  payoutScheduleDays: Number(payoutSchedule),
                  settlementMode,
                },
                'Условия сохранены',
              )
            }
          >
            Сохранить
          </Button>
          {dirty && <span className="text-[12px] text-[var(--fg-faint)]">есть несохранённые изменения</span>}
        </div>
      )}

      <Card className="mt-5" title="Выплаты и проверка">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
          <Row
            label="Значок проверенного продавца"
            value={
              data.verified ? (
                <Pill tone="success">показывается покупателю</Pill>
              ) : (
                <Pill tone="neutral">не показывается</Pill>
              )
            }
          />
          <Row
            label="Удержано из выплат"
            value={
              heldMinor === '0' ? (
                <span className="text-[var(--fg-muted)]">нет удержаний</span>
              ) : (
                <strong className="t-money text-danger">
                  {money({ amount: heldMinor, currency } as never)}
                </strong>
              )
            }
          />
        </dl>
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
          Значок проверенного продавца ставится активацией и снимается приостановкой — отдельного
          переключателя нет намеренно. Удержание из выплат — финансовая операция: оно создаётся
          корректировкой в реестре, поэтому меняется там, а не здесь.
        </p>
      </Card>
    </>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="t-label">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}
