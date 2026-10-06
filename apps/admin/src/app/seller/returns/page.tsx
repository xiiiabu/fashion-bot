'use client';

/**
 * Seller returns — spec §11.4, SEL-005.
 *
 * The seller's part of a return is narrower than the platform's on purpose:
 * they record that the parcel arrived and what the inspection found. Whether
 * the money goes back is the platform's decision, because a seller deciding
 * their own refunds is a conflict the buyer cannot see.
 *
 * The inspection form is shared with the admin screen — same per-item verdicts
 * and the same restock switch — so there is one definition of what an
 * inspection is rather than two that drift.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { seller, type InspectionInput, type ReturnRow } from '@/lib/endpoints';
import { dateTime, money, number } from '@/lib/format';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Note,
  PageHeader,
  Pill,
  Table,
  Tabs,
} from '@/components/ui';
import { InspectionModal, outcomeLabel, outcomeTone, reasonLabel } from '@/components/return-inspection';
import { returnLabel, returnTone } from '@/lib/status';

type Pane = 'todo' | 'all';

/** What is waiting on the seller: a parcel to receive, or one to inspect. */
const isSellerTurn = (row: ReturnRow) =>
  row.status === 'APPROVED' || row.status === 'HANDED_OVER' || row.status === 'RECEIVED';

export default function SellerReturnsPage() {
  const { can, toast } = useApp();
  const [pane, setPane] = useState<Pane>('todo');
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<ReturnRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await seller.returns({ limit: 100 });
      setRows(data.rows);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (action: () => Promise<unknown>, successMessage: string) => {
      setBusy(true);
      try {
        await action();
        toast(successMessage, 'success');
        setInspecting(null);
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, load],
  );

  const visible = useMemo(() => {
    if (!rows) return null;
    return pane === 'todo' ? rows.filter(isSellerTurn) : rows;
  }, [rows, pane]);

  const open = useMemo(
    () => (openId ? (rows?.find((row) => row.id === openId) ?? null) : null),
    [openId, rows],
  );

  const todoCount = rows?.filter(isSellerTurn).length;
  const sizeDriven = rows?.filter((row) => (row.reason ?? '').startsWith('SIZE')).length ?? 0;

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <>
      <PageHeader
        title="Возвраты"
        subtitle={todoCount ? `${number(todoCount)} требуют действия` : 'Ничего не ждёт вас'}
        action={
          <Button variant="outline" onClick={load}>
            Обновить
          </Button>
        }
      />

      {rows && rows.length > 0 && sizeDriven / rows.length > 0.3 && (
        <div className="mb-4">
          <Note tone="warn" title="Больше трети возвратов — из-за размера">
            Это почти всегда размерная сетка или замеры товара, а не покупатели. Проверьте замеры у
            товаров с возвратами: подсказка размера строится на них, и неточность в сантиметре
            превращается в возврат.
          </Note>
        </div>
      )}

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'todo', label: 'Требуют действия', count: todoCount },
          { value: 'all', label: 'Все', count: rows?.length },
        ]}
      />

      {visible === null ? (
        <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title={pane === 'todo' ? 'Нет возвратов в работе' : 'Возвратов не было'}
            body="Когда покупатель вернёт вещь, здесь нужно будет отметить получение посылки и результат осмотра."
          />
        </Card>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <th>Заявка</th>
                <th>Заказ</th>
                <th>Статус</th>
                <th>Причина</th>
                <th className="num">Сумма</th>
                <th>Создана</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setOpenId(row.id)}
                  className="cursor-pointer hover:bg-[var(--bg-sunken)]"
                >
                  <td className="t-mono whitespace-nowrap">{row.number}</td>
                  <td className="t-mono whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                    {row.orderNumber}
                  </td>
                  <td>
                    <Pill tone={returnTone(row.status)}>{returnLabel(row.status)}</Pill>
                  </td>
                  <td>{reasonLabel(row.reason)}</td>
                  <td className="num t-money">{money(row.refundTotal)}</td>
                  <td className="whitespace-nowrap text-[var(--fg-muted)]">{dateTime(row.createdAt)}</td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {can('return:write') &&
                        (row.status === 'APPROVED' || row.status === 'HANDED_OVER') && (
                          <Button
                            size="xs"
                            variant="outline"
                            loading={busy}
                            onClick={(event) => {
                              event.stopPropagation();
                              void act(() => seller.returnReceived(row.id), 'Посылка отмечена полученной');
                            }}
                          >
                            Посылка получена
                          </Button>
                        )}
                      {can('return:inspect') && row.status === 'RECEIVED' && (
                        <Button
                          size="xs"
                          variant="primary"
                          onClick={(event) => {
                            event.stopPropagation();
                            setInspecting(row);
                          }}
                        >
                          Осмотр
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

      <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
        Деньги покупателю возвращает платформа после вашего осмотра — так покупатель не зависит от
        того, кто именно продал вещь. Комиссия за возвращённую позицию возвращается вам.
      </p>

      {open && (
        <ReturnDetail
          entry={open}
          onClose={() => setOpenId(null)}
          onInspect={() => {
            setInspecting(open);
            setOpenId(null);
          }}
          canInspect={can('return:inspect') && open.status === 'RECEIVED'}
        />
      )}

      {inspecting && (
        <InspectionModal
          items={inspecting.items}
          busy={busy}
          onClose={() => setInspecting(null)}
          onSubmit={(body: InspectionInput) =>
            void act(() => seller.inspectReturn(inspecting.id, body), 'Осмотр записан')
          }
        />
      )}
    </>
  );
}

function ReturnDetail({
  entry,
  canInspect,
  onClose,
  onInspect,
}: {
  entry: ReturnRow;
  canInspect: boolean;
  onClose: () => void;
  onInspect: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={
        <span className="flex items-center gap-2.5">
          <span className="t-mono">{entry.number}</span>
          <Pill tone={returnTone(entry.status)}>{returnLabel(entry.status)}</Pill>
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
          {canInspect && (
            <Button variant="primary" onClick={onInspect}>
              Осмотр
            </Button>
          )}
        </>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
        <div>
          <dt className="t-label">Заказ</dt>
          <dd className="t-mono mt-0.5">{entry.orderNumber}</dd>
        </div>
        <div>
          <dt className="t-label">Создана</dt>
          <dd className="mt-0.5">{dateTime(entry.createdAt)}</dd>
        </div>
        <div>
          <dt className="t-label">Причина</dt>
          <dd className="mt-0.5">{reasonLabel(entry.reason)}</dd>
        </div>
        <div>
          <dt className="t-label">Сумма возврата</dt>
          <dd className="t-money mt-0.5">{money(entry.refundTotal)}</dd>
        </div>
      </dl>

      {entry.comment && (
        <div className="mt-3">
          <span className="t-label mb-1 block">Что написал покупатель</span>
          <p className="rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3 py-2 text-[13px] leading-relaxed">
            {entry.comment}
          </p>
        </div>
      )}

      <h3 className="t-eyebrow mb-2 mt-5">Позиции</h3>
      <ul className="space-y-2">
        {entry.items.map((item) => (
          <li
            key={item.id}
            className="flex items-start justify-between gap-3 border-b border-[var(--line)] pb-2 text-[13px] last:border-0"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{item.title}</span>
              <span className="text-[11.5px] text-[var(--fg-faint)]">
                {item.sizeLabel} · {item.quantity} шт · {reasonLabel(item.reason)}
              </span>
              {item.inspectionResult && (
                <span className="mt-1 flex gap-1.5">
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
          <span className="t-label mb-1 block">Заключение</span>
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
    </Modal>
  );
}
