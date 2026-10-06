'use client';

/**
 * Provider reconciliation — spec §8.6, PAY-011.
 *
 * Every day, what the payment provider says it settled is compared with what
 * the platform recorded. Three things can be wrong, and they are different
 * problems:
 *
 *  - UNMATCHED_INTERNAL — we have a payment the provider does not. Usually a
 *    callback that never arrived, which means a paid order looks unpaid.
 *  - UNMATCHED_PROVIDER — the provider has a settlement we have no payment
 *    for. Money arrived that nothing is attached to.
 *  - AMOUNT_MISMATCH — both sides have it, for different amounts.
 *
 * So the screen does not offer a single "resolve" verb with a tick. Resolving
 * requires writing what the difference was, and separately deciding whether
 * the payment should be released — because "explained" and "the customer's
 * order should now proceed" are not the same statement.
 *
 * §17.1 makes a clean test period part of the definition of done, which is why
 * the fourteen-day strip is the first thing on the page: a single resolved day
 * proves nothing, a fortnight of green does.
 */

import { useCallback, useEffect, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { finance, type ReconciliationDay, type ReconciliationRow } from '@/lib/endpoints';
import { amount, date, dateTime, money, number } from '@/lib/format';
import {
  Button,
  Card,
  CopyId,
  EmptyState,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Pill,
  Stat,
  Switch,
  Table,
  Textarea,
  cx,
  type Tone,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, useList } from '@/components/data-screen';

const PAGE = 50;

const STATUS_META: Record<string, { label: string; tone: Tone; meaning: string }> = {
  MATCHED: {
    label: 'Сошлось',
    tone: 'success',
    meaning: 'Платёж есть у нас и у провайдера, суммы совпадают.',
  },
  UNMATCHED_INTERNAL: {
    label: 'Нет у провайдера',
    tone: 'danger',
    meaning:
      'У нас платёж есть, у провайдера — нет. Чаще всего не дошёл колбэк: оплаченный заказ выглядит неоплаченным.',
  },
  UNMATCHED_PROVIDER: {
    label: 'Нет у нас',
    tone: 'danger',
    meaning: 'Провайдер перевёл деньги, которым у нас не соответствует платёж.',
  },
  AMOUNT_MISMATCH: {
    label: 'Разные суммы',
    tone: 'warn',
    meaning: 'Платёж есть с двух сторон, но суммы не совпадают.',
  },
  RESOLVED: {
    label: 'Разобрано',
    tone: 'neutral',
    meaning: 'Расхождение объяснено человеком.',
  },
};

const STATUS_OPTIONS = Object.entries(STATUS_META).map(([value, meta]) => ({
  value,
  label: meta.label,
}));

export default function ReconciliationPage() {
  const { can, toast } = useApp();
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState<ReconciliationDay[] | null>(null);
  const [resolving, setResolving] = useState<ReconciliationRow | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runDate, setRunDate] = useState(() => new Date().toISOString().slice(0, 10));

  const list = useList<ReconciliationRow>(
    (offset) =>
      finance
        .reconciliation({ status: status || undefined, limit: PAGE, offset })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [status],
    PAGE,
  );

  const loadSummary = useCallback(async () => {
    try {
      const data = await finance.reconciliationSummary();
      setSummary(data.items);
    } catch {
      setSummary([]);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const result = await finance.runReconciliation({ date: runDate || undefined });
      const totals = result.summaries.reduce(
        (acc, item) => ({
          matched: acc.matched + item.matched,
          problems:
            acc.problems + item.unmatchedInternal + item.unmatchedProvider + item.amountMismatch,
        }),
        { matched: 0, problems: 0 },
      );
      toast(
        totals.problems === 0
          ? `Сверка за ${runDate}: всё сошлось (${totals.matched})`
          : `Сверка за ${runDate}: расхождений — ${totals.problems}`,
        totals.problems === 0 ? 'success' : 'error',
      );
      setRunning(false);
      list.reload();
      void loadSummary();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [runDate, toast, list, loadSummary]);

  const resolve = useCallback(
    async (body: { resolution: string; releasePayment?: boolean }) => {
      if (!resolving) return;
      setBusy(true);
      try {
        await finance.resolveReconciliation(resolving.id, body);
        toast('Расхождение разобрано', 'success');
        setResolving(null);
        list.reload();
        void loadSummary();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [resolving, toast, list, loadSummary],
  );

  const open = summary?.reduce(
    (sum, day) => sum + day.unmatchedInternal + day.unmatchedProvider + day.amountMismatch,
    0,
  );

  return (
    <>
      <PageHeader
        title="Сверка с провайдерами"
        subtitle={
          open === undefined
            ? undefined
            : open === 0
              ? 'За последние 14 дней расхождений нет'
              : `За последние 14 дней расхождений: ${number(open)}`
        }
        action={
          <>
            <FilterSelect
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
              allLabel="Только нерешённые"
            />
            {can('reconciliation:resolve') && (
              <Button variant="primary" onClick={() => setRunning(true)}>
                Запустить сверку
              </Button>
            )}
          </>
        }
      />

      {/* §17.1: a fortnight of clean days is the acceptance bar. */}
      <Card className="mb-5" title="Последние 14 дней">
        {summary === null ? (
          <div className="skeleton h-16 w-full" />
        ) : summary.length === 0 ? (
          <p className="text-[13px] text-[var(--fg-muted)]">
            Сверка ещё не запускалась. Пока нет ни одного сверенного дня, расхождения не видны —
            не потому, что их нет.
          </p>
        ) : (
          <>
            <div className="flex gap-1 overflow-x-auto no-scrollbar">
              {summary.map((day) => {
                const problems = day.unmatchedInternal + day.unmatchedProvider + day.amountMismatch;
                return (
                  <div
                    key={day.date}
                    title={`${day.date}: сошлось ${day.matched}, расхождений ${problems}, разобрано ${day.resolved}`}
                    className="min-w-[54px] flex-1 text-center"
                  >
                    <div
                      className={cx(
                        'mb-1 h-10 rounded-[var(--radius-sm)]',
                        problems === 0 ? 'bg-success' : problems > 3 ? 'bg-danger' : 'bg-warn',
                      )}
                      style={{ opacity: day.matched === 0 && problems === 0 ? 0.25 : 1 }}
                    />
                    <span className="t-num block text-[10.5px] text-[var(--fg-faint)]">
                      {day.date.slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat
                label="Сошлось"
                value={number(summary.reduce((sum, day) => sum + day.matched, 0))}
              />
              <Stat
                label="Нет у провайдера"
                value={number(summary.reduce((sum, day) => sum + day.unmatchedInternal, 0))}
                tone={summary.some((day) => day.unmatchedInternal > 0) ? 'danger' : undefined}
              />
              <Stat
                label="Нет у нас"
                value={number(summary.reduce((sum, day) => sum + day.unmatchedProvider, 0))}
                tone={summary.some((day) => day.unmatchedProvider > 0) ? 'danger' : undefined}
              />
              <Stat
                label="Разные суммы"
                value={number(summary.reduce((sum, day) => sum + day.amountMismatch, 0))}
                tone={summary.some((day) => day.amountMismatch > 0) ? 'warn' : undefined}
              />
            </div>
          </>
        )}
      </Card>

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th>День</th>
              <th>Провайдер</th>
              <th>Что не так</th>
              <th>Заказ</th>
              <th className="num">У нас</th>
              <th className="num">У провайдера</th>
              <th className="num">Разница</th>
              <th>Референс</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={9} emptyTitle="Нерешённых расхождений нет">
              {(rows) =>
                rows.map((row) => {
                  const meta = STATUS_META[row.status];
                  const delta = row.delta ? BigInt(row.delta.amount) : null;
                  return (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap t-num">{row.periodDate}</td>
                      <td className="text-[12.5px] uppercase text-[var(--fg-muted)]">{row.provider}</td>
                      <td>
                        <Pill tone={meta?.tone ?? 'neutral'} title={meta?.meaning}>
                          {meta?.label ?? row.status}
                        </Pill>
                      </td>
                      <td className="t-mono whitespace-nowrap text-[12px]">
                        {row.orderNumber ?? <span className="text-[var(--fg-faint)]">—</span>}
                        {row.paymentStatus && (
                          <span className="ml-1.5 text-[11px] text-[var(--fg-faint)]">
                            {row.paymentStatus}
                          </span>
                        )}
                      </td>
                      <td className="num t-money">{row.internalAmount ? money(row.internalAmount) : '—'}</td>
                      <td className="num t-money">{row.providerAmount ? money(row.providerAmount) : '—'}</td>
                      <td
                        className={cx(
                          'num t-money',
                          delta === null ? '' : delta < 0n ? 'text-danger' : delta > 0n ? 'text-warn' : '',
                        )}
                      >
                        {row.delta
                          ? `${delta !== null && delta > 0n ? '+' : ''}${amount(row.delta)}`
                          : '—'}
                      </td>
                      <td>
                        {row.providerReference ? (
                          <CopyId value={row.providerReference} label={row.providerReference.slice(0, 12)} />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="text-right">
                        {can('reconciliation:resolve') && row.status !== 'RESOLVED' && (
                          <Button size="xs" variant="outline" onClick={() => setResolving(row)}>
                            Разобрать
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })
              }
            </ListBody>
          </tbody>
        </Table>
        <ListFooter state={list} />
      </Card>

      <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
        «Разобрано» не значит «исправлено»: это запись о том, чем объясняется разница. Деньги
        двигаются отдельно — корректировкой в реестре, которую согласует второй сотрудник.
      </p>

      {/* Run */}
      <Modal
        open={running}
        onClose={() => setRunning(false)}
        title="Запустить сверку"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRunning(false)}>
              Отмена
            </Button>
            <Button variant="primary" loading={busy} disabled={!runDate} onClick={() => void run()}>
              Запустить
            </Button>
          </>
        }
      >
        <Field label="День" hint="Сверяется один день по всем провайдерам, у которых были платежи">
          <Input type="date" value={runDate} onChange={(event) => setRunDate(event.target.value)} />
        </Field>
        <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--fg-muted)]">
          Запуск безопасен и идемпотентен: повторная сверка того же дня перезапишет его результат, а
          не создаст вторую копию.
        </p>
      </Modal>

      {resolving && (
        <ResolveModal record={resolving} busy={busy} onClose={() => setResolving(null)} onConfirm={resolve} />
      )}
    </>
  );
}

function ResolveModal({
  record,
  busy,
  onClose,
  onConfirm,
}: {
  record: ReconciliationRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: { resolution: string; releasePayment?: boolean }) => void;
}) {
  const [resolution, setResolution] = useState('');
  const [release, setRelease] = useState(false);
  const meta = STATUS_META[record.status];

  // Releasing only makes sense where we hold a payment the provider did not
  // confirm — the case where a lost callback left a paid order looking unpaid.
  const canRelease = record.status === 'UNMATCHED_INTERNAL' || record.status === 'AMOUNT_MISMATCH';

  return (
    <Modal
      open
      onClose={onClose}
      width={580}
      title="Разобрать расхождение"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={resolution.trim().length < 8}
            onClick={() => onConfirm({ resolution: resolution.trim(), releasePayment: release })}
          >
            Записать
          </Button>
        </>
      }
    >
      <div className="rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3.5 py-3">
        <div className="mb-1.5 flex items-center gap-2">
          <Pill tone={meta?.tone ?? 'neutral'}>{meta?.label ?? record.status}</Pill>
          <span className="text-[12px] uppercase text-[var(--fg-muted)]">{record.provider}</span>
          <span className="t-num ml-auto text-[12px] text-[var(--fg-muted)]">{record.periodDate}</span>
        </div>
        <p className="text-[12.5px] leading-relaxed text-[var(--fg-muted)]">{meta?.meaning}</p>
      </div>

      <dl className="mt-3.5 grid grid-cols-3 gap-x-4 gap-y-2 text-[13px]">
        <div>
          <dt className="t-label">У нас</dt>
          <dd className="t-money mt-0.5">{record.internalAmount ? money(record.internalAmount) : '—'}</dd>
        </div>
        <div>
          <dt className="t-label">У провайдера</dt>
          <dd className="t-money mt-0.5">{record.providerAmount ? money(record.providerAmount) : '—'}</dd>
        </div>
        <div>
          <dt className="t-label">Разница</dt>
          <dd className="t-money mt-0.5">{record.delta ? amount(record.delta) : '—'}</dd>
        </div>
      </dl>

      {record.orderNumber && (
        <p className="mt-2.5 text-[12.5px] text-[var(--fg-muted)]">
          Заказ <span className="t-mono">{record.orderNumber}</span>
          {record.paymentStatus ? ` · платёж ${record.paymentStatus}` : ''}
        </p>
      )}

      <div className="mt-4">
        <Field
          label="Чем объясняется разница"
          required
          hint="Минимум 8 символов. Из записи должно быть понятно, повторится ли это и что нужно починить."
        >
          <Textarea
            rows={4}
            value={resolution}
            onChange={(event) => setResolution(event.target.value)}
            autoFocus
          />
        </Field>
      </div>

      {canRelease && (
        <div className="mt-4">
          <Switch
            checked={release}
            onChange={setRelease}
            label="Признать платёж успешным"
            hint="Заказ продолжит путь как оплаченный. Включайте, только если деньги действительно получены — проверьте выписку, а не колбэк."
          />
        </div>
      )}

      {release && (
        <div className="mt-3">
          <Note tone="warn">
            Это запустит заказ в работу: продавцы увидят его к подтверждению, а в реестре появятся
            записи о продаже и комиссии. Отменить можно только возвратом.
          </Note>
        </div>
      )}
    </Modal>
  );
}
