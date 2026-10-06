'use client';

/**
 * Platform settings — spec §14 (feature flags), §15 (privacy) and Appendix D
 * (the open decisions).
 *
 * The decisions panel is the one that earns its place. Appendix D lists ten
 * questions the product cannot answer for itself — who is the merchant of
 * record, who issues the fiscal receipt, which settlement mode each PSP
 * supports — and several are still OPEN. They are stored as settings so the
 * panel can show what is unresolved rather than letting it live in a document
 * nobody opens. A DECIDED entry is the record of the answer.
 *
 * Two flags are off for legal reasons, not technical ones: photo body
 * measurement (D-10, needs a DPIA) and marketing push (NTF-002, needs the
 * consent flow signed off). Turning either on from here would be a decision
 * with legal consequences, so each carries the reason it is off.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { governance, type PrivacyRequestRow } from '@/lib/endpoints';
import { date, dateTime, number, relativeTime } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  CopyId,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Pill,
  Select,
  Switch,
  Table,
  Tabs,
  Textarea,
  cx,
} from '@/components/ui';

/**
 * Flags whose "off" is a legal position. Turning one on needs the thing named
 * here to exist first, so the switch says so instead of flipping quietly.
 */
const LEGAL_GATES: Record<string, string> = {
  photo_body_measurement:
    'D-10: включать можно только после DPIA и юридической классификации данных. Снимок фигуры — биометрия в терминах O‘RQ-547.',
  marketing_push:
    'NTF-002: маркетинговые рассылки требуют отдельного согласия. Пока поток согласия не согласован, рассылка остаётся выключенной.',
};

type Pane = 'decisions' | 'flags' | 'privacy' | 'ai';

export default function SettingsPage() {
  const { can } = useApp();
  const [pane, setPane] = useState<Pane>('decisions');

  return (
    <>
      <PageHeader title="Настройки" subtitle="Решения, флаги, приватность и конфигурация стилиста" />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'decisions', label: 'Решения и параметры' },
          { value: 'flags', label: 'Флаги' },
          { value: 'privacy', label: 'Приватность' },
          { value: 'ai', label: 'Стилист' },
        ]}
      />

      {pane === 'decisions' && <Settings canWrite={can('config:write')} />}
      {pane === 'flags' && <Flags canWrite={can('featureflag:write')} />}
      {pane === 'privacy' && <Privacy canWrite={can('privacyrequest:process')} />}
      {pane === 'ai' && <AiOverview />}
    </>
  );
}

/* ── Decisions and parameters (Appendix D) ──────────────────────────────── */

type SettingRow = Awaited<ReturnType<typeof governance.settings>>['items'][number];

/** A decision setting is `{ note, status }`; anything else is a parameter. */
function asDecision(value: unknown): { note: string; status: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.note !== 'string' || typeof record.status !== 'string') return null;
  return { note: record.note, status: record.status };
}

function Settings({ canWrite }: { canWrite: boolean }) {
  const { toast } = useApp();
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SettingRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await governance.settings();
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (key: string, value: unknown, description?: string) => {
      setBusy(true);
      try {
        await governance.saveSetting(key, value, description);
        toast('Сохранено', 'success');
        setEditing(null);
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, load],
  );

  const split = useMemo(() => {
    const decisions: Array<SettingRow & { decision: { note: string; status: string } }> = [];
    const parameters: SettingRow[] = [];
    for (const row of rows ?? []) {
      const decision = asDecision(row.value);
      if (decision) decisions.push({ ...row, decision });
      else parameters.push(row);
    }
    return { decisions, parameters };
  }, [rows]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <div className="skeleton h-[220px] rounded-[var(--radius-lg)]" />;

  const open = split.decisions.filter((row) => row.decision.status !== 'DECIDED');

  return (
    <>
      {open.length > 0 && (
        <div className="mb-4">
          <Note tone="warn" title={`Открытых решений: ${open.length}`}>
            Это вопросы из Приложения D, на которые продукт не может ответить сам — юридическая роль
            платформы, фискальный чек, схема расчётов с провайдерами. Пока они открыты, часть
            функциональности остаётся выключенной намеренно, а не из-за недоделки.
          </Note>
        </div>
      )}

      <Card title={`Решения · ${number(split.decisions.length)}`} padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Решение</th>
              <th>Состояние</th>
              <th>Формулировка</th>
              <th>Обновлено</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {split.decisions.map((row) => (
              <tr key={row.key}>
                <td className="whitespace-nowrap">
                  <span className="t-mono text-[12px]">{row.key.replace('decision.', '')}</span>
                </td>
                <td>
                  <Pill tone={row.decision.status === 'DECIDED' ? 'success' : 'warn'}>
                    {row.decision.status === 'DECIDED' ? 'решено' : 'открыто'}
                  </Pill>
                </td>
                <td className="max-w-[420px]">
                  <span className="block text-[13px] leading-snug">{row.decision.note}</span>
                  {row.description && (
                    <span className="mt-0.5 block text-[11.5px] text-[var(--fg-faint)]">
                      {row.description}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                  {row.updatedAt ? date(row.updatedAt) : '—'}
                </td>
                <td className="text-right">
                  {canWrite && (
                    <Button size="xs" variant="ghost" onClick={() => setEditing(row)}>
                      Изменить
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {split.parameters.length > 0 && (
        <Card className="mt-5" title={`Параметры · ${number(split.parameters.length)}`} padded={false}>
          <Table>
            <thead>
              <tr>
                <th>Ключ</th>
                <th>Значение</th>
                <th>Описание</th>
                <th>Обновлено</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {split.parameters.map((row) => (
                <tr key={row.key}>
                  <td className="t-mono whitespace-nowrap text-[12px]">{row.key}</td>
                  <td className="max-w-[260px]">
                    <code className="t-mono block truncate text-[11.5px]">
                      {JSON.stringify(row.value)}
                    </code>
                  </td>
                  <td className="max-w-[260px] truncate text-[12.5px] text-[var(--fg-muted)]">
                    {row.description ?? '—'}
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                    {row.updatedAt ? date(row.updatedAt) : '—'}
                  </td>
                  <td className="text-right">
                    {canWrite && (
                      <Button size="xs" variant="ghost" onClick={() => setEditing(row)}>
                        Изменить
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {editing && (
        <SettingEditor row={editing} busy={busy} onClose={() => setEditing(null)} onSave={save} />
      )}
    </>
  );
}

function SettingEditor({
  row,
  busy,
  onClose,
  onSave,
}: {
  row: SettingRow;
  busy: boolean;
  onClose: () => void;
  onSave: (key: string, value: unknown, description?: string) => void;
}) {
  const decision = asDecision(row.value);
  const [note, setNote] = useState(decision?.note ?? '');
  const [status, setStatus] = useState(decision?.status ?? 'OPEN');
  const [raw, setRaw] = useState(() => JSON.stringify(row.value, null, 2));

  const rawValid = useMemo(() => {
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  }, [raw]);

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={<span className="t-mono text-[13px]">{row.key}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={decision ? note.trim().length < 3 : !rawValid}
            onClick={() =>
              onSave(
                row.key,
                decision ? { note: note.trim(), status } : JSON.parse(raw),
                row.description ?? undefined,
              )
            }
          >
            Сохранить
          </Button>
        </>
      }
    >
      {row.description && (
        <p className="mb-3 text-[12.5px] text-[var(--fg-muted)]">{row.description}</p>
      )}

      {decision ? (
        <div className="grid gap-3.5">
          <Field label="Состояние">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="OPEN">Открыто</option>
              <option value="DECIDED">Решено</option>
            </Select>
          </Field>
          <Field
            label="Формулировка"
            required
            hint="Если решение принято — запишите именно его, а не намерение. Этот текст будет единственным следом."
          >
            <Textarea rows={4} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {status === 'DECIDED' && decision.status !== 'DECIDED' && (
            <Note tone="warn">
              Отметка «решено» означает, что по этому вопросу можно строить реализацию. Если ответ
              ещё согласуется — оставьте «открыто».
            </Note>
          )}
        </div>
      ) : (
        <Field label="Значение (JSON)" error={rawValid ? null : 'Это не JSON'}>
          <Textarea
            rows={8}
            className="t-mono text-[12px]"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
          />
        </Field>
      )}
    </Modal>
  );
}

/* ── Feature flags ───────────────────────────────────────────────────────── */

type FlagRow = Awaited<ReturnType<typeof governance.featureFlags>>['items'][number];

function Flags({ canWrite }: { canWrite: boolean }) {
  const { toast } = useApp();
  const [rows, setRows] = useState<FlagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<FlagRow | null>(null);
  const [rollout, setRollout] = useState<FlagRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await governance.featureFlags();
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (body: { key: string; enabled: boolean; rolloutPercent?: number }) => {
      setBusy(true);
      try {
        await governance.saveFeatureFlag(body);
        toast('Флаг обновлён', 'success');
        setConfirming(null);
        setRollout(null);
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, load],
  );

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />;

  return (
    <>
      <Card title={`Флаги · ${number(rows.length)}`} padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Флаг</th>
              <th>Состояние</th>
              <th className="num">Охват</th>
              <th>Обновлён</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const gate = LEGAL_GATES[row.key];
              return (
                <tr key={row.id}>
                  <td className="max-w-[320px]">
                    <span className="t-mono block text-[12.5px]">{row.key}</span>
                    <span className="block text-[11.5px] leading-snug text-[var(--fg-muted)]">
                      {row.description ?? '—'}
                    </span>
                    {gate && (
                      <span className="mt-1 block text-[11.5px] leading-snug text-warn">{gate}</span>
                    )}
                  </td>
                  <td>
                    {row.enabled ? <Pill tone="success">включён</Pill> : <Pill tone="neutral">выключен</Pill>}
                  </td>
                  <td className="num t-num">
                    {row.rolloutPercent}%
                    {row.allowUserIds.length > 0 && (
                      <span className="ml-1.5 text-[11px] text-[var(--fg-faint)]">
                        +{row.allowUserIds.length}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                    {relativeTime(row.updatedAt)}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {canWrite && (
                        <>
                          <Button size="xs" variant="ghost" onClick={() => setRollout(row)}>
                            Охват
                          </Button>
                          <Button
                            size="xs"
                            variant={row.enabled ? 'ghost' : gate ? 'outline' : 'primary'}
                            onClick={() => setConfirming(row)}
                          >
                            {row.enabled ? 'Выключить' : 'Включить'}
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {confirming && (
        <ConfirmModal
          open
          onClose={() => setConfirming(null)}
          onConfirm={() =>
            void save({
              key: confirming.key,
              enabled: !confirming.enabled,
              rolloutPercent: confirming.enabled ? confirming.rolloutPercent : confirming.rolloutPercent || 100,
            })
          }
          busy={busy}
          danger={!confirming.enabled && Boolean(LEGAL_GATES[confirming.key])}
          confirmWord={!confirming.enabled && LEGAL_GATES[confirming.key] ? 'ВКЛЮЧИТЬ' : undefined}
          title={confirming.enabled ? 'Выключить флаг' : 'Включить флаг'}
          confirmLabel={confirming.enabled ? 'Выключить' : 'Включить'}
          body={
            <>
              <p className="t-mono text-[12.5px]">{confirming.key}</p>
              <p className="mt-1.5">{confirming.description}</p>
              {!confirming.enabled && LEGAL_GATES[confirming.key] && (
                <div className="mt-3">
                  <Note tone="danger" title="Это не техническое решение">
                    {LEGAL_GATES[confirming.key]}
                  </Note>
                </div>
              )}
            </>
          }
        />
      )}

      {rollout && <RolloutModal flag={rollout} busy={busy} onClose={() => setRollout(null)} onSave={save} />}
    </>
  );
}

function RolloutModal({
  flag,
  busy,
  onClose,
  onSave,
}: {
  flag: FlagRow;
  busy: boolean;
  onClose: () => void;
  onSave: (body: { key: string; enabled: boolean; rolloutPercent?: number }) => void;
}) {
  const [percent, setPercent] = useState(String(flag.rolloutPercent));
  const value = Number(percent);
  const valid = Number.isInteger(value) && value >= 0 && value <= 100;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Охват · ${flag.key}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid || value === flag.rolloutPercent}
            onClick={() => onSave({ key: flag.key, enabled: flag.enabled, rolloutPercent: value })}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <Field
        label="Процент пользователей"
        hint="Распределение устойчивое: один и тот же пользователь всегда попадает в ту же группу, иначе сравнивать нечего."
      >
        <Input
          type="number"
          min={0}
          max={100}
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
          autoFocus
        />
      </Field>
      {!flag.enabled && (
        <div className="mt-3">
          <Note tone="neutral">
            Флаг выключен — охват вступит в силу, когда его включат.
          </Note>
        </div>
      )}
    </Modal>
  );
}

/* ── Privacy requests (§15) ──────────────────────────────────────────────── */

const PRIVACY_KINDS: Record<string, string> = {
  EXPORT: 'Выгрузка данных',
  DELETE: 'Удаление аккаунта',
  RECTIFY: 'Исправление данных',
  RESTRICT: 'Ограничение обработки',
  OBJECT: 'Возражение против обработки',
};

function Privacy({ canWrite }: { canWrite: boolean }) {
  const { toast } = useApp();
  const [rows, setRows] = useState<PrivacyRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<PrivacyRequestRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await governance.privacyRequests();
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />;

  const overdue = rows.filter(
    (row) => row.dueAt && !row.processedAt && new Date(row.dueAt).getTime() < Date.now(),
  );

  return (
    <>
      <div className="mb-4">
        <Note tone="neutral" title="Обработка персональных данных">
          Запросы субъектов данных по O‘RQ-547: выгрузка, удаление, исправление. У каждого есть срок.
          Удаление не отменяет обязательного хранения бухгалтерских и налоговых записей — заказы
          остаются в объёме, который требует закон, а профиль и мерки удаляются.
        </Note>
      </div>

      {overdue.length > 0 && (
        <div className="mb-4">
          <Note tone="danger" title={`Просрочено: ${overdue.length}`}>
            Срок ответа истёк. Это нарушение, а не очередь.
          </Note>
        </div>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Запросов нет"
            body="Покупатели управляют данными сами в разделе «Приватность» Mini App; сюда попадает только то, что требует человека."
          />
        </Card>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <th>Тип</th>
                <th>Статус</th>
                <th>Покупатель</th>
                <th>Получен</th>
                <th>Срок</th>
                <th>Решение</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const late = row.dueAt && !row.processedAt && new Date(row.dueAt).getTime() < Date.now();
                return (
                  <tr key={row.id}>
                    <td>{PRIVACY_KINDS[row.kind] ?? row.kind}</td>
                    <td>
                      <Pill
                        tone={
                          row.status === 'COMPLETED'
                            ? 'success'
                            : row.status === 'REJECTED'
                              ? 'danger'
                              : row.status === 'IN_PROGRESS'
                                ? 'info'
                                : 'accent'
                        }
                      >
                        {row.status}
                      </Pill>
                    </td>
                    <td>
                      <CopyId value={row.userId} />
                    </td>
                    <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                      {dateTime(row.requestedAt)}
                    </td>
                    <td className={cx('whitespace-nowrap text-[12px]', late && 'font-semibold text-danger')}>
                      {row.dueAt ? date(row.dueAt) : '—'}
                    </td>
                    <td className="max-w-[220px] truncate text-[12.5px] text-[var(--fg-muted)]">
                      {row.resolution ?? '—'}
                    </td>
                    <td className="text-right">
                      {canWrite && !row.processedAt && (
                        <Button size="xs" variant="primary" onClick={() => setActing(row)}>
                          Обработать
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {acting && (
        <ProcessPrivacy
          row={acting}
          busy={busy}
          onClose={() => setActing(null)}
          onSubmit={async (body) => {
            setBusy(true);
            try {
              await governance.processPrivacyRequest(acting.id, body);
              toast('Запрос обработан', 'success');
              setActing(null);
              await load();
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </>
  );
}

function ProcessPrivacy({
  row,
  busy,
  onClose,
  onSubmit,
}: {
  row: PrivacyRequestRow;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { status: 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED'; resolution?: string }) => void;
}) {
  const [status, setStatus] = useState<'IN_PROGRESS' | 'COMPLETED' | 'REJECTED'>('COMPLETED');
  const [resolution, setResolution] = useState('');

  const needsReason = status === 'REJECTED';

  return (
    <Modal
      open
      onClose={onClose}
      title={PRIVACY_KINDS[row.kind] ?? row.kind}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={needsReason && resolution.trim().length < 3}
            onClick={() => onSubmit({ status, resolution: resolution.trim() || undefined })}
          >
            Записать
          </Button>
        </>
      }
    >
      <Field label="Результат">
        <Select
          value={status}
          onChange={(event) => setStatus(event.target.value as 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED')}
        >
          <option value="IN_PROGRESS">В работе</option>
          <option value="COMPLETED">Выполнено</option>
          <option value="REJECTED">Отказано</option>
        </Select>
      </Field>

      <div className="mt-3.5">
        <Field
          label="Что было сделано"
          required={needsReason}
          hint={
            needsReason
              ? 'Отказ требует основания: покупатель имеет право знать, почему.'
              : 'Запись останется в журнале обработки.'
          }
        >
          <Textarea rows={3} value={resolution} onChange={(event) => setResolution(event.target.value)} />
        </Field>
      </div>

      {status === 'COMPLETED' && row.kind === 'DELETE' && (
        <div className="mt-3">
          <Note tone="warn">
            Удаление необратимо. Профиль, мерки и предпочтения удаляются; заказы и бухгалтерские
            записи сохраняются в объёме обязательного хранения — об этом покупателя нужно
            предупредить в ответе.
          </Note>
        </div>
      )}
    </Modal>
  );
}

/* ── Stylist configuration (AI-00x) ─────────────────────────────────────── */

function AiOverview() {
  const [data, setData] = useState<Awaited<ReturnType<typeof governance.aiOverview>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    governance
      .aiOverview()
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
  if (!data) return <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />;

  return (
    <>
      <div className="mb-4">
        <Note tone="neutral" title="Как собирается образ">
          Стилист подбирает только из опубликованных товаров с ценой и остатком, затем объясняет
          выбор правилами. Языковая модель, если включена, только переформулирует объяснение — она
          не выбирает вещи и не может предложить то, чего нет в наличии.
        </Note>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title="Версии">
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--fg-muted)]">Движок</dt>
              <dd className="t-mono">{data.engine.version}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--fg-muted)]">Правила</dt>
              <dd className="t-mono">{data.engine.rulesVersion}</dd>
            </div>
          </dl>
        </Card>

        <Card title={`Готовые запросы · ${number(data.suggestions.length)}`}>
          <ul className="space-y-1.5 text-[13px]">
            {data.suggestions.map((suggestion) => (
              <li key={suggestion} className="text-[var(--fg-muted)]">
                · {suggestion}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-5" title={`Шаблоны образов · ${number(data.templates.length)}`} padded={false}>
        <Table>
          <thead>
            <tr>
              <th>Шаблон</th>
              <th>Слоты</th>
              <th>Стили</th>
              <th>Поводы</th>
            </tr>
          </thead>
          <tbody>
            {data.templates.map((template) => (
              <tr key={template.key}>
                <td>
                  <span className="block font-medium">{template.title}</span>
                  <span className="t-mono block text-[11px] text-[var(--fg-faint)]">{template.key}</span>
                </td>
                <td className="max-w-[220px]">
                  <div className="flex flex-wrap gap-1">
                    {template.slots.map((slot) => (
                      <Pill key={slot} tone="neutral">
                        {slot}
                      </Pill>
                    ))}
                  </div>
                </td>
                <td className="max-w-[200px] text-[12px] text-[var(--fg-muted)]">
                  {template.styles.join(', ') || '—'}
                </td>
                <td className="max-w-[200px] text-[12px] text-[var(--fg-muted)]">
                  {template.occasions.join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
