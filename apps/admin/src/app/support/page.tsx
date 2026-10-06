'use client';

/**
 * Support — spec §12 (FUL-010) and ADM-007 (PII minimisation).
 *
 * Personal data arrives masked and stays masked. A support agent resolving
 * "where is my parcel" needs the order, not the customer's street, and the API
 * only unmasks for roles that may see it — journalling the access when it
 * does. The panel says which it is showing rather than letting an agent
 * mistake a mask for the real number and read it out on a call.
 *
 * An internal note and a reply to the customer are different buttons, because
 * the cost of confusing them is a customer reading an agent's working notes.
 */

import { useCallback, useEffect, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { support, type TicketDetail, type TicketRow, type TicketStatus } from '@/lib/endpoints';
import { dateTime, money, number, relativeTime } from '@/lib/format';
import {
  Button,
  Card,
  CopyId,
  Field,
  Modal,
  Note,
  PageHeader,
  Pill,
  Select,
  Switch,
  Table,
  Textarea,
  cx,
  type Tone,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, SearchBox, useList } from '@/components/data-screen';

const PAGE = 25;

const STATUSES: Array<{ value: TicketStatus; label: string }> = [
  { value: 'OPEN', label: 'Открыто' },
  { value: 'WAITING_CUSTOMER', label: 'Ждём покупателя' },
  { value: 'WAITING_SELLER', label: 'Ждём продавца' },
  { value: 'ESCALATED', label: 'Эскалация' },
  { value: 'RESOLVED', label: 'Решено' },
  { value: 'CLOSED', label: 'Закрыто' },
];

function statusLabel(status: string): string {
  return STATUSES.find((option) => option.value === status)?.label ?? status;
}

function statusTone(status: string): Tone {
  switch (status) {
    case 'OPEN':
      return 'accent';
    case 'ESCALATED':
      return 'danger';
    case 'WAITING_CUSTOMER':
    case 'WAITING_SELLER':
      return 'info';
    case 'RESOLVED':
      return 'success';
    default:
      return 'neutral';
  }
}

const CATEGORIES: Record<string, string> = {
  DELIVERY: 'Доставка',
  PAYMENT: 'Оплата',
  RETURN: 'Возврат',
  SIZE: 'Размер',
  PRODUCT: 'Товар',
  ACCOUNT: 'Аккаунт',
  PRIVACY: 'Персональные данные',
  OTHER: 'Другое',
};

export default function SupportPage() {
  const { can, toast } = useApp();
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useList<TicketRow>(
    (offset) =>
      support
        .tickets({ status: status || undefined, search: query || undefined, limit: PAGE, offset })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [status, query],
    PAGE,
  );

  return (
    <>
      <PageHeader
        title="Поддержка"
        subtitle={`${number(list.total)} обращений`}
        action={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="Номер обращения или заказа" />
            <FilterSelect value={status} onChange={setStatus} options={STATUSES} allLabel="Все статусы" />
          </>
        }
      />

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Обращение</th>
              <th>Тема</th>
              <th>Покупатель</th>
              <th>Заказ</th>
              <th>Статус</th>
              <th className="num">Сообщений</th>
              <th>Первый ответ</th>
              <th>Создано</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={9} emptyTitle="Обращений нет">
              {(rows) =>
                rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setOpenId(row.id)}
                    className="cursor-pointer hover:bg-[var(--bg-sunken)]"
                  >
                    <td className="t-mono whitespace-nowrap">{row.number}</td>
                    <td className="max-w-[240px]">
                      <span className="block truncate" title={row.subject}>
                        {row.subject}
                      </span>
                      <span className="block text-[11.5px] text-[var(--fg-faint)]">
                        {CATEGORIES[row.category] ?? row.category}
                        {row.priority && row.priority !== 'NORMAL' ? ` · ${row.priority}` : ''}
                      </span>
                    </td>
                    <td className="max-w-[150px] truncate">{row.customer.name || '—'}</td>
                    <td className="t-mono whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                      {row.order?.number ?? '—'}
                    </td>
                    <td>
                      <Pill tone={statusTone(row.status)}>{statusLabel(row.status)}</Pill>
                    </td>
                    <td className="num t-num">{number(row.messageCount)}</td>
                    <td className="whitespace-nowrap text-[var(--fg-muted)]">
                      {row.firstResponseAt ? (
                        relativeTime(row.firstResponseAt)
                      ) : (
                        // FUL-010 promises a human answer; an unanswered ticket
                        // is the one number this queue is judged by.
                        <span className="text-warn">не отвечено</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-[var(--fg-muted)]">{relativeTime(row.createdAt)}</td>
                    <td className="text-right text-[var(--fg-faint)]">→</td>
                  </tr>
                ))
              }
            </ListBody>
          </tbody>
        </Table>
        <ListFooter state={list} />
      </Card>

      {openId && (
        <TicketView
          id={openId}
          canWrite={can('support:write')}
          onClose={() => setOpenId(null)}
          onChanged={list.reload}
          onError={(message) => toast(message, 'error')}
          onSuccess={(message) => toast(message, 'success')}
        />
      )}
    </>
  );
}

/* ── Thread ──────────────────────────────────────────────────────────────── */

function TicketView({
  id,
  canWrite,
  onClose,
  onChanged,
  onError,
  onSuccess,
}: {
  id: string;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}) {
  const [data, setData] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [nextStatus, setNextStatus] = useState<TicketStatus | ''>('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await support.ticket(id));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async () => {
    setBusy(true);
    try {
      await support.reply(id, {
        body: body.trim(),
        isInternal: internal,
        status: nextStatus || undefined,
      });
      onSuccess(internal ? 'Заметка добавлена' : 'Ответ отправлен');
      setBody('');
      setNextStatus('');
      await load();
      onChanged();
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [id, body, internal, nextStatus, onSuccess, onError, load, onChanged]);

  // A masked value keeps its shape but loses its middle; if what came back
  // still contains a bullet, the role did not unlock PII.
  const masked = Boolean(data && /[•*]/.test(`${data.customer.name}${data.customer.phone ?? ''}`));

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title={
        data ? (
          <span className="flex items-center gap-2.5">
            <span className="t-mono">{data.number}</span>
            <Pill tone={statusTone(data.status)}>{statusLabel(data.status)}</Pill>
          </span>
        ) : (
          'Обращение'
        )
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      {error && <Note tone="danger">{error}</Note>}
      {!data && !error && <div className="skeleton h-[260px] w-full rounded-[var(--radius-md)]" />}

      {data && (
        <>
          <p className="text-[14px] font-medium">{data.subject}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
            <Row label="Категория" value={CATEGORIES[data.category] ?? data.category} />
            <Row label="Приоритет" value={data.priority} />
            <Row label="Покупатель" value={data.customer.name || '—'} />
            <Row label="Телефон" value={data.customer.phone ?? '—'} />
            <Row label="Язык" value={data.customer.locale.toUpperCase()} />
            <Row label="Создано" value={dateTime(data.createdAt)} />
          </dl>

          {masked && (
            <div className="mt-3">
              <Note tone="neutral">
                Персональные данные показаны в маскированном виде (ADM-007). Полный номер и адрес
                доступны только ролям с правом на это, и каждый такой доступ записывается в аудит.
              </Note>
            </div>
          )}

          {data.order && (
            <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--line)] px-3.5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="t-mono text-[13px]">{data.order.number}</span>
                <span className="t-money text-[13px]">
                  {money({
                    amount: data.order.grandTotalMinor,
                    currency: data.order.currency,
                  } as never)}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] text-[var(--fg-muted)]">
                Статус заказа: {data.order.status}
              </p>
            </div>
          )}

          {data.customer.addresses.length > 0 && (
            <div className="mt-3">
              <span className="t-label mb-1 block">Адреса покупателя</span>
              <ul className="space-y-0.5 text-[12.5px] text-[var(--fg-muted)]">
                {data.customer.addresses.map((address) => (
                  <li key={address.id}>
                    {address.city}
                    {address.street ? `, ${address.street}` : ''}
                    {address.building ? `, ${address.building}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3 className="t-eyebrow mb-2.5 mt-5">Переписка</h3>
          <ul className="space-y-2.5">
            {data.messages.map((message) => (
              <li
                key={message.id}
                className={cx(
                  'rounded-[var(--radius-md)] px-3.5 py-2.5',
                  message.isInternal
                    ? 'border border-dashed border-warn/45 bg-warn-soft'
                    : message.author === 'AGENT'
                      ? 'bg-[var(--accent-soft)]'
                      : 'bg-[var(--bg-sunken)]',
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-[11px]">
                  <span className="font-semibold uppercase tracking-[0.08em]">
                    {message.author === 'AGENT'
                      ? 'Оператор'
                      : message.author === 'USER'
                        ? 'Покупатель'
                        : 'Система'}
                  </span>
                  {message.isInternal && <Pill tone="warn">внутренняя заметка</Pill>}
                  <span className="ml-auto text-[var(--fg-faint)]">{dateTime(message.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{message.body}</p>
              </li>
            ))}
          </ul>

          {canWrite && data.status !== 'CLOSED' && (
            <div className="mt-5 rounded-[var(--radius-md)] border border-[var(--line)] p-3.5">
              <Field
                label={internal ? 'Внутренняя заметка' : 'Ответ покупателю'}
                hint={
                  internal
                    ? 'Покупатель этого не увидит. Статус обращения не меняется автоматически.'
                    : 'Будет отправлено покупателю в Telegram.'
                }
              >
                <Textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} />
              </Field>

              <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                <Switch
                  checked={internal}
                  onChange={setInternal}
                  label="Внутренняя заметка"
                  hint="Для коллег, не для покупателя"
                />
                <div className="flex items-end gap-2">
                  <Field label="Статус после отправки" className="min-w-[180px]">
                    <Select
                      value={nextStatus}
                      onChange={(event) => setNextStatus(event.target.value as TicketStatus | '')}
                    >
                      <option value="">
                        {internal ? 'не менять' : 'Ждём покупателя (по умолчанию)'}
                      </option>
                      {STATUSES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={body.trim().length === 0}
                    onClick={() => void send()}
                  >
                    {internal ? 'Добавить заметку' : 'Отправить'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {data.status === 'CLOSED' && (
            <div className="mt-5">
              <Note tone="neutral">
                Обращение закрыто. Если покупатель напишет снова, будет создано новое обращение.
              </Note>
            </div>
          )}
        </>
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
