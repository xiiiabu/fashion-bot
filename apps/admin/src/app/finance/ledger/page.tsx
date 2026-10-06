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
import { finance, type LedgerRow } from '@/lib/endpoints';
import { dateTime, fromMinor, money, number, signedAmount } from '@/lib/format';
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
  const [verification, setVerification] = useState<Awaited<
    ReturnType<typeof finance.verifyLedger>
  > | null>(null);

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
      if (result.drift === '0' && result.corrected === 0) {
        toast('Баланс сходится: расхождений нет', 'success');
      } else {
        toast(`Расхождение: ${result.drift}, исправлено счетов: ${result.corrected}`, 'error');
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
            tone={verification.drift === '0' && verification.corrected === 0 ? 'success' : 'danger'}
            title={
              verification.drift === '0' && verification.corrected === 0
                ? 'Баланс сходится'
                : 'Найдено расхождение'
            }
            action={
              <Button size="xs" variant="ghost" onClick={() => setVerification(null)}>
                Скрыть
              </Button>
            }
          >
            Проверено счетов: {number(verification.checked)}. Исправлено: {number(verification.corrected)}.
            Расхождение: {verification.drift}.
            {verification.issues.length > 0 && (
              <ul className="mt-2 space-y-1">
                {verification.issues.slice(0, 8).map((issue) => (
                  <li key={issue.accountId} className="t-mono">
                    {issue.accountId.slice(0, 8)}: кэш {issue.cached} ≠ реестр {issue.derived}
                  </li>
                ))}
              </ul>
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
