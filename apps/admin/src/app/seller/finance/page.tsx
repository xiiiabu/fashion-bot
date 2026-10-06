'use client';

/**
 * Seller finance — spec §11.5, PAY-008, PAY-013.
 *
 * The question this screen answers is "why is my balance that number", and it
 * answers it the only honest way: from the ledger, line by line, in sequence.
 * A seller cabinet that shows a total without the entries behind it produces a
 * support ticket every payout cycle.
 *
 * The distinction the layout insists on is between the payable balance and
 * what is actually available: the return reserve and any hold sit between
 * them. A seller who sees only the first number plans around money they cannot
 * have yet.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LEDGER_EVENTS } from '@fashion/core';
import { errorMessage, useApp } from '@/lib/app-context';
import { seller, type LedgerRow, type SellerBalance } from '@/lib/endpoints';
import { amount, date, dateTime, money, number, signedAmount } from '@/lib/format';
import {
  Button,
  Card,
  CopyId,
  ErrorState,
  Field,
  Input,
  Note,
  PageHeader,
  Pill,
  Stat,
  Table,
  Tabs,
  cx,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, useList } from '@/components/data-screen';
import { sellerEventLabel, sellerEventTone, sellerMemo } from '@/lib/ledger-labels';
import { payoutLabel, payoutTone } from '@/lib/status';

const PAGE = 50;

type Pane = 'balance' | 'ledger' | 'payouts';

export default function SellerFinancePage() {
  const [pane, setPane] = useState<Pane>('balance');

  return (
    <>
      <PageHeader title="Баланс и выплаты" subtitle="Всё выведено из реестра операций" />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'balance', label: 'Баланс' },
          { value: 'ledger', label: 'Операции' },
          { value: 'payouts', label: 'Выплаты' },
        ]}
      />

      {pane === 'balance' && <Balance />}
      {pane === 'ledger' && <Ledger />}
      {pane === 'payouts' && <Payouts />}
    </>
  );
}

/* ── Balance ─────────────────────────────────────────────────────────────── */

function Balance() {
  const { can, toast } = useApp();
  const [data, setData] = useState<SellerBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await seller.balance());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = useCallback(async () => {
    try {
      const response = await seller.financeExport({ from: from || undefined, to: to || undefined });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `finance-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  }, [from, to, toast]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="skeleton h-[86px] rounded-[var(--radius-lg)]" />
        ))}
      </div>
    );
  }

  const withheld = BigInt(data.reserve.amount) + BigInt(data.hold.amount);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Баланс" value={money(data.payableBalance)} hint="всё начисленное минус выплаченное" />
        <Stat
          label="Доступно к выплате"
          value={money(data.availableForPayout)}
          hint="попадёт в следующий пакет выплат"
        />
        <Stat
          label="Удержано"
          value={amount({ amount: withheld.toString(), currency: data.currency } as never)}
          hint="резерв под возвраты и удержания"
          tone={withheld > 0n ? 'warn' : undefined}
        />
      </div>

      {withheld > 0n && (
        <div className="mt-4">
          <Note tone="neutral" title="Почему доступно меньше, чем баланс">
            Резерв под возвраты держится до закрытия окна возврата по заказу — 14 дней с доставки.
            Это не удержание в вашу сторону: как только окно закрывается, сумма переходит в
            доступную без вашего участия.
          </Note>
        </div>
      )}

      <Card className="mt-5" title="Из чего сложился баланс">
        <dl className="space-y-2 text-[13px]">
          <Row label="Продажи" value={money(data.salesGross)} />
          <Row label="Комиссия платформы" value={`−${amount(data.commission)}`} />
          <Row label="Скидки за ваш счёт" value={`−${amount(data.discountsSellerFunded)}`} />
          <Row label="Возвраты покупателям" value={`−${amount(data.refunds)}`} />
          <Row label="Возврат комиссии по возвратам" value={`+${amount(data.commissionReversals)}`} />
          <Row label="Корректировки" value={amount(data.adjustments)} />
          <Row label="Уже выплачено" value={`−${amount(data.paidOut)}`} />
          <div className="border-t border-[var(--line)] pt-2">
            <Row label="Баланс" value={<strong className="t-money">{money(data.payableBalance)}</strong>} />
          </div>
          <Row label="Резерв под возвраты" value={`−${amount(data.reserve)}`} />
          {data.hold.amount !== '0' && <Row label="Удержано платформой" value={`−${amount(data.hold)}`} />}
          <div className="border-t border-[var(--line)] pt-2">
            <Row
              label="Доступно к выплате"
              value={<strong className="t-money">{money(data.availableForPayout)}</strong>}
            />
          </div>
        </dl>
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
          Комиссия 10% считается от стоимости товаров после вашей скидки; доставка в базу не входит,
          эквайринг платит платформа. Каждая строка выше — сумма записей реестра, которые можно
          посмотреть по отдельности на вкладке «Операции».
        </p>
      </Card>

      {can('export:financial') && (
        <Card className="mt-5" title="Выгрузка для бухгалтерии">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="С" className="w-[170px]">
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field label="По" className="w-[170px]">
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
            <Button variant="outline" onClick={exportCsv}>
              Скачать CSV
            </Button>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
            В выгрузке — те же записи реестра, что на вкладке «Операции», с номерами заказов. Суммы
            в тийинах целыми числами: так они не теряются при открытии в Excel.
          </p>
        </Card>
      )}
    </>
  );
}

/* ── Ledger (PAY-008) ───────────────────────────────────────────────────── */

function Ledger() {
  const [event, setEvent] = useState('');

  const list = useList<LedgerRow>(
    (offset) =>
      seller
        .ledger({ event: event || undefined, limit: PAGE, offset })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [event],
    PAGE,
  );

  const eventOptions = useMemo(
    () => LEDGER_EVENTS.map((value) => ({ value, label: sellerEventLabel(value) })),
    [],
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-[var(--fg-muted)]">{number(list.total)} записей</p>
        <FilterSelect value={event} onChange={setEvent} options={eventOptions} allLabel="Все операции" />
      </div>

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Операция</th>
              <th className="num">Сумма</th>
              <th>Заказ</th>
              <th>Документ</th>
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={5} emptyTitle="Операций нет">
              {(rows) =>
                rows.map((row) => {
                  const signed = BigInt(row.signedAmountMinor || '0');
                  return (
                    <tr key={row.id}>
                      <td className="num t-num text-[var(--fg-faint)]">{row.sequence}</td>
                      <td>
                        <Pill tone={sellerEventTone(row.event)}>{sellerEventLabel(row.event)}</Pill>
                      </td>
                      <td
                        className={cx(
                          'num t-money',
                          signed < 0n ? 'text-danger' : signed > 0n ? 'text-success' : '',
                        )}
                      >
                        {signedAmount(row.signedAmountMinor, row.currency)}
                      </td>
                      <td>{row.orderId ? <CopyId value={row.orderId} /> : '—'}</td>
                      <td className="max-w-[280px] truncate text-[var(--fg-muted)]" title={row.memo ?? ''}>
                        {sellerMemo(row.memo) ?? '—'}
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
        Записи нумерованы и не меняются. Если что-то посчитано неверно, появится новая запись —
        корректировка — а не правка старой: так всегда видно, что произошло и когда.
      </p>
    </>
  );
}

/* ── Payouts (PAY-013) ──────────────────────────────────────────────────── */

function Payouts() {
  const list = useList<Record<string, unknown>>(
    (offset) =>
      seller.payouts({ limit: PAGE }).then((page) => ({
        rows: offset === 0 ? page.rows : [],
        total: page.total,
      })),
    [],
    PAGE,
  );

  return (
    <>
      <div className="mb-4">
        <Note tone="neutral" title="Как идут выплаты">
          Платформа формирует пакет выплат по расписанию из вашего договора. Пакет проходит
          согласование двумя сотрудниками, затем уходит в банк — поэтому между «согласован» и
          «оплачен» проходит время. Банковская ссылка платежа появляется здесь после отправки.
        </Note>
      </div>

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Пакет</th>
              <th>Статус</th>
              <th className="num">Сумма</th>
              <th>Период</th>
              <th>Банковская ссылка</th>
              <th>Оплачен</th>
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={6} emptyTitle="Выплат пока не было">
              {(rows) =>
                rows.map((row) => {
                  const status = String(row.status ?? '');
                  const amountValue = (row.amount ?? row.totalAmount) as
                    | { amount: string; currency: string }
                    | undefined;
                  return (
                    <tr key={String(row.id)}>
                      <td>
                        <CopyId
                          value={String(row.id ?? '')}
                          label={String(row.reference ?? String(row.id ?? '').slice(0, 8))}
                        />
                      </td>
                      <td>
                        <Pill tone={payoutTone(status)}>{payoutLabel(status)}</Pill>
                      </td>
                      <td className="num t-money">{amountValue ? money(amountValue as never) : '—'}</td>
                      <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                        {row.periodFrom ? date(String(row.periodFrom)) : '—'}
                        {row.periodTo ? ` → ${date(String(row.periodTo))}` : ''}
                      </td>
                      <td className="t-mono text-[12px] text-[var(--fg-muted)]">
                        {row.bankReference ? String(row.bankReference) : '—'}
                      </td>
                      <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                        {row.settledAt ? dateTime(String(row.settledAt)) : '—'}
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
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="t-money shrink-0">{value}</dd>
    </div>
  );
}
