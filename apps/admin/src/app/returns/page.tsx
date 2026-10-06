'use client';

/**
 * Returns — spec §9, RET-001 … RET-009.
 *
 * A return moves through four decisions, and this screen keeps them four:
 * approve or decline the request, record that the parcel arrived, record what
 * the inspection found, and release the refund. Collapsing them into one
 * button is how a refund gets paid for goods nobody looked at.
 *
 * The inspection is per unit, matching the API, because a two-item return
 * routinely splits: one piece comes back unworn, the other smells of perfume.
 * A single verdict for the parcel would force the operator to pick the wrong
 * one and write the truth in a note nobody reads.
 *
 * The statistics panel carries RET-009: the share of returns caused by size.
 * That number is what the fit engine and the size charts are judged by, so it
 * sits here rather than in analytics — the person processing returns sees it
 * move first.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { returns, type ReturnRow } from '@/lib/endpoints';
import { dateTime, money, number, percent } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  Field,
  Modal,
  Note,
  PageHeader,
  Pill,
  Stat,
  Table,
  Tabs,
  Textarea,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, useList } from '@/components/data-screen';
import {
  InspectionModal,
  outcomeLabel,
  outcomeTone,
  reasonLabel,
} from '@/components/return-inspection';
import { RETURN_STATUS_OPTIONS, returnLabel, returnTone } from '@/lib/status';

const PAGE = 25;

type Pane = 'queue' | 'stats';

export default function ReturnsPage() {
  const { can, toast } = useApp();
  const [pane, setPane] = useState<Pane>('queue');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useList<ReturnRow>(
    (offset) =>
      returns
        .list({ status: status || undefined, limit: PAGE })
        .then((page) => ({ rows: offset === 0 ? page.rows : [], total: page.total })),
    [status],
    PAGE,
  );

  // The row is read back from the list on every reload, so the detail reflects
  // the status the last action produced rather than the one it opened with.
  const open = useMemo(
    () => (openId ? (list.rows.find((row) => row.id === openId) ?? null) : null),
    [openId, list.rows],
  );

  const act = useCallback(
    async (action: () => Promise<unknown>, successMessage: string, close = false) => {
      setBusy(true);
      try {
        await action();
        toast(successMessage, 'success');
        if (close) setOpenId(null);
        list.reload();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, list],
  );

  return (
    <>
      <PageHeader
        title="Возвраты"
        subtitle={`${number(list.total)} заявок`}
        action={
          pane === 'queue' ? (
            <FilterSelect
              value={status}
              onChange={setStatus}
              options={RETURN_STATUS_OPTIONS}
              allLabel="Все статусы"
            />
          ) : undefined
        }
      />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'queue', label: 'Очередь' },
          { value: 'stats', label: 'Статистика' },
        ]}
      />

      {pane === 'stats' ? (
        <ReturnStats />
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <th>Заявка</th>
                <th>Заказ</th>
                <th>Статус</th>
                <th>Причина</th>
                <th className="num">К возврату</th>
                <th className="num">Док.</th>
                <th>Создана</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <ListBody state={list} columns={8} emptyTitle="Заявок на возврат нет">
                {(rows) =>
                  rows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => setOpenId(row.id)}
                      className="cursor-pointer hover:bg-[var(--bg-sunken)]"
                    >
                      <td className="t-mono whitespace-nowrap">{row.number}</td>
                      <td className="t-mono whitespace-nowrap text-[var(--fg-muted)]">{row.orderNumber}</td>
                      <td>
                        <Pill tone={returnTone(row.status)}>{returnLabel(row.status)}</Pill>
                      </td>
                      <td>{reasonLabel(row.reason)}</td>
                      <td className="num t-money">{money(row.refundTotal)}</td>
                      <td className="num t-num text-[var(--fg-muted)]">{row.evidenceCount || '—'}</td>
                      <td className="whitespace-nowrap text-[var(--fg-muted)]">{dateTime(row.createdAt)}</td>
                      <td className="text-right text-[var(--fg-faint)]">→</td>
                    </tr>
                  ))
                }
              </ListBody>
            </tbody>
          </Table>
          <ListFooter state={list} />
        </Card>
      )}

      {open && (
        <ReturnDetail
          entry={open}
          busy={busy}
          canDecide={can('return:approve')}
          canWrite={can('return:write')}
          canInspect={can('return:inspect')}
          onClose={() => setOpenId(null)}
          onAct={act}
        />
      )}
    </>
  );
}

/* ── Statistics (RET-009) ────────────────────────────────────────────────── */

function ReturnStats() {
  const [data, setData] = useState<Awaited<ReturnType<typeof returns.stats>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    returns
      .stats()
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Note tone="danger">{error}</Note>;
  if (!data) return <div className="skeleton h-[120px] rounded-[var(--radius-lg)]" />;

  const sizeShare = data.total > 0 ? (data.bySizeReason / data.total) * 100 : 0;
  const sellerFaultShare = data.reasons
    .filter((item) => item.sellerFault)
    .reduce((sum, item) => sum + item.share, 0);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Возвратов всего" value={number(data.total)} />
        <Stat
          label="Из-за размера"
          value={number(data.bySizeReason)}
          hint={`${percent(sizeShare)} от всех возвратов`}
          tone={sizeShare > 35 ? 'danger' : sizeShare > 20 ? 'warn' : undefined}
        />
        <Stat
          label="По вине продавца"
          value={percent(sellerFaultShare)}
          tone={sellerFaultShare > 15 ? 'warn' : undefined}
        />
      </div>

      {sizeShare > 20 && (
        <div className="mt-4">
          <Note tone="warn" title="Размерные возвраты выше цели">
            Цель — не более 20% возвратов по причине размера (RET-009). Проверьте размерные сетки и
            замеры товаров у продавцов с наибольшей долей: подсказка размера не может быть точнее
            данных, на которых она построена.
          </Note>
        </div>
      )}

      <Card className="mt-5" title="Причины возврата" padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Причина</th>
              <th className="num">Количество</th>
              <th className="num">Доля</th>
              <th>Ответственность</th>
            </tr>
          </thead>
          <tbody>
            {data.reasons.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-[13px] text-[var(--fg-muted)]">
                  Возвратов ещё не было
                </td>
              </tr>
            ) : (
              data.reasons.map((item) => (
                <tr key={item.reason}>
                  <td>{reasonLabel(item.reason)}</td>
                  <td className="num t-num">{number(item.count)}</td>
                  <td className="num t-num">{percent(item.share)}</td>
                  <td>
                    <Pill tone={item.sellerFault ? 'danger' : 'neutral'}>
                      {item.sellerFault ? 'Продавец' : 'Покупатель'}
                    </Pill>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

/* ── Detail ──────────────────────────────────────────────────────────────── */

/** The platform's view of one return: read everything, act where allowed. */
function ReturnDetail({
  entry,
  busy,
  canDecide,
  canWrite,
  canInspect,
  onClose,
  onAct,
}: {
  entry: ReturnRow;
  busy: boolean;
  canDecide: boolean;
  canWrite: boolean;
  canInspect: boolean;
  onClose: () => void;
  onAct: (action: () => Promise<unknown>, successMessage: string, close?: boolean) => void;
}) {
  const [note, setNote] = useState('');
  const [declining, setDeclining] = useState(false);
  const [inspecting, setInspecting] = useState(false);

  const status = entry.status;

  return (
    <Modal
      open
      onClose={onClose}
      width={660}
      title={
        <span className="flex items-center gap-2.5">
          <span className="t-mono">{entry.number}</span>
          <Pill tone={returnTone(status)}>{returnLabel(status)}</Pill>
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
          {canDecide && status === 'REQUESTED' && (
            <>
              <Button variant="outline" onClick={() => setDeclining(true)}>
                Отклонить
              </Button>
              <Button
                variant="primary"
                loading={busy}
                onClick={() => onAct(() => returns.decide(entry.id, true, note || undefined), 'Возврат одобрен')}
              >
                Одобрить
              </Button>
            </>
          )}
          {canWrite && (status === 'APPROVED' || status === 'HANDED_OVER') && (
            <Button
              variant="primary"
              loading={busy}
              onClick={() => onAct(() => returns.received(entry.id), 'Посылка отмечена полученной')}
            >
              Посылка получена
            </Button>
          )}
          {canInspect && status === 'RECEIVED' && (
            <Button variant="primary" onClick={() => setInspecting(true)}>
              Осмотр
            </Button>
          )}
          {canWrite && status === 'INSPECTED' && (
            <Button
              variant="primary"
              loading={busy}
              onClick={() => onAct(() => returns.refundPending(entry.id), 'Возврат передан в оплату', true)}
            >
              Отправить возврат деньгами
            </Button>
          )}
        </>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
        <Row label="Заказ" value={<span className="t-mono">{entry.orderNumber}</span>} />
        <Row label="Создана" value={dateTime(entry.createdAt)} />
        <Row label="Причина" value={reasonLabel(entry.reason)} />
        <Row label="К возврату" value={<span className="t-money">{money(entry.refundTotal)}</span>} />
      </dl>

      {entry.comment && (
        <div className="mt-3">
          <span className="t-label mb-1 block">Комментарий покупателя</span>
          <p className="rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3 py-2 text-[13px] leading-relaxed">
            {entry.comment}
          </p>
        </div>
      )}

      <h3 className="t-eyebrow mb-2 mt-5">Позиции</h3>
      <ul className="space-y-2.5">
        {entry.items.map((item) => (
          <li
            key={item.id}
            className="flex items-start justify-between gap-3 border-b border-[var(--line)] pb-2.5 text-[13px] last:border-0 last:pb-0"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{item.title}</span>
              <span className="text-[11.5px] text-[var(--fg-faint)]">
                {item.brandName ? `${item.brandName} · ` : ''}
                {item.sizeLabel} · {item.quantity} шт · {reasonLabel(item.reason)}
              </span>
              {item.inspectionResult && (
                <span className="mt-1 flex items-center gap-1.5">
                  <Pill tone={outcomeTone(item.inspectionResult)}>
                    {outcomeLabel(item.inspectionResult)}
                  </Pill>
                  {item.restocked && <Pill tone="info">вернули в продажу</Pill>}
                </span>
              )}
            </span>
            <span className="t-money shrink-0">{money(item.refundAmount)}</span>
          </li>
        ))}
      </ul>

      {entry.lastInspection && (
        <div className="mt-4 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3.5 py-3">
          <span className="t-label mb-1 block">Заключение осмотра</span>
          <p className="text-[13px]">
            {entry.lastInspection.outcome}
            {entry.lastInspection.classification ? ` · ${entry.lastInspection.classification}` : ''}
          </p>
          {entry.lastInspection.note && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--fg-muted)]">
              {entry.lastInspection.note}
            </p>
          )}
        </div>
      )}

      {canDecide && status === 'REQUESTED' && (
        <div className="mt-4">
          <Field label="Комментарий к решению" hint="Попадёт в аудит и в сообщение покупателю">
            <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>
      )}

      {/* RET-004: a declined return needs a reason the buyer can read. */}
      <ConfirmModal
        open={declining}
        onClose={() => setDeclining(false)}
        onConfirm={() => {
          setDeclining(false);
          onAct(() => returns.decide(entry.id, false, note || undefined), 'Возврат отклонён');
        }}
        busy={busy}
        danger
        title="Отклонить возврат"
        confirmLabel="Отклонить"
        body={
          <>
            <p>Покупатель получит отказ с вашим комментарием.</p>
            {!note.trim() && (
              <div className="mt-3">
                <Note tone="warn">
                  Комментарий пуст. Отказ без объяснения почти всегда возвращается обращением в
                  поддержку.
                </Note>
              </div>
            )}
          </>
        }
      />

      {inspecting && (
        <InspectionModal
          items={entry.items}
          busy={busy}
          onClose={() => setInspecting(false)}
          onSubmit={(body) => {
            setInspecting(false);
            onAct(() => returns.inspect(entry.id, body), 'Осмотр записан');
          }}
        />
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="t-label">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}
