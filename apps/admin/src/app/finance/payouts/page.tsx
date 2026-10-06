'use client';

/**
 * Payouts — spec §8.5, PAY-010 … PAY-013 and ADM-005 (maker/checker).
 *
 * Money leaving the platform is the highest-consequence action in the panel,
 * so this screen is the most deliberate one:
 *
 *  - The amount available comes from the ledger, never from a sum the UI did.
 *  - Creating, submitting, approving and settling are four distinct steps, and
 *    approval must come from someone other than the person who created it
 *    (ADM-005). The API enforces that; the UI says so plainly rather than
 *    letting an operator discover it as a 403.
 *  - Every step carries an idempotency key, so a double click cannot pay
 *    twice, and settling asks for the bank reference that proves it happened.
 */

import { useCallback, useEffect, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { finance, type SellerBalance } from '@/lib/endpoints';
import { dateTime, money, nameOf, number } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  CopyId,
  EmptyState,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Pill,
  Table,
  cx,
} from '@/components/ui';
import { ListBody, ListFooter, useList } from '@/components/data-screen';
import { payoutTone } from '@/lib/status';

type PayoutRow = Record<string, unknown>;

export default function PayoutsPage() {
  const { can, principal, toast } = useApp();
  const [due, setDue] = useState<Array<{ sellerId: string; displayName: string; available: SellerBalance['availableForPayout'] }> | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [settling, setSettling] = useState<PayoutRow | null>(null);
  const [approving, setApproving] = useState<PayoutRow | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useList<PayoutRow>(
    (offset) =>
      finance.payouts({ limit: 50 }).then((page) => ({
        rows: offset === 0 ? page.rows : [],
        total: page.total,
      })),
    [],
    50,
  );

  const loadDue = useCallback(async () => {
    try {
      const data = await finance.payoutsDue();
      setDue(data.items);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      setDue([]);
    }
  }, [toast]);

  useEffect(() => {
    void loadDue();
  }, [loadDue]);

  const createBatch = useCallback(async () => {
    setBusy(true);
    try {
      await finance.createPayout({ sellerIds: [...selected] });
      toast('Пакет выплат создан', 'success');
      setSelected(new Set());
      setCreating(false);
      list.reload();
      void loadDue();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [selected, toast, list, loadDue]);

  const act = useCallback(
    async (action: () => Promise<unknown>, successMessage: string) => {
      setBusy(true);
      try {
        await action();
        toast(successMessage, 'success');
        list.reload();
        void loadDue();
        setApproving(null);
        setSettling(null);
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, list, loadDue],
  );

  const totalSelected = due?.filter((entry) => selected.has(entry.sellerId)) ?? [];

  return (
    <>
      <PageHeader
        title="Выплаты"
        subtitle="Суммы рассчитаны по реестру — не пересчитываются в интерфейсе"
        action={
          can('payout:create') && selected.size > 0 ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Создать пакет ({selected.size})
            </Button>
          ) : undefined
        }
      />

      {/* ── Due ───────────────────────────────────────────────────────── */}
      <Card title="К выплате" className="mb-5" padded={false}>
        {due === null ? (
          <div className="p-4">
            <div className="skeleton h-20 w-full" />
          </div>
        ) : due.length === 0 ? (
          <EmptyState title="Нет сумм к выплате" body="Доступные остатки появятся после оплаченных и доставленных заказов." />
        ) : (
          <Table>
            <thead>
              <tr>
                {can('payout:create') && <th style={{ width: 36 }} />}
                <th>Продавец</th>
                <th className="num">Доступно к выплате</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {due.map((entry) => (
                <tr key={entry.sellerId}>
                  {can('payout:create') && (
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(entry.sellerId)}
                        onChange={(event) => {
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(entry.sellerId);
                            else next.delete(entry.sellerId);
                            return next;
                          });
                        }}
                        aria-label={`Выбрать ${entry.displayName}`}
                      />
                    </td>
                  )}
                  <td className="font-medium">{entry.displayName}</td>
                  <td className="num t-money">{money(entry.available)}</td>
                  <td>
                    <CopyId value={entry.sellerId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ── Batches ───────────────────────────────────────────────────── */}
      <Card title="Пакеты выплат" padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Пакет</th>
              <th>Статус</th>
              <th>Продавец</th>
              <th className="num">Сумма</th>
              <th>Создан</th>
              <th>Создал</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={7} emptyTitle="Пакетов выплат пока нет">
              {(rows) =>
                rows.map((row) => {
                  const id = String(row.id ?? '');
                  const status = String(row.status ?? '');
                  const createdBy = String(row.createdByAdminId ?? row.createdBy ?? '');
                  // ADM-005: the person who created a batch may not approve it.
                  const isOwnBatch = createdBy !== '' && createdBy === principal?.id;
                  return (
                    <tr key={id}>
                      <td>
                        <CopyId value={id} label={String(row.reference ?? id.slice(0, 8))} />
                      </td>
                      <td>
                        <Pill tone={payoutTone(status)}>{status}</Pill>
                      </td>
                      <td>{nameOf(row.seller ?? row.sellerName)}</td>
                      <td className="num t-money">
                        {money((row.amount ?? row.totalAmount) as never)}
                      </td>
                      <td className="whitespace-nowrap text-[var(--fg-muted)]">
                        {dateTime(String(row.createdAt ?? ''))}
                      </td>
                      <td className="text-[var(--fg-muted)]">
                        {createdBy ? <CopyId value={createdBy} /> : '—'}
                      </td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          {can('payout:create') && status === 'DRAFT' && (
                            <Button
                              size="xs"
                              variant="outline"
                              loading={busy}
                              onClick={() => void act(() => finance.submitPayout(id), 'Отправлено на согласование')}
                            >
                              На согласование
                            </Button>
                          )}
                          {can('payout:approve') && (status === 'SUBMITTED' || status === 'PENDING_APPROVAL') && (
                            <Button
                              size="xs"
                              variant="primary"
                              disabled={isOwnBatch}
                              title={
                                isOwnBatch
                                  ? 'Согласовать может только другой сотрудник — вы создали этот пакет'
                                  : undefined
                              }
                              onClick={() => setApproving(row)}
                            >
                              Согласовать
                            </Button>
                          )}
                          {can('payout:approve') && status === 'APPROVED' && (
                            <Button size="xs" variant="primary" onClick={() => setSettling(row)}>
                              Отметить оплаченным
                            </Button>
                          )}
                        </div>
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
        Согласование выплаты требует второго сотрудника: создавший пакет не может его согласовать.
        Это проверяется на сервере — кнопка здесь лишь не тратит ваше время.
      </p>

      {/* ── Create ────────────────────────────────────────────────────── */}
      <ConfirmModal
        open={creating}
        onClose={() => setCreating(false)}
        onConfirm={createBatch}
        busy={busy}
        title="Создать пакет выплат"
        confirmLabel="Создать"
        body={
          <>
            <p>Будет создан пакет для {number(totalSelected.length)} продавц(ов):</p>
            <ul className="mt-2 space-y-1">
              {totalSelected.map((entry) => (
                <li key={entry.sellerId} className="flex justify-between gap-4">
                  <span>{entry.displayName}</span>
                  <span className="t-money">{money(entry.available)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12.5px] text-[var(--fg-muted)]">
              Пакет создаётся черновиком. Деньги не уходят, пока его не согласует второй сотрудник
              и не отметит оплаченным.
            </p>
          </>
        }
      />

      {/* ── Approve (ADM-005) ─────────────────────────────────────────── */}
      {approving && (
        <ConfirmModal
          open
          onClose={() => setApproving(null)}
          onConfirm={() => void act(() => finance.approvePayout(String(approving.id)), 'Пакет согласован')}
          busy={busy}
          danger
          confirmWord="СОГЛАСОВАНО"
          confirmLabel="Согласовать выплату"
          title="Согласование выплаты"
          body={
            <>
              <p>
                Пакет на сумму <strong className="t-money">{money((approving.amount ?? approving.totalAmount) as never)}</strong>.
              </p>
              <p className="mt-2">
                После согласования пакет можно отметить оплаченным, и сумма спишется с баланса
                продавца в реестре. Отменить это нельзя — исправление оформляется корректировкой.
              </p>
            </>
          }
        />
      )}

      {/* ── Settle ────────────────────────────────────────────────────── */}
      {settling && (
        <SettleModal
          payout={settling}
          busy={busy}
          onClose={() => setSettling(null)}
          onConfirm={(reference) =>
            void act(() => finance.settlePayout(String(settling.id), reference), 'Выплата отмечена оплаченной')
          }
        />
      )}
    </>
  );
}

/**
 * PAY-012: settling records the bank reference. Without it the payout cannot
 * be matched against a statement later, which is the whole point of recording
 * it at all — so the field is required.
 */
function SettleModal({
  payout,
  busy,
  onClose,
  onConfirm,
}: {
  payout: PayoutRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reference: string) => void;
}) {
  const [reference, setReference] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="Отметить выплату оплаченной"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            disabled={reference.trim().length < 3}
            loading={busy}
            onClick={() => onConfirm(reference.trim())}
          >
            Отметить оплаченным
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px]">
        Сумма: <strong className="t-money">{money((payout.amount ?? payout.totalAmount) as never)}</strong>
      </p>
      <Field
        label="Банковская ссылка платежа"
        required
        hint="Номер платёжного поручения или референс из выписки — по нему выплата сверяется позже"
      >
        <Input value={reference} onChange={(event) => setReference(event.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
