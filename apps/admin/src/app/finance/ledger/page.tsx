'use client';

/**
 * The ledger — spec §8.3, PAY-008.
 *
 * This screen is the money's source of truth made visible. Three things it is
 * careful about:
 *
 *  - Entries are append-only and shown in sequence order. There is no edit
 *    affordance anywhere on this page, because there is no edit: a correction
 *    is a new entry (an adjustment), which is a different screen.
 *  - The sign is never dropped. A reversal that renders as a positive number
 *    is how a reconciliation goes wrong quietly.
 *  - "Проверить" recomputes every cached balance from the entries and reports
 *    the drift. A zero is the daily proof that the cache has not diverged;
 *    anything else is an incident.
 */

import { useCallback, useMemo, useState } from 'react';
import { LEDGER_EVENTS } from '@fashion/core';
import { errorMessage, useApp } from '@/lib/app-context';
import { finance, type LedgerRow, type LedgerVerification } from '@/lib/endpoints';
import { amount, dateTime, fromMinor, number, signedAmount } from '@/lib/format';
import {
  Button,
  Card,
  CopyId,
  Modal,
  Note,
  PageHeader,
  Pill,
  Table,
  cx,
  type Tone,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, SearchBox, useList } from '@/components/data-screen';

const PAGE = 50;

/**
 * Clean means three things at once: nothing had drifted, nothing needed
 * correcting, and the commission the orders claim matches what the ledger
 * holds. Reporting only the first would call a real divergence a pass.
 */
function isClean(result: LedgerVerification): boolean {
  return (
    result.balances.drifts.length === 0 &&
    result.balances.corrected === 0 &&
    result.orders.ok &&
    result.orders.deltaMinor === '0'
  );
}

/**
 * The colour says what the entry does to the platform, not whether it is good
 * news: revenue in, money out, a reversal of either.
 */
function eventTone(event: string): Tone {
  if (event.includes('REVERSAL') || event.includes('REFUND')) return 'warn';
  if (event.includes('COMMISSION')) return 'accent';
  if (event.includes('PAYOUT')) return 'info';
  if (event.includes('ADJUSTMENT') || event.includes('CHARGEBACK')) return 'danger';
  return 'neutral';
}

export default function LedgerPage() {
  const { toast, can } = useApp();
  const [event, setEvent] = useState('');
  const [query, setQuery] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<LedgerVerification | null>(null);

  const list = useList<LedgerRow>(
    (offset) =>
      finance
        .ledger({ event: event || undefined, orderId: query || undefined, limit: PAGE, offset })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [event, query],
    PAGE,
  );

  const eventOptions = useMemo(
    () => LEDGER_EVENTS.map((value) => ({ value, label: value })),
    [],
  );

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      const result = await finance.verifyLedger();
      setVerification(result);
      if (isClean(result)) {
        toast('Баланс сходится: расхождений нет', 'success');
      } else {
        toast(
          `Расхождение: счетов исправлено ${result.balances.corrected}, по комиссии ${result.orders.deltaMinor}`,
          'error',
        );
      }
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setVerifying(false);
    }
  }, [toast]);

  const exportCsv = useCallback(async () => {
    try {
      const response = await finance.exportLedger();
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ledger-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  }, [toast]);

  return (
    <>
      <PageHeader
        title="Реестр операций"
        subtitle={`${number(list.total)} записей · только добавление, без изменений`}
        action={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="ID заказа" />
            <FilterSelect value={event} onChange={setEvent} options={eventOptions} allLabel="Все события" />
            {can('export:financial') && (
              <Button variant="outline" onClick={exportCsv}>
                Экспорт CSV
              </Button>
            )}
            {can('ledger:read') && (
              <Button variant="primary" loading={verifying} onClick={verify}>
                Проверить баланс
              </Button>
            )}
          </>
        }
      />

      {verification && (
        <div className="mb-4">
          <Note
            tone={isClean(verification) ? 'success' : 'danger'}
            title={isClean(verification) ? 'Баланс сходится' : 'Найдено расхождение'}
            action={
              <Button size="xs" variant="ghost" onClick={() => setVerification(null)}>
                Скрыть
              </Button>
            }
          >
            <p>
              Счетов проверено: {number(verification.balances.checked)}, исправлено:{' '}
              {number(verification.balances.corrected)}.
            </p>
            <p className="mt-1">
              Комиссия по заказам{' '}
              <span className="t-money">{amount(fromMinor(verification.orders.orderCommissionMinor))}</span>{' '}
              против реестра{' '}
              <span className="t-money">{amount(fromMinor(verification.orders.ledgerCommissionMinor))}</span>
              {verification.orders.deltaMinor === '0' ? (
                ' — сходится.'
              ) : (
                <>
                  {' '}
                  — расхождение{' '}
                  <strong className="t-money">{amount(fromMinor(verification.orders.deltaMinor))}</strong>.
                </>
              )}
            </p>
            {verification.balances.drifts.length > 0 && (
              <ul className="mt-2 space-y-1">
                {verification.balances.drifts.slice(0, 8).map((drift) => (
                  <li key={drift.accountId} className="t-mono text-[11.5px]">
                    {drift.accountId.slice(0, 8)}: кэш {drift.cached} ≠ реестр {drift.computed}
                  </li>
                ))}
              </ul>
            )}
            {!isClean(verification) && (
              <p className="mt-2">
                Кэш балансов исправлен по записям реестра — реестр остаётся источником истины.
                Расхождение по комиссии так не исправляется: его нужно разобрать.
              </p>
            )}
          </Note>
        </div>
      )}

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Событие</th>
              <th className="num">Сумма</th>
              <th>Продавец</th>
              <th>Заказ</th>
              <th>Примечание</th>
              <th>Создано</th>
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={7} emptyTitle="Записей нет">
              {(rows) =>
                rows.map((row) => {
                  const signed = BigInt(row.signedAmountMinor || '0');
                  return (
                    <tr key={row.id}>
                      <td className="num t-num text-[var(--fg-faint)]">{row.sequence}</td>
                      <td>
                        <Pill tone={eventTone(row.event)}>{row.event}</Pill>
                      </td>
                      <td
                        className={cx(
                          'num t-money',
                          signed < 0n ? 'text-danger' : signed > 0n ? 'text-success' : '',
                        )}
                      >
                        {signedAmount(row.signedAmountMinor, row.currency)}
                      </td>
                      <td>{row.sellerId ? <CopyId value={row.sellerId} /> : '—'}</td>
                      <td>{row.orderId ? <CopyId value={row.orderId} /> : '—'}</td>
                      <td className="max-w-[260px] truncate text-[var(--fg-muted)]" title={row.memo ?? ''}>
                        {row.memo ?? '—'}
                      </td>
                      <td className="whitespace-nowrap text-[var(--fg-muted)]">{dateTime(row.createdAt)}</td>
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
        Записи реестра неизменяемы: база отклоняет UPDATE и DELETE на этой таблице. Исправление
        оформляется новой корректировкой, которая требует второго согласующего.
      </p>
    </>
  );
}
