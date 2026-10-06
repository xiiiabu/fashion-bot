'use client';

/**
 * Order operations — spec §10.3 and ADM-001.
 *
 * The list is the master order; the detail is where the per-seller suborders
 * live, because that is the level operations actually acts on. An admin can
 * advance a suborder the seller has not (ADM-001) — the one place the panel
 * moves someone else's state, so it says who it is acting for and writes a
 * reason into the audit trail.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ORDER_STATUSES, translate } from '@fashion/core';
import { errorMessage, useApp } from '@/lib/app-context';
import { orders, type AdminOrderRow } from '@/lib/endpoints';
import { dateTime, fromMinor, money, number } from '@/lib/format';
import {
  Button,
  Card,
  CopyId,
  Modal,
  PageHeader,
  Pill,
  Select,
  Table,
  Textarea,
  cx,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, SearchBox, useList } from '@/components/data-screen';
import { orderTone, subOrderTone } from '@/lib/status';
import { OPS_LOCALE } from '@/lib/format';

const PAGE = 50;

export default function OrdersPage() {
  return (
    <Suspense fallback={<PageHeader title="Заказы" />}>
      <OrdersScreen />
    </Suspense>
  );
}

function OrdersScreen() {
  const params = useSearchParams();
  const { can } = useApp();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [query, setQuery] = useState('');
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);

  const list = useList<AdminOrderRow>(
    (offset) =>
      orders
        .list({ status: status || undefined, q: query || undefined, limit: PAGE, offset })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [status, query],
    PAGE,
  );

  const statusOptions = useMemo(
    () => ORDER_STATUSES.map((value) => ({ value, label: translate(OPS_LOCALE, `order.status.${value}`) })),
    [],
  );

  return (
    <>
      <PageHeader
        title="Заказы"
        subtitle={`${number(list.total)} всего`}
        action={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="Номер заказа" />
            <FilterSelect value={status} onChange={setStatus} options={statusOptions} allLabel="Все статусы" />
          </>
        }
      />

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Заказ</th>
              <th>Статус</th>
              <th className="num">Товары</th>
              <th className="num">Доставка</th>
              <th className="num">Итого</th>
              <th className="num">Комиссия</th>
              <th className="num">Возвращено</th>
              <th>Оформлен</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={9} emptyTitle="Заказов не найдено">
              {(rows) =>
                rows.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <button
                        type="button"
                        onClick={() => setOpenOrderId(order.id)}
                        className="t-num font-medium hover:text-[var(--accent)]"
                      >
                        {order.number}
                      </button>
                    </td>
                    <td>
                      <Pill tone={orderTone(order.status)}>
                        {translate(OPS_LOCALE, `order.status.${order.status}`)}
                      </Pill>
                    </td>
                    <td className="num t-money">{money(fromMinor(order.goodsTotalMinor, order.currency))}</td>
                    <td className="num t-money">{money(fromMinor(order.deliveryTotalMinor, order.currency))}</td>
                    <td className="num t-money font-semibold">
                      {money(fromMinor(order.grandTotalMinor, order.currency))}
                    </td>
                    <td className="num t-money">{money(fromMinor(order.commissionTotalMinor, order.currency))}</td>
                    <td className={cx('num t-money', order.refundedTotalMinor !== '0' && 'text-warn')}>
                      {order.refundedTotalMinor === '0'
                        ? '—'
                        : money(fromMinor(order.refundedTotalMinor, order.currency))}
                    </td>
                    <td className="whitespace-nowrap text-[var(--fg-muted)]">
                      {dateTime(order.placedAt ?? order.createdAt)}
                    </td>
                    <td>
                      <CopyId value={order.id} />
                    </td>
                  </tr>
                ))
              }
            </ListBody>
          </tbody>
        </Table>
        <ListFooter state={list} />
      </Card>

      {openOrderId && (
        <OrderDetail
          orderId={openOrderId}
          canAdvance={can('order:write')}
          onClose={() => setOpenOrderId(null)}
          onChanged={list.reload}
        />
      )}
    </>
  );
}

/* ── Detail ──────────────────────────────────────────────────────────────── */

interface SubOrderShape {
  id: string;
  number?: string;
  status: string;
  sellerName?: string;
  seller?: { displayName?: string };
  items?: Array<{ id: string; title?: string; quantity?: number; sizeLabel?: string }>;
  goodsTotal?: { amount: string; currency: string };
  goodsTotalMinor?: string;
}

function OrderDetail({
  orderId,
  canAdvance,
  onClose,
  onChanged,
}: {
  orderId: string;
  canAdvance: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useApp();
  const [order, setOrder] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState<SubOrderShape | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrder(await orders.get(orderId));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [orderId]);

  // useEffect, not useMemo: a memo is for deriving a value, and React is free
  // to re-run or discard one. Loading data from it works until it does not.
  useEffect(() => {
    void load();
  }, [load]);

  const subOrders = (order?.subOrders ?? order?.suborders ?? []) as SubOrderShape[];
  const status = typeof order?.status === 'string' ? order.status : '';
  const currency = typeof order?.currency === 'string' ? order.currency : 'UZS';

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="t-num">{String(order?.number ?? '…')}</span>
          {status && <Pill tone={orderTone(status)}>{translate(OPS_LOCALE, `order.status.${status}`)}</Pill>}
        </span>
      }
      width={760}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      {error && <p className="text-[13px] text-danger">{error}</p>}
      {!order && !error && <div className="skeleton h-40 w-full" />}

      {order && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-4">
            <Detail label="Товары" value={money(fromMinor(String(order.goodsTotalMinor ?? '0'), currency))} />
            <Detail label="Доставка" value={money(fromMinor(String(order.deliveryTotalMinor ?? '0'), currency))} />
            <Detail label="Итого" value={money(fromMinor(String(order.grandTotalMinor ?? '0'), currency))} />
            <Detail label="Комиссия" value={money(fromMinor(String(order.commissionTotalMinor ?? '0'), currency))} />
          </dl>

          <div>
            <h3 className="t-eyebrow mb-2">Посылки по продавцам</h3>
            <div className="space-y-2">
              {subOrders.length === 0 && (
                <p className="text-[13px] text-[var(--fg-muted)]">Нет посылок.</p>
              )}
              {subOrders.map((subOrder) => (
                <div
                  key={subOrder.id}
                  className="rounded-[var(--radius-md)] border border-[var(--line)] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium">
                        {subOrder.sellerName ?? subOrder.seller?.displayName ?? '—'}
                      </p>
                      <p className="t-num text-[11.5px] text-[var(--fg-faint)]">{subOrder.number}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Pill tone={subOrderTone(subOrder.status)}>
                        {translate(OPS_LOCALE, `suborder.status.${subOrder.status}`)}
                      </Pill>
                      {canAdvance && (
                        <Button size="xs" variant="outline" onClick={() => setAdvancing(subOrder)}>
                          Изменить статус
                        </Button>
                      )}
                    </div>
                  </div>
                  {subOrder.items && subOrder.items.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-[12.5px] text-[var(--fg-muted)]">
                      {subOrder.items.map((item) => (
                        <li key={item.id} className="truncate">
                          {item.title}
                          {item.sizeLabel ? ` · ${item.sizeLabel}` : ''}
                          {item.quantity && item.quantity > 1 ? ` × ${item.quantity}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {advancing && (
        <AdvanceSubOrder
          subOrder={advancing}
          onClose={() => setAdvancing(null)}
          onDone={() => {
            setAdvancing(null);
            void load();
            onChanged();
            toast('Статус посылки обновлён', 'success');
          }}
        />
      )}
    </Modal>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="t-label">{label}</dt>
      <dd className="t-money">{value}</dd>
    </div>
  );
}

/**
 * ADM-001. The status list is deliberately not filtered down to "the next
 * legal one": the API's state machine is the authority and returns the allowed
 * transitions on a 409, which is shown rather than guessed at here.
 */
const SUBORDER_TARGETS = [
  'CONFIRMED',
  'PICKING',
  'READY_FOR_HANDOVER',
  'HANDED_OVER',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
];

function AdvanceSubOrder({
  subOrder,
  onClose,
  onDone,
}: {
  subOrder: SubOrderShape;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useApp();
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState<string[] | null>(null);

  const submit = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    setAllowed(null);
    try {
      await orders.advanceSubOrder(subOrder.id, status, note.trim() || undefined);
      onDone();
    } catch (caught) {
      // A rejected transition comes back with the ones that would be accepted,
      // so the operator is told what they can do instead of guessing.
      const transitions = (caught as { allowedTransitions?: string[] })?.allowedTransitions;
      if (transitions?.length) setAllowed(transitions);
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [status, note, subOrder.id, onDone, toast]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Изменить статус посылки"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" disabled={!status} loading={busy} onClick={submit}>
            Применить
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-[var(--fg-muted)]">
        Текущий статус:{' '}
        <Pill tone={subOrderTone(subOrder.status)}>
          {translate(OPS_LOCALE, `suborder.status.${subOrder.status}`)}
        </Pill>
      </p>

      <div className="space-y-3">
        <label className="block">
          <span className="t-label mb-1 block">Новый статус</span>
          <Select value={status} onChange={(event) => setStatus(event.target.value)} className="w-full">
            <option value="">Выберите…</option>
            {SUBORDER_TARGETS.map((value) => (
              <option key={value} value={value}>
                {translate(OPS_LOCALE, `suborder.status.${value}`)}
              </option>
            ))}
          </Select>
        </label>

        <label className="block">
          <span className="t-label mb-1 block">Комментарий для истории</span>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
        </label>
      </div>

      {allowed && (
        <p className="mt-3 rounded-[var(--radius-sm)] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          Допустимые переходы отсюда:{' '}
          {allowed.map((value) => translate(OPS_LOCALE, `suborder.status.${value}`)).join(', ')}
        </p>
      )}
    </Modal>
  );
}
