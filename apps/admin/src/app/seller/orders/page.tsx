'use client';

/**
 * Seller orders — spec §11.3, SEL-003 and SEL-004.
 *
 * This is the screen a seller lives in, and the only number on it that
 * matters is the confirmation deadline. A suborder that is not confirmed in
 * time breaks the delivery window the buyer was shown, so the overdue ones are
 * pulled to the top and say how late they are rather than sorting quietly by
 * date.
 *
 * Rejection is deliberately harder than confirmation and asks for a reason,
 * because it is the action that costs the buyer their order. It can also be
 * partial: a seller who has three of four items should cancel one line, not
 * the parcel.
 *
 * Fulfilment steps come from the state machine, so the buttons offered are the
 * transitions the API will actually accept.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { allowedTransitions } from '@fashion/core';
import { errorMessage, useApp } from '@/lib/app-context';
import { seller, type SellerAdvanceTarget, type SellerOrderRow } from '@/lib/endpoints';
import { API_BASE } from '@/lib/api';
import { dateTime, mediaUrl, money, number, relativeTime } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  CopyId,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  Note,
  PageHeader,
  Pill,
  Select,
  Table,
  Tabs,
  Textarea,
  cx,
} from '@/components/ui';
import { subOrderTone } from '@/lib/status';

/** SEL-004: what each step means to the person doing it. */
const STEP_LABELS: Record<SellerAdvanceTarget, string> = {
  PICKING: 'Начать сборку',
  READY_FOR_HANDOVER: 'Готово к передаче',
  HANDED_OVER: 'Передал курьеру',
  IN_TRANSIT: 'В пути',
  DELIVERED: 'Доставлено',
  COMPLETED: 'Завершить',
};

const ADVANCE_TARGETS = new Set<string>(Object.keys(STEP_LABELS));

/** SEL-003: the reasons that exist, so the quality score can mean something. */
const REJECT_REASONS = [
  { value: 'OUT_OF_STOCK', label: 'Нет в наличии' },
  { value: 'PRICE_ERROR', label: 'Ошибка в цене' },
  { value: 'DAMAGED', label: 'Товар повреждён' },
  { value: 'CANNOT_FULFILL_IN_TIME', label: 'Не успеваю в срок' },
  { value: 'SUSPECTED_FRAUD', label: 'Подозрительный заказ' },
  { value: 'OTHER', label: 'Другое' },
];

type Pane = 'todo' | 'active' | 'all';

const PANE_FILTER: Record<Pane, (row: SellerOrderRow) => boolean> = {
  todo: (row) => row.status === 'PENDING_CONFIRMATION',
  active: (row) =>
    !['COMPLETED', 'CANCELLED', 'REJECTED', 'RETURNED'].includes(row.status),
  all: () => true,
};

export default function SellerOrdersPage() {
  const { can, toast } = useApp();
  const [pane, setPane] = useState<Pane>('todo');
  const [rows, setRows] = useState<SellerOrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await seller.orders({ limit: 100 });
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (action: () => Promise<unknown>, successMessage: string, close = false) => {
      setBusy(true);
      try {
        await action();
        toast(successMessage, 'success');
        if (close) setOpenId(null);
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, load],
  );

  /** Overdue first, then by deadline: the order a seller should work in. */
  const visible = useMemo(() => {
    if (!rows) return null;
    return rows
      .filter(PANE_FILTER[pane])
      .slice()
      .sort((a, b) => {
        if (a.slaBreached !== b.slaBreached) return a.slaBreached ? -1 : 1;
        const aDue = a.confirmDueAt ? new Date(a.confirmDueAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bDue = b.confirmDueAt ? new Date(b.confirmDueAt).getTime() : Number.MAX_SAFE_INTEGER;
        if (aDue !== bDue) return aDue - bDue;
        return new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime();
      });
  }, [rows, pane]);

  const open = useMemo(
    () => (openId ? (rows?.find((row) => row.id === openId) ?? null) : null),
    [openId, rows],
  );

  const counts = useMemo(
    () => ({
      todo: rows?.filter(PANE_FILTER.todo).length,
      active: rows?.filter(PANE_FILTER.active).length,
      all: rows?.length,
    }),
    [rows],
  );

  const breached = rows?.filter((row) => row.slaBreached && row.status === 'PENDING_CONFIRMATION') ?? [];

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <>
      <PageHeader
        title="Заказы"
        subtitle={counts.todo ? `${number(counts.todo)} ждут подтверждения` : 'Всё подтверждено'}
        action={
          <Button variant="outline" onClick={load}>
            Обновить
          </Button>
        }
      />

      {breached.length > 0 && (
        <div className="mb-4">
          <Note tone="danger" title={`Просрочено подтверждений: ${breached.length}`}>
            Срок подтверждения вышел. Покупателю обещан срок доставки, который считается от этого
            момента, и каждая просрочка снижает оценку качества магазина. Подтвердите или откажитесь
            — отказ честнее молчания.
          </Note>
        </div>
      )}

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'todo', label: 'К подтверждению', count: counts.todo },
          { value: 'active', label: 'В работе', count: counts.active },
          { value: 'all', label: 'Все', count: counts.all },
        ]}
      />

      {visible === null ? (
        <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title={pane === 'todo' ? 'Нет заказов к подтверждению' : 'Заказов нет'}
            body={
              pane === 'todo'
                ? 'Новые заказы появятся здесь и в Telegram-боте. Подтверждайте до срока — он виден в каждой строке.'
                : undefined
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Статус</th>
                <th className="num">Позиций</th>
                <th className="num">К получению</th>
                <th>Доставка</th>
                <th>Подтвердить до</th>
                <th>Оформлен</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setOpenId(row.id)}
                  className={cx(
                    'cursor-pointer hover:bg-[var(--bg-sunken)]',
                    row.slaBreached && row.status === 'PENDING_CONFIRMATION' && 'bg-danger-soft',
                  )}
                >
                  <td className="t-mono whitespace-nowrap">{row.orderNumber}</td>
                  <td>
                    <Pill tone={subOrderTone(row.status)}>{row.status}</Pill>
                  </td>
                  <td className="num t-num">{number(row.itemCount)}</td>
                  <td className="num t-money">{money(row.payableTotal)}</td>
                  <td className="max-w-[160px] truncate text-[12.5px] text-[var(--fg-muted)]">
                    {row.deliveryName ?? '—'}
                  </td>
                  <td className="whitespace-nowrap">
                    {row.confirmDueAt ? (
                      <span className={row.slaBreached ? 'font-semibold text-danger' : undefined}>
                        {row.slaBreached ? 'просрочено ' : ''}
                        {relativeTime(row.confirmDueAt)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="whitespace-nowrap text-[var(--fg-muted)]">{relativeTime(row.placedAt)}</td>
                  <td className="text-right text-[var(--fg-faint)]">→</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {open && (
        <OrderDetail
          order={open}
          busy={busy}
          canWrite={can('order:write')}
          onClose={() => setOpenId(null)}
          onAct={act}
        />
      )}
    </>
  );
}

/* ── Detail ──────────────────────────────────────────────────────────────── */

function OrderDetail({
  order,
  busy,
  canWrite,
  onClose,
  onAct,
}: {
  order: SellerOrderRow;
  busy: boolean;
  canWrite: boolean;
  onClose: () => void;
  onAct: (action: () => Promise<unknown>, successMessage: string, close?: boolean) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Only the steps the machine allows from here, and only those a seller owns.
  const steps = (allowedTransitions('suborder', order.status) as string[]).filter((value) =>
    ADVANCE_TARGETS.has(value),
  ) as SellerAdvanceTarget[];

  return (
    <Modal
      open
      onClose={onClose}
      width={660}
      title={
        <span className="flex items-center gap-2.5">
          <span className="t-mono">{order.orderNumber}</span>
          <Pill tone={subOrderTone(order.status)}>{order.status}</Pill>
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
          {canWrite && order.status === 'PENDING_CONFIRMATION' && (
            <>
              <Button variant="outline" onClick={() => setRejecting(true)}>
                Отказаться
              </Button>
              <Button variant="primary" loading={busy} onClick={() => setConfirming(true)}>
                Подтвердить
              </Button>
            </>
          )}
          {canWrite &&
            order.status !== 'PENDING_CONFIRMATION' &&
            steps.map((step) => (
              <Button
                key={step}
                variant={step === 'HANDED_OVER' ? 'primary' : 'outline'}
                loading={busy}
                onClick={() => onAct(() => seller.advanceOrder(order.id, step), STEP_LABELS[step])}
              >
                {STEP_LABELS[step]}
              </Button>
            ))}
        </>
      }
    >
      {order.slaBreached && order.status === 'PENDING_CONFIRMATION' && (
        <div className="mb-3.5">
          <Note tone="danger" title="Срок подтверждения вышел">
            Подтвердить всё ещё можно, и это лучше, чем отмена: покупатель получит обновлённый срок.
            Просрочка уже учтена в оценке качества.
          </Note>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
        <Row label="Оформлен" value={dateTime(order.placedAt)} />
        <Row
          label="Подтвердить до"
          value={order.confirmDueAt ? dateTime(order.confirmDueAt) : '—'}
        />
        <Row label="Доставка" value={order.deliveryName ?? '—'} />
        <Row label="Подзаказ" value={<CopyId value={order.id} />} />
      </dl>

      <h3 className="t-eyebrow mb-2.5 mt-5">Позиции</h3>
      <ul className="space-y-2.5">
        {order.items.map((item) => {
          const image = mediaUrl(item.imageUrl, API_BASE);
          return (
            <li key={item.id} className="flex items-start gap-3 border-b border-[var(--line)] pb-2.5 last:border-0">
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--bg-sunken)]">
                {image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium">{item.title}</p>
                <p className="text-[11.5px] text-[var(--fg-faint)]">
                  {item.sizeLabel}
                  {item.colorName ? ` · ${item.colorName}` : ''} · {item.quantity} шт
                </p>
              </div>
              <span className="t-money shrink-0 text-[13px]">{money(item.unitPrice)}</span>
            </li>
          );
        })}
      </ul>

      <Card className="mt-5" title="Деньги">
        <dl className="space-y-2 text-[13px]">
          <MoneyRow label="Стоимость товаров" value={money(order.goodsTotal)} />
          <MoneyRow label="Комиссия платформы" value={`−${money(order.commissionTotal)}`} />
          <div className="border-t border-[var(--line)] pt-2">
            <MoneyRow
              label="К получению"
              value={<strong className="t-money">{money(order.payableTotal)}</strong>}
            />
          </div>
        </dl>
        <p className="mt-2.5 text-[12px] leading-relaxed text-[var(--fg-faint)]">
          Комиссия 10% считается от стоимости товаров; доставка в базу не входит. Сумма попадёт на
          баланс после доставки и закрытия окна возврата.
        </p>
      </Card>

      {order.shipment && (
        <Card className="mt-4" title="Отправление">
          <pre className="t-mono overflow-x-auto text-[11.5px] leading-relaxed">
            {JSON.stringify(order.shipment, null, 2)}
          </pre>
        </Card>
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onAct(() => seller.confirmOrder(order.id), 'Заказ подтверждён');
        }}
        busy={busy}
        title="Подтвердить заказ"
        confirmLabel="Подтвердить"
        body={
          <>
            <p>
              Вы подтверждаете, что все {number(order.itemCount)} позиций есть в наличии и будут
              собраны в срок.
            </p>
            <p className="mt-2 text-[12.5px] text-[var(--fg-muted)]">
              Покупатель получит уведомление и обещанный срок доставки. Если чего-то нет — лучше
              отказаться от одной позиции сейчас, чем отменить заказ позже.
            </p>
          </>
        }
      />

      {rejecting && (
        <RejectModal
          order={order}
          busy={busy}
          onClose={() => setRejecting(false)}
          onConfirm={(body) => {
            setRejecting(false);
            onAct(() => seller.rejectOrder(order.id, body), 'Отказ отправлен', true);
          }}
        />
      )}
    </Modal>
  );
}

/* ── Rejection (SEL-003) ────────────────────────────────────────────────── */

function RejectModal({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: SellerOrderRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: { reason: string; itemIds?: string[] }) => void;
}) {
  const [reason, setReason] = useState(REJECT_REASONS[0].value);
  const [detail, setDetail] = useState('');
  const [partial, setPartial] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const label = REJECT_REASONS.find((option) => option.value === reason)?.label ?? reason;
  const combined = detail.trim() ? `${label}: ${detail.trim()}` : label;
  // The API wants at least 4 characters, and "Другое" without detail says nothing.
  const valid =
    combined.length >= 4 &&
    (reason !== 'OTHER' || detail.trim().length >= 4) &&
    (!partial || selected.size > 0) &&
    (!partial || selected.size < order.items.length);

  return (
    <Modal
      open
      onClose={onClose}
      width={580}
      title="Отказаться от заказа"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!valid}
            onClick={() =>
              onConfirm({
                reason: combined,
                itemIds: partial ? [...selected] : undefined,
              })
            }
          >
            {partial ? `Отказаться от ${selected.size} поз.` : 'Отказаться полностью'}
          </Button>
        </>
      }
    >
      <Note tone="warn">
        Отказ отменяет позиции и возвращает покупателю деньги за них. Он учитывается в оценке
        качества магазина — это не наказание, а сигнал: по нему видно, где остатки расходятся с
        реальностью.
      </Note>

      <div className="mt-4 grid gap-3.5">
        <Field label="Причина" required>
          <Select value={reason} onChange={(event) => setReason(event.target.value)}>
            {REJECT_REASONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Подробнее"
          required={reason === 'OTHER'}
          hint="Увидит поддержка и покупатель. Чем конкретнее, тем меньше обращений."
        >
          <Textarea rows={2} value={detail} onChange={(event) => setDetail(event.target.value)} />
        </Field>
      </div>

      {order.items.length > 1 && (
        <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--line)] p-3.5">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-[3px]"
              checked={partial}
              onChange={(event) => setPartial(event.target.checked)}
            />
            <span>
              <span className="block text-[13.5px]">Отказаться только от части позиций</span>
              <span className="block text-[11.5px] text-[var(--fg-muted)]">
                Остальное останется в заказе и поедет покупателю
              </span>
            </span>
          </label>

          {partial && (
            <ul className="mt-3 space-y-1.5">
              {order.items.map((item) => (
                <li key={item.id}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--bg-sunken)]">
                    <input
                      type="checkbox"
                      className="mt-[3px]"
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]">{item.title}</span>
                      <span className="block text-[11.5px] text-[var(--fg-faint)]">
                        {item.sizeLabel} · {item.quantity} шт · {money(item.unitPrice)}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {partial && selected.size === order.items.length && (
            <div className="mt-2.5">
              <Note tone="warn">
                Выбраны все позиции — это полный отказ. Снимите галочку «только часть», чтобы не
                путать себя и поддержку.
              </Note>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="t-label">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}

function MoneyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="t-money shrink-0">{value}</dd>
    </div>
  );
}
