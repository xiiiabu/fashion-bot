'use client';

/**
 * Alerts — spec §16 (observability) and §10.7.
 *
 * Two distinct acts, kept distinct: acknowledging says "I have seen this", and
 * resolving says "this is what was done about it". An alert queue where the
 * only button is "dismiss" becomes a queue nobody reads, because nothing
 * records whether the last fifty were real.
 *
 * Resolving therefore requires the sentence. The API enforces a minimum
 * length; the field says what the sentence is for.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { governance, type AlertRow } from '@/lib/endpoints';
import { dateTime, relativeTime } from '@/lib/format';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Pill,
  Table,
  Tabs,
  Textarea,
} from '@/components/ui';
import { severityTone } from '@/lib/status';

/** The alert kinds the platform raises, in words an operator can act on. */
const KINDS: Record<string, string> = {
  LEDGER_DRIFT: 'Расхождение реестра и кэша баланса',
  PAYMENT_FAILURE_RATE: 'Повышенная доля неуспешных платежей',
  WEBHOOK_FAILURE: 'Ошибки вебхука платёжного провайдера',
  RECONCILIATION_MISMATCH: 'Сверка с выпиской не сошлась',
  SLA_BREACH: 'Нарушение SLA подтверждения заказов',
  STOCK_STALE: 'Остатки не обновлялись слишком долго',
  RETURN_RATE: 'Доля возвратов выше порога',
  AI_FALLBACK: 'Стилист ушёл в детерминированный режим',
  NOTIFICATION_BACKLOG: 'Очередь уведомлений не разбирается',
};

function kindLabel(kind: string): string {
  return KINDS[kind] ?? kind;
}

type Pane = 'open' | 'all';

export default function AlertsPage() {
  const { can, toast } = useApp();
  const [pane, setPane] = useState<Pane>('open');
  const [rows, setRows] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<AlertRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await governance.alerts();
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!rows) return null;
    return pane === 'open' ? rows.filter((row) => !row.resolvedAt) : rows;
  }, [rows, pane]);

  const openCount = rows?.filter((row) => !row.resolvedAt).length ?? 0;

  const acknowledge = useCallback(
    async (row: AlertRow) => {
      setBusy(true);
      try {
        await governance.acknowledgeAlert(row.id);
        toast('Отмечено как увиденное', 'success');
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, load],
  );

  const resolve = useCallback(
    async (resolution: string) => {
      if (!resolving) return;
      setBusy(true);
      try {
        await governance.resolveAlert(resolving.id, resolution);
        toast('Алерт закрыт', 'success');
        setResolving(null);
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [resolving, toast, load],
  );

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <>
      <PageHeader
        title="Алерты"
        subtitle={rows === null ? 'Загрузка…' : openCount === 0 ? 'Открытых нет' : `${openCount} открытых`}
        action={
          <Button variant="outline" onClick={load}>
            Обновить
          </Button>
        }
      />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'open', label: 'Открытые', count: openCount },
          { value: 'all', label: 'Все', count: rows?.length },
        ]}
      />

      {visible === null ? (
        <div className="skeleton h-[160px] rounded-[var(--radius-lg)]" />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title={pane === 'open' ? 'Открытых алертов нет' : 'Алертов не было'}
            body="Сюда попадают расхождения реестра, сбои платежей и нарушения SLA — всё, что требует человека."
          />
        </Card>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <th style={{ width: 96 }}>Важность</th>
                <th>Событие</th>
                <th>Возникло</th>
                <th>Состояние</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Pill tone={severityTone(row.severity)}>{row.severity}</Pill>
                  </td>
                  <td className="max-w-[420px]">
                    <span className="block font-medium">{kindLabel(row.kind)}</span>
                    <span className="block text-[12px] leading-snug text-[var(--fg-muted)]">
                      {row.message}
                    </span>
                    {row.resolution && (
                      <span className="mt-1 block text-[11.5px] leading-snug text-[var(--fg-faint)]">
                        Решение: {row.resolution}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-[var(--fg-muted)]" title={row.createdAt}>
                    {relativeTime(row.createdAt)}
                  </td>
                  <td className="whitespace-nowrap">
                    {row.resolvedAt ? (
                      <Pill tone="success">закрыт {dateTime(row.resolvedAt)}</Pill>
                    ) : row.acknowledgedAt ? (
                      <Pill tone="info">в работе</Pill>
                    ) : (
                      <Pill tone="warn">новый</Pill>
                    )}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {can('config:write') && !row.acknowledgedAt && !row.resolvedAt && (
                        <Button
                          size="xs"
                          variant="outline"
                          loading={busy}
                          onClick={() => void acknowledge(row)}
                        >
                          Взял в работу
                        </Button>
                      )}
                      {can('config:write') && !row.resolvedAt && (
                        <Button size="xs" variant="primary" onClick={() => setResolving(row)}>
                          Закрыть
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {resolving && <ResolveModal alert={resolving} busy={busy} onClose={() => setResolving(null)} onConfirm={resolve} />}
    </>
  );
}

function ResolveModal({
  alert,
  busy,
  onClose,
  onConfirm,
}: {
  alert: AlertRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: (resolution: string) => void;
}) {
  const [resolution, setResolution] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="Закрыть алерт"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={resolution.trim().length < 2}
            onClick={() => onConfirm(resolution.trim())}
          >
            Закрыть алерт
          </Button>
        </>
      }
    >
      <p className="mb-1 text-[13.5px] font-medium">{kindLabel(alert.kind)}</p>
      <p className="mb-3 text-[13px] leading-relaxed text-[var(--fg-muted)]">{alert.message}</p>

      {alert.context !== null && alert.context !== undefined && (
        <details className="mb-3">
          <summary className="cursor-pointer text-[12px] text-[var(--accent-deep)]">Данные события</summary>
          <pre className="t-mono mt-1.5 max-h-[180px] overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-sunken)] p-2.5 text-[11.5px] leading-relaxed">
            {JSON.stringify(alert.context, null, 2)}
          </pre>
        </details>
      )}

      <Field
        label="Что было сделано"
        required
        hint="Эта запись — единственное, что останется от инцидента. Из неё должно быть понятно, повторится он или нет."
      >
        <Textarea rows={3} value={resolution} onChange={(event) => setResolution(event.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
