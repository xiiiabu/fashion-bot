'use client';

/**
 * Pending approvals — spec §10.7, ADM-005 (maker/checker).
 *
 * Every action that moves money or changes a rule parks here until a second
 * operator signs it off. The important property of this screen is the one it
 * refuses to let you have: the person who created a request cannot approve it,
 * and the API decides that, not the UI. A row the viewer may not approve is
 * shown anyway — knowing that something is waiting on a colleague is useful —
 * but its button is disabled and says why.
 *
 * The payload is shown in full. An approval given without reading what is
 * being approved is just a second signature on someone else's decision.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Permission } from '@fashion/core';
import { errorMessage, useApp } from '@/lib/app-context';
import { finance, governance, type ApprovalRow } from '@/lib/endpoints';
import { dateTime, money, relativeTime } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  CopyId,
  EmptyState,
  ErrorState,
  Note,
  PageHeader,
  Pill,
  Table,
} from '@/components/ui';

/**
 * What each parked action does, in words, and which endpoint approves it.
 * An action with no entry is still listed — it just gets no approve button,
 * because approving something this screen does not understand is worse than
 * sending the operator to the screen that owns it.
 */
const ACTIONS: Record<
  string,
  {
    label: string;
    detail: string;
    /** The permission the API guards the approval with. */
    permission: Permission;
    approve?: (objectId: string, note?: string) => Promise<unknown>;
  }
> = {
  'adjustment.create': {
    label: 'Корректировка реестра',
    detail: 'Запись в реестр, меняющая баланс продавца вне обычного хода заказов.',
    permission: 'adjustment:approve',
    approve: (objectId, note) => finance.approveAdjustment(objectId, note),
  },
  'refund.create': {
    label: 'Возврат деньгами',
    detail: 'Возврат покупателю; одновременно реверсирует комиссию платформы.',
    permission: 'adjustment:approve',
    approve: (objectId, note) => finance.approveRefund(objectId, note),
  },
  'payout.submit': {
    label: 'Пакет выплат',
    detail: 'Перевод денег продавцам. Согласование — последний шаг перед банком.',
    permission: 'payout:approve',
    approve: (objectId, note) => finance.approvePayout(objectId, note),
  },
};

export default function ApprovalsPage() {
  const { toast, principal, can } = useApp();
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ApprovalRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await governance.approvals();
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = useCallback(async () => {
    if (!confirming) return;
    const handler = ACTIONS[confirming.action]?.approve;
    if (!handler) return;
    setBusy(true);
    try {
      await handler(confirming.objectId);
      toast('Согласовано', 'success');
      setConfirming(null);
      await load();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [confirming, toast, load]);

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <>
      <PageHeader
        title="Согласования"
        subtitle={
          rows === null
            ? 'Загрузка…'
            : rows.length === 0
              ? 'Ничего не ждёт второй подписи'
              : `${rows.length} ждут второй подписи`
        }
        action={
          <Button variant="outline" onClick={load}>
            Обновить
          </Button>
        }
      />

      <div className="mb-4">
        <Note tone="neutral" title="Как это работает">
          Действие, меняющее деньги или правило, сохраняется и ждёт второго сотрудника. Создавший
          запрос не может его согласовать — это проверяется на сервере, а не кнопкой здесь.
        </Note>
      </div>

      {rows === null ? (
        <div className="skeleton h-[160px] rounded-[var(--radius-lg)]" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Очередь пуста"
            body="Здесь появятся корректировки реестра, возвраты и пакеты выплат, ожидающие согласования."
          />
        </Card>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <th>Действие</th>
                <th>Объект</th>
                <th>Запросил</th>
                <th>Создано</th>
                <th>Истекает</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const meta = ACTIONS[row.action];
                const own = !row.canApprove;
                const isMine = row.makerEmail !== null && row.makerEmail === principal?.email;
                return (
                  <tr key={row.id}>
                    <td className="max-w-[260px]">
                      <span className="block font-medium">{meta?.label ?? row.action}</span>
                      <span className="block text-[11.5px] leading-snug text-[var(--fg-faint)]">
                        {meta?.detail ?? row.action}
                      </span>
                      {row.payload !== null && row.payload !== undefined && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-[11.5px] text-[var(--accent-deep)]">
                            Что именно согласуется
                          </summary>
                          <pre className="t-mono mt-1 max-w-[320px] overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--bg-sunken)] p-2 text-[11px] leading-relaxed">
                            {JSON.stringify(row.payload, null, 2)}
                          </pre>
                        </details>
                      )}
                    </td>
                    <td>
                      <span className="block text-[12px] text-[var(--fg-muted)]">{row.objectType}</span>
                      <CopyId value={row.objectId} />
                    </td>
                    <td className="text-[12.5px]">
                      {row.makerEmail ?? '—'}
                      {isMine && (
                        <Pill className="ml-1.5" tone="neutral">
                          вы
                        </Pill>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-[var(--fg-muted)]" title={row.createdAt}>
                      {relativeTime(row.createdAt)}
                    </td>
                    <td className="whitespace-nowrap text-[var(--fg-muted)]">
                      {row.expiresAt ? dateTime(row.expiresAt) : '—'}
                    </td>
                    <td className="text-right">
                      {meta?.approve && can(meta.permission) ? (
                        <Button
                          size="xs"
                          variant="primary"
                          disabled={own}
                          title={
                            own
                              ? 'Согласовать может только другой сотрудник — запрос создали вы'
                              : undefined
                          }
                          onClick={() => setConfirming(row)}
                        >
                          Согласовать
                        </Button>
                      ) : meta?.approve ? (
                        <span className="text-[11.5px] text-[var(--fg-faint)]">
                          нужны права {meta.permission}
                        </span>
                      ) : (
                        <span className="text-[11.5px] text-[var(--fg-faint)]">
                          согласуется на своём экране
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {confirming && (
        <ConfirmModal
          open
          onClose={() => setConfirming(null)}
          onConfirm={approve}
          busy={busy}
          danger
          confirmWord="СОГЛАСОВАНО"
          title={ACTIONS[confirming.action]?.label ?? confirming.action}
          confirmLabel="Согласовать"
          body={
            <>
              <p>{ACTIONS[confirming.action]?.detail}</p>
              <p className="mt-2 text-[12.5px] text-[var(--fg-muted)]">
                Запросил: {confirming.makerEmail ?? '—'} · {dateTime(confirming.createdAt)}
              </p>
              {confirming.payload !== null && confirming.payload !== undefined && (
                <pre className="t-mono mt-3 max-h-[220px] overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-sunken)] p-2.5 text-[11.5px] leading-relaxed">
                  {JSON.stringify(confirming.payload, null, 2)}
                </pre>
              )}
              <p className="mt-3">
                После согласования действие выполняется сразу и отменить его нельзя — исправление
                оформляется отдельной записью.
              </p>
            </>
          }
        />
      )}
    </>
  );
}
