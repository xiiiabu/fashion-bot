'use client';

/**
 * The audit trail — spec §10.7 and §15, ADM-009.
 *
 * Append-only, sequenced, and showing the before/after of every change. The
 * diff is the point: an audit log that records "seller.update by X" without
 * saying what changed is a log that cannot answer the only question anyone
 * ever asks it.
 *
 * ADM-009 also decides what is *not* here: the actor's IP is stored hashed, so
 * the panel shows the hash. It is enough to tell two sessions apart, which is
 * what an investigation needs, without keeping an address we have no reason to
 * hold.
 */

import { useMemo, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { governance, type AuditRow } from '@/lib/endpoints';
import { dateTime, number } from '@/lib/format';
import {
  Button,
  Card,
  CopyId,
  Modal,
  Note,
  PageHeader,
  Pill,
  Table,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, SearchBox, useList } from '@/components/data-screen';
import { severityTone } from '@/lib/status';

const PAGE = 50;

/** The actions worth filtering by — the ones an investigation starts from. */
const ACTIONS = [
  'admin.login',
  'admin.login.failed',
  'admin.create',
  'admin.roles',
  'admin.disabled',
  'seller.create',
  'seller.update',
  'seller.onboarding',
  'product.lifecycle',
  'product.update',
  'inventory.adjust',
  'suborder.advance',
  'return.decide',
  'return.inspect',
  'refund.create',
  'refund.approve',
  'adjustment.create',
  'adjustment.approve',
  'payout.create',
  'payout.approve',
  'payout.settle',
  'ledger.verify',
  'config.set',
  'featureflag.set',
  'privacy.process',
  'cms.block.save',
].map((value) => ({ value, label: value }));

export default function AuditPage() {
  const { can } = useApp();
  const [action, setAction] = useState('');
  const [objectId, setObjectId] = useState('');
  const [open, setOpen] = useState<AuditRow | null>(null);

  const list = useList<AuditRow>(
    (offset) =>
      governance
        .audit({
          action: action || undefined,
          objectId: objectId || undefined,
          limit: PAGE,
          offset,
        })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [action, objectId],
    PAGE,
  );

  return (
    <>
      <PageHeader
        title="Аудит"
        subtitle={`${number(list.total)} записей · только добавление`}
        action={
          <>
            <SearchBox value={objectId} onChange={setObjectId} placeholder="ID объекта" />
            <FilterSelect value={action} onChange={setAction} options={ACTIONS} allLabel="Все действия" />
          </>
        }
      />

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Действие</th>
              <th>Кто</th>
              <th>Объект</th>
              <th>Важность</th>
              <th>Причина</th>
              <th>Когда</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={8} emptyTitle="Записей нет">
              {(rows) =>
                rows.map((row) => {
                  const hasDiff = row.before !== null || row.after !== null;
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setOpen(row)}
                      className="cursor-pointer hover:bg-[var(--bg-sunken)]"
                    >
                      <td className="num t-num text-[var(--fg-faint)]">{row.sequence}</td>
                      <td className="t-mono whitespace-nowrap text-[12.5px]">{row.action}</td>
                      <td className="max-w-[180px] truncate text-[12.5px]">
                        {row.actorEmail ?? (
                          <span className="text-[var(--fg-muted)]">{row.actorType.toLowerCase()}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {row.objectId ? (
                          <>
                            <span className="mr-1.5 text-[11.5px] text-[var(--fg-faint)]">
                              {row.objectType}
                            </span>
                            <CopyId value={row.objectId} />
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <Pill tone={severityTone(row.severity)}>{row.severity}</Pill>
                      </td>
                      <td className="max-w-[200px] truncate text-[var(--fg-muted)]" title={row.reason ?? ''}>
                        {row.reason ?? '—'}
                      </td>
                      <td className="whitespace-nowrap text-[var(--fg-muted)]">{dateTime(row.createdAt)}</td>
                      <td className="text-right text-[11.5px] text-[var(--fg-faint)]">
                        {hasDiff ? 'diff' : ''}
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
        Журнал неизменяем и пронумерован: пропуск в нумерации означает, что запись удалили на уровне
        базы. IP-адрес хранится в виде хэша (ADM-009) — его достаточно, чтобы отличить сессии, и
        недостаточно, чтобы восстановить адрес.
      </p>

      {open && <AuditDetail row={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ── Detail with a real diff ─────────────────────────────────────────────── */

interface FieldChange {
  key: string;
  before: unknown;
  after: unknown;
}

/** Flattens before/after into the fields that actually differ. */
function diff(before: unknown, after: unknown): FieldChange[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  if (!isRecord(before) || !isRecord(after)) {
    if (before === undefined && after === undefined) return [];
    return [{ key: '(значение)', before, after }];
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .map((key) => ({ key, before: before[key], after: after[key] }))
    .filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
}

function render(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function AuditDetail({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  const changes = useMemo(() => diff(row.before, row.after), [row.before, row.after]);

  return (
    <Modal
      open
      onClose={onClose}
      width={700}
      title={
        <span className="flex items-center gap-2.5">
          <span className="t-mono">{row.action}</span>
          <Pill tone={severityTone(row.severity)}>{row.severity}</Pill>
        </span>
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
        <Row label="Запись №" value={<span className="t-num">{row.sequence}</span>} />
        <Row label="Когда" value={dateTime(row.createdAt)} />
        <Row label="Кто" value={row.actorEmail ?? row.actorType} />
        <Row label="Тип субъекта" value={row.actorType} />
        <Row label="Объект" value={row.objectType ?? '—'} />
        <Row label="ID объекта" value={row.objectId ? <CopyId value={row.objectId} /> : '—'} />
        <Row
          label="Хэш IP"
          value={row.ipHash ? <span className="t-mono text-[11.5px]">{row.ipHash}</span> : '—'}
        />
        <Row
          label="Correlation ID"
          value={row.correlationId ? <CopyId value={row.correlationId} /> : '—'}
        />
      </dl>

      {row.reason && (
        <div className="mt-3">
          <span className="t-label mb-1 block">Причина</span>
          <p className="rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3 py-2 text-[13px] leading-relaxed">
            {row.reason}
          </p>
        </div>
      )}

      <h3 className="t-eyebrow mb-2 mt-5">Что изменилось</h3>
      {changes.length === 0 ? (
        <Note tone="neutral">
          Запись не содержит изменений полей — это событие (вход, проверка, экспорт), а не правка.
        </Note>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Поле</th>
              <th>До</th>
              <th>После</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change) => (
              <tr key={change.key}>
                <td className="t-mono align-top text-[12px]">{change.key}</td>
                <td className="max-w-[200px] align-top">
                  <span className="t-mono block break-words text-[11.5px] text-[var(--fg-muted)] line-through decoration-danger/50">
                    {render(change.before)}
                  </span>
                </td>
                <td className="max-w-[200px] align-top">
                  <span className="t-mono block break-words text-[11.5px]">{render(change.after)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {row.userAgent && (
        <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--fg-faint)]">
          User-Agent: {row.userAgent}
        </p>
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
