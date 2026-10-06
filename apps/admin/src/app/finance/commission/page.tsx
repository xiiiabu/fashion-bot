'use client';

/**
 * Commission, refunds and adjustments — spec §8.1–§8.4, PAY-002, PAY-003,
 * PAY-009, CAT-005.
 *
 * The commission is the business model, and D-03 fixed its definition: 10% of
 * the goods value actually paid, after a seller-funded discount, delivery
 * excluded, PSP fee borne by the platform. Everything on this screen is
 * arranged to make a deviation from that visible:
 *
 *  - The effective take rate is shown next to the nominal 1000 bps. They
 *    diverge for real reasons — refunds reverse commission, a platform-funded
 *    discount does not reduce the base, a seller has their own rule — and the
 *    point of showing both is that the reason gets looked for.
 *  - A rule is versioned, never edited. An order keeps the rule it was priced
 *    under, so the history is what explains an old invoice.
 *  - An adjustment is the only way to move a balance outside the normal flow,
 *    so it is the most deliberate form on the screen: signed amount, a reason
 *    of real length, and a second approver before it touches the ledger.
 */

import { useCallback, useEffect, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import {
  finance,
  sellers,
  type CommissionRule,
  type PlatformTotals,
  type RefundRow,
  type SellerRow,
} from '@/lib/endpoints';
import { amount, bps, date, dateTime, money, number, percent } from '@/lib/format';
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
  Stat,
  Switch,
  Table,
  Tabs,
  Textarea,
  cx,
} from '@/components/ui';
import { ListBody, ListFooter, useList } from '@/components/data-screen';

/** D-03: the agreed commission, in basis points. */
const NOMINAL_BPS = 1000;

type Pane = 'overview' | 'rules' | 'refunds' | 'adjustments';

export default function CommissionPage() {
  const { can } = useApp();
  const [pane, setPane] = useState<Pane>('overview');

  return (
    <>
      <PageHeader
        title="Комиссия"
        subtitle="10% от оплаченной стоимости товара после скидки продавца; доставка не входит (D-03)"
      />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'overview', label: 'Итоги' },
          { value: 'rules', label: 'Правила' },
          { value: 'refunds', label: 'Возвраты денег' },
          { value: 'adjustments', label: 'Корректировки' },
        ]}
      />

      {pane === 'overview' && <Overview />}
      {pane === 'rules' && <Rules canWrite={can('commissionrule:write')} />}
      {pane === 'refunds' && <Refunds canApprove={can('adjustment:approve')} />}
      {pane === 'adjustments' && <Adjustments canWrite={can('adjustment:write')} />}
    </>
  );
}

/* ── Overview (PAY-003) ─────────────────────────────────────────────────── */

function Overview() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<PlatformTotals | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      setData(await finance.platformTotals(from || undefined, to || undefined));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;

  const drift = data ? data.effectiveTakeRateBps - NOMINAL_BPS : 0;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="С" className="w-[170px]">
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="По" className="w-[170px]">
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
        {(from || to) && (
          <Button
            variant="ghost"
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            За всё время
          </Button>
        )}
      </div>

      {!data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton h-[86px] rounded-[var(--radius-lg)]" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Продажи нетто" value={money(data.netSales)} hint={`брутто ${money(data.salesGross)}`} />
            <Stat
              label="Комиссия нетто"
              value={money(data.netCommission)}
              hint={`начислено ${money(data.commission)}, реверс ${money(data.commissionReversals)}`}
            />
            <Stat
              label="Фактическая ставка"
              value={bps(data.effectiveTakeRateBps)}
              hint={`номинал ${bps(NOMINAL_BPS)}`}
              tone={Math.abs(drift) > 50 ? 'warn' : undefined}
            />
            <Stat
              label="Эквайринг"
              value={money(data.pspFees)}
              hint="за счёт платформы (D-03)"
            />
          </div>

          {Math.abs(drift) > 50 && (
            <div className="mt-4">
              <Note tone="warn" title="Фактическая ставка расходится с номинальной">
                {drift > 0
                  ? `Фактическая ставка выше номинальной на ${bps(drift)}.`
                  : `Фактическая ставка ниже номинальной на ${bps(-drift)}.`}{' '}
                Это может быть нормой — возвраты реверсируют комиссию, скидки за счёт платформы базу
                не уменьшают, у отдельных продавцов могут быть свои правила. Но причину стоит
                назвать: расхождение без объяснения со временем превращается в ошибку расчёта.
              </Note>
            </div>
          )}

          <Card className="mt-5" title="Из чего сложилось">
            <dl className="grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
              <Row label="Продажи, брутто" value={money(data.salesGross)} />
              <Row label="Возвраты покупателям" value={`−${money(data.refunds)}`} />
              <Row label="Скидки за счёт продавца" value={money(data.sellerDiscounts)} />
              <Row label="Скидки за счёт платформы" value={money(data.platformDiscounts)} />
              <Row label="Комиссия начислена" value={money(data.commission)} />
              <Row label="Комиссия реверсирована" value={`−${money(data.commissionReversals)}`} />
              <Row label="Выплачено продавцам" value={money(data.payouts)} />
              <Row label="Корректировки" value={money(data.adjustments)} />
              <Row label="Записей в реестре" value={number(data.entryCount)} />
            </dl>
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
              Все суммы — агрегаты записей реестра, а не пересчёт по заказам. Эквайринг в базу
              комиссии не входит и несётся платформой; доставка в базу не входит тоже.
            </p>
          </Card>
        </>
      )}
    </>
  );
}

/* ── Rules (PAY-002) ────────────────────────────────────────────────────── */

function Rules({ canWrite }: { canWrite: boolean }) {
  const { toast } = useApp();
  const [rows, setRows] = useState<CommissionRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await finance.commissionRules();
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />;

  return (
    <>
      <div className="mb-4">
        <Note tone="neutral" title="Правила версионируются, а не правятся">
          Новая ставка — это новая версия правила. Уже оформленные заказы сохраняют ту версию, по
          которой были посчитаны: иначе прошлый отчёт перестанет сходиться после каждого изменения.
        </Note>
      </div>

      <Card
        title={`Правила · ${number(rows.length)}`}
        padded={false}
        action={
          canWrite ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Новая версия
            </Button>
          ) : undefined
        }
      >
        <Table>
          <thead>
            <tr>
              <th>Код</th>
              <th className="num">Версия</th>
              <th className="num">Ставка</th>
              <th>Область</th>
              <th>База</th>
              <th>Округление</th>
              <th>Действует</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const active = !row.effectiveTo || new Date(row.effectiveTo).getTime() > Date.now();
              return (
                <tr key={row.id} className={active ? undefined : 'opacity-55'}>
                  <td className="t-mono text-[12.5px]">{row.code}</td>
                  <td className="num t-num">{row.version}</td>
                  <td className="num t-money font-medium">{bps(row.rateBps)}</td>
                  <td className="text-[12.5px]">
                    {row.sellerId ? (
                      <span className="flex items-center gap-1.5">
                        <Pill tone="info">продавец</Pill>
                        <CopyId value={row.sellerId} />
                      </span>
                    ) : row.categoryId ? (
                      <span className="flex items-center gap-1.5">
                        <Pill tone="accent">категория</Pill>
                        <CopyId value={row.categoryId} />
                      </span>
                    ) : (
                      <Pill tone={row.isDefault ? 'dark' : 'neutral'}>
                        {row.isDefault ? 'по умолчанию' : 'вся платформа'}
                      </Pill>
                    )}
                  </td>
                  <td className="text-[11.5px] leading-snug text-[var(--fg-muted)]">
                    {row.includesDelivery ? 'с доставкой' : 'без доставки'}
                    <br />
                    {row.sellerDiscountReducesBase ? 'скидка продавца уменьшает' : 'скидка продавца не уменьшает'}
                    <br />
                    {row.platformDiscountReducesBase
                      ? 'скидка платформы уменьшает'
                      : 'скидка платформы не уменьшает'}
                  </td>
                  <td className="text-[12px] text-[var(--fg-muted)]">{row.rounding}</td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                    {date(row.effectiveFrom)}
                    {row.effectiveTo ? ` → ${date(row.effectiveTo)}` : ' → бессрочно'}
                  </td>
                  <td className="max-w-[160px] truncate text-[11.5px] text-[var(--fg-faint)]" title={row.note ?? ''}>
                    {row.note ?? ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {creating && (
        <RuleEditor
          existing={rows}
          busy={busy}
          onClose={() => setCreating(false)}
          onSave={async (body) => {
            setBusy(true);
            try {
              await finance.createCommissionRule(body);
              toast('Новая версия правила создана', 'success');
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

function RuleEditor({
  existing,
  busy,
  onClose,
  onSave,
}: {
  existing: CommissionRule[];
  busy: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof finance.createCommissionRule>[0]) => void;
}) {
  const base = existing.find((rule) => rule.isDefault) ?? existing[0];
  const [code, setCode] = useState(base?.code ?? 'default');
  const [rate, setRate] = useState(String(base?.rateBps ?? NOMINAL_BPS));
  const [includesDelivery, setIncludesDelivery] = useState(base?.includesDelivery ?? false);
  const [sellerDiscount, setSellerDiscount] = useState(base?.sellerDiscountReducesBase ?? true);
  const [platformDiscount, setPlatformDiscount] = useState(base?.platformDiscountReducesBase ?? false);
  const [rounding, setRounding] = useState<'HALF_UP' | 'FLOOR' | 'CEIL'>(base?.rounding ?? 'HALF_UP');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');

  const rateBps = Number(rate);
  const valid =
    code.trim().length >= 2 && Number.isInteger(rateBps) && rateBps >= 0 && rateBps <= 5000;

  // The contract is explicit about these three, so a rule that departs from
  // them is worth flagging rather than quietly accepting.
  const departsFromContract = includesDelivery || !sellerDiscount || platformDiscount;

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title="Новая версия правила комиссии"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() =>
              onSave({
                code: code.trim(),
                rateBps,
                includesDelivery,
                sellerDiscountReducesBase: sellerDiscount,
                platformDiscountReducesBase: platformDiscount,
                rounding,
                effectiveFrom: effectiveFrom || undefined,
                note: note.trim() || undefined,
              })
            }
          >
            Создать версию
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Код" required hint="Тот же код = новая версия того же правила">
          <Input value={code} onChange={(event) => setCode(event.target.value)} />
        </Field>
        <Field label="Ставка, б.п." required hint={`${bps(rateBps || 0)} от базы`}>
          <Input
            type="number"
            min={0}
            max={5000}
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
        </Field>
        <Field label="Действует с">
          <Input
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </Field>
        <Field label="Округление" hint="По договору — HALF_UP">
          <Select
            value={rounding}
            onChange={(event) => setRounding(event.target.value as 'HALF_UP' | 'FLOOR' | 'CEIL')}
          >
            <option value="HALF_UP">HALF_UP — к ближайшему</option>
            <option value="FLOOR">FLOOR — вниз</option>
            <option value="CEIL">CEIL — вверх</option>
          </Select>
        </Field>
      </div>

      <div className="mt-4 space-y-3">
        <Switch
          checked={includesDelivery}
          onChange={setIncludesDelivery}
          label="Доставка входит в базу"
          hint="По договору — не входит"
        />
        <Switch
          checked={sellerDiscount}
          onChange={setSellerDiscount}
          label="Скидка продавца уменьшает базу"
          hint="По договору — уменьшает: комиссия считается с фактически оплаченной суммы"
        />
        <Switch
          checked={platformDiscount}
          onChange={setPlatformDiscount}
          label="Скидка платформы уменьшает базу"
          hint="По договору — не уменьшает: скидку финансирует платформа, продавец получает полную цену"
        />
      </div>

      <div className="mt-4">
        <Field label="Комментарий" hint="Зачем нужна новая версия — это единственное объяснение, которое останется">
          <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>

      {departsFromContract && (
        <div className="mt-3">
          <Note tone="warn" title="Правило отличается от договорного">
            D-03 фиксирует: 10% от оплаченной стоимости товара после скидки продавца, доставка не
            входит, скидка платформы базу не уменьшает. Отклонение само по себе допустимо, но
            договор с продавцом должен говорить то же, что это правило.
          </Note>
        </div>
      )}

      {rateBps !== NOMINAL_BPS && (
        <div className="mt-3">
          <Note tone="neutral">
            Ставка {bps(rateBps || 0)} вместо номинальных {bps(NOMINAL_BPS)}. Применится к заказам,
            оформленным после даты вступления; уже существующие сохранят свою версию.
          </Note>
        </div>
      )}
    </Modal>
  );
}

/* ── Refunds ─────────────────────────────────────────────────────────────── */

function Refunds({ canApprove }: { canApprove: boolean }) {
  const { toast, principal } = useApp();
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<RefundRow | null>(null);

  const list = useList<RefundRow>(
    (offset) =>
      finance
        .refunds({ limit: 50 })
        .then((page) => ({ rows: offset === 0 ? page.rows : [], total: page.total })),
    [],
    50,
  );

  const approve = useCallback(async () => {
    if (!approving) return;
    setBusy(true);
    try {
      await finance.approveRefund(approving.id);
      toast('Возврат согласован', 'success');
      setApproving(null);
      list.reload();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [approving, toast, list]);

  return (
    <>
      <div className="mb-4">
        <Note tone="neutral">
          Возврат покупателю одновременно реверсирует комиссию платформы: продавцу возвращается его
          доля, платформе — её. Поэтому сумма возврата и реверс комиссии показаны рядом.
        </Note>
      </div>

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Возврат</th>
              <th>Заказ</th>
              <th>Статус</th>
              <th className="num">Сумма</th>
              <th className="num">Реверс комиссии</th>
              <th>Причина</th>
              <th>Провайдер</th>
              <th>Создан</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={9} emptyTitle="Возвратов денег не было">
              {(rows) =>
                rows.map((row) => (
                  <tr key={row.id}>
                    <td className="t-mono whitespace-nowrap text-[12.5px]">{row.number}</td>
                    <td className="t-mono whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                      {row.orderNumber}
                    </td>
                    <td>
                      <Pill
                        tone={
                          row.status === 'SUCCEEDED' || row.status === 'COMPLETED'
                            ? 'success'
                            : row.status === 'FAILED'
                              ? 'danger'
                              : row.requiresApproval
                                ? 'accent'
                                : 'info'
                        }
                      >
                        {row.status}
                      </Pill>
                    </td>
                    <td className="num t-money">{money(row.amount)}</td>
                    <td className="num t-money text-success">+{amount(row.commissionReversal)}</td>
                    <td className="max-w-[180px] truncate text-[12.5px]" title={row.reason ?? ''}>
                      {row.reason ?? '—'}
                    </td>
                    <td className="text-[12px] uppercase text-[var(--fg-muted)]">{row.provider ?? '—'}</td>
                    <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                      {dateTime(row.createdAt)}
                    </td>
                    <td className="text-right">
                      {canApprove && row.requiresApproval && (
                        <Button size="xs" variant="primary" onClick={() => setApproving(row)}>
                          Согласовать
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              }
            </ListBody>
          </tbody>
        </Table>
        <ListFooter state={list} />
      </Card>

      {approving && (
        <ConfirmModal
          open
          onClose={() => setApproving(null)}
          onConfirm={approve}
          busy={busy}
          danger
          confirmWord="СОГЛАСОВАНО"
          title="Согласовать возврат"
          confirmLabel="Согласовать"
          body={
            <>
              <p>
                Возврат <span className="t-mono">{approving.number}</span> на{' '}
                <strong className="t-money">{money(approving.amount)}</strong> по заказу{' '}
                <span className="t-mono">{approving.orderNumber}</span>.
              </p>
              <p className="mt-2">
                Будет реверсирована комиссия{' '}
                <strong className="t-money">{money(approving.commissionReversal)}</strong>. Деньги
                уходят покупателю, отменить это можно только новым начислением.
              </p>
              {/* ADM-005: the API refuses a self-approval; say so first. */}
              <p className="mt-2 text-[12.5px] text-[var(--fg-muted)]">
                Согласовать может только сотрудник, который не создавал этот возврат. Вы вошли как{' '}
                {principal?.email}.
              </p>
            </>
          }
        />
      )}
    </>
  );
}

/* ── Adjustments (PAY-009) ──────────────────────────────────────────────── */

function Adjustments({ canWrite }: { canWrite: boolean }) {
  const { toast } = useApp();
  const [sellerList, setSellerList] = useState<SellerRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sellers
      .list({ limit: 100 })
      .then((page) => {
        if (!cancelled) setSellerList(page.rows);
      })
      .catch(() => {
        if (!cancelled) setSellerList([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="mb-4">
        <Note tone="warn" title="Корректировка — исключение, а не инструмент">
          Она меняет баланс продавца вне обычного хода заказов: компенсация, удержание, исправление
          ошибки. Запись попадает в реестр и требует второго согласующего. Если то же можно сделать
          возвратом или отменой позиции — делайте так: эти операции объясняют себя сами, а
          корректировка объясняется только текстом причины.
        </Note>
      </div>

      <Card
        title="Создать корректировку"
        action={
          canWrite ? (
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              Новая корректировка
            </Button>
          ) : undefined
        }
      >
        <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
          Созданная корректировка ждёт согласования на экране «Согласования» и до этого момента на
          баланс не влияет. Там же видно, кто её создал — согласовать свою нельзя.
        </p>
      </Card>

      <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
        Все корректировки видны в реестре операций как записи с событием ADJUSTMENT: отдельного
        журнала нет намеренно, чтобы не было двух версий правды.
      </p>

      {creating && (
        <AdjustmentForm
          sellerOptions={sellerList ?? []}
          busy={busy}
          onClose={() => setCreating(false)}
          onSave={async (body) => {
            setBusy(true);
            try {
              await finance.createAdjustment(body);
              toast('Корректировка создана и отправлена на согласование', 'success');
              setCreating(false);
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

const CATEGORIES = [
  { value: 'COMPENSATION', label: 'Компенсация продавцу' },
  { value: 'PENALTY', label: 'Удержание с продавца' },
  { value: 'CORRECTION', label: 'Исправление ошибки расчёта' },
  { value: 'GOODWILL', label: 'Жест доброй воли' },
  { value: 'DELIVERY', label: 'Доставка' },
  { value: 'OTHER', label: 'Другое' },
];

function AdjustmentForm({
  sellerOptions,
  busy,
  onClose,
  onSave,
}: {
  sellerOptions: SellerRow[];
  busy: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof finance.createAdjustment>[0]) => void;
}) {
  const [sellerId, setSellerId] = useState('');
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [major, setMajor] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0].value);
  const [reason, setReason] = useState('');

  // CAT-005: money is integer minor units. The field takes whole so'm and the
  // conversion happens once, here, with no floating point anywhere near it.
  const digits = major.replace(/\D/g, '');
  const minor = digits === '' ? '' : `${digits}00`;
  const valid = sellerId !== '' && digits !== '' && digits !== '0' && reason.trim().length >= 8;
  const signed = minor === '' ? '' : direction === 'debit' ? `-${minor}` : minor;

  return (
    <Modal
      open
      onClose={onClose}
      width={580}
      title="Новая корректировка"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() =>
              onSave({
                sellerId,
                amountMinor: signed,
                currency: 'UZS',
                reason: reason.trim(),
                category,
              })
            }
          >
            Создать
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <Field label="Продавец" required>
          <Select value={sellerId} onChange={(event) => setSellerId(event.target.value)}>
            <option value="">—</option>
            {sellerOptions.map((seller) => (
              <option key={seller.id} value={seller.id}>
                {seller.displayName}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Направление" required>
          <Select
            value={direction}
            onChange={(event) => setDirection(event.target.value as 'credit' | 'debit')}
          >
            <option value="credit">Начислить продавцу (+)</option>
            <option value="debit">Удержать с продавца (−)</option>
          </Select>
        </Field>

        <Field
          label="Сумма, сум"
          required
          hint={
            minor === ''
              ? 'Целые сумы. Дробных тийинов в интерфейсе нет намеренно.'
              : `В реестр уйдёт ${signed} тийин`
          }
        >
          <Input
            inputMode="numeric"
            value={major}
            onChange={(event) => setMajor(event.target.value)}
            placeholder="150000"
          />
        </Field>

        <Field label="Категория">
          <Select value={category} onChange={(event) => setCategory(event.target.value)}>
            {CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Причина"
          required
          hint="Минимум 8 символов. Через год это будет единственное объяснение записи в реестре."
        >
          <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>

      {valid && (
        <div className="mt-3">
          <Note tone={direction === 'debit' ? 'warn' : 'neutral'}>
            {direction === 'debit' ? 'Удержание' : 'Начисление'}{' '}
            <strong className="t-money">
              {money({ amount: minor, currency: 'UZS' } as never)}
            </strong>{' '}
            {direction === 'debit' ? 'с ' : 'в пользу '}
            {sellerOptions.find((seller) => seller.id === sellerId)?.displayName}. Запись станет
            активной после согласования вторым сотрудником.
          </Note>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--line)] pb-1.5 last:border-0">
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="t-money shrink-0">{value}</dd>
    </div>
  );
}
