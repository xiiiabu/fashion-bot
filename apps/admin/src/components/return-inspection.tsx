'use client';

/**
 * The return inspection — spec §9, RET-006.
 *
 * Shared by the platform's returns queue and the seller cabinet, because an
 * inspection means the same thing on both: a verdict per returned unit, a note
 * when the verdict is not "accepted", and one decision about whether the unit
 * goes back on sale. Two copies of this form would drift, and the first sign
 * of the drift would be a refund computed from a verdict the other side never
 * recorded.
 */

import { useCallback, useState } from 'react';
import type { InspectionInput, InspectionOutcome, ReturnItemRow } from '@/lib/endpoints';
import { money } from '@/lib/format';
import { Button, Field, Input, Modal, Pill, Select, Switch, Textarea } from '@/components/ui';

/** RET-006: what an inspection can conclude about one returned unit. */
const OUTCOMES: Array<{ value: InspectionOutcome; label: string; hint: string }> = [
  {
    value: 'ACCEPTED',
    label: 'Принят',
    hint: 'Товар в исходном виде — полный возврат за эту позицию.',
  },
  {
    value: 'PARTIAL',
    label: 'Принят частично',
    hint: 'Следы использования или неполная комплектация — возврат с удержанием.',
  },
  {
    value: 'REJECTED',
    label: 'Отклонён',
    hint: 'Не соответствует условиям возврата — деньги за позицию не возвращаются.',
  },
];

/** RET-003: the reason the buyer gave, which drives the size analytics. */
const REASON_LABELS: Record<string, string> = {
  SIZE_TOO_SMALL: 'Мал размер',
  SIZE_TOO_LARGE: 'Велик размер',
  SIZE_WRONG: 'Не подошёл размер',
  NOT_AS_DESCRIBED: 'Не соответствует описанию',
  QUALITY: 'Качество',
  DEFECT: 'Брак',
  DAMAGED: 'Повреждён при доставке',
  WRONG_ITEM: 'Прислали не то',
  CHANGED_MIND: 'Передумал',
  LATE_DELIVERY: 'Долгая доставка',
  OTHER: 'Другое',
};



export function reasonLabel(reason: string | null): string {
  if (!reason) return '—';
  return REASON_LABELS[reason] ?? reason;
}

export function outcomeLabel(outcome: string): string {
  return OUTCOMES.find((option) => option.value === outcome)?.label ?? outcome;
}

export function outcomeTone(outcome: string): 'success' | 'danger' | 'warn' {
  if (outcome === 'ACCEPTED') return 'success';
  if (outcome === 'REJECTED') return 'danger';
  return 'warn';
}

/** A classification for the inspection: who the return is chargeable to. */
const CLASSIFICATIONS = [
  { value: 'BUYER_CHOICE', label: 'Решение покупателя' },
  { value: 'SIZE_MISMATCH', label: 'Не подошёл размер' },
  { value: 'SELLER_FAULT', label: 'Вина продавца (брак, не то прислали)' },
  { value: 'CARRIER_DAMAGE', label: 'Повреждение при доставке' },
  { value: 'FRAUD_SUSPECTED', label: 'Подозрение на недобросовестность' },
];

interface Verdict {
  outcome: InspectionOutcome;
  restock: boolean;
  note: string;
}

export function InspectionModal({
  items,
  busy,
  onClose,
  onSubmit,
}: {
  items: ReturnItemRow[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: InspectionInput) => void;
}) {
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>(() =>
    Object.fromEntries(
      items.map((item) => [item.id, { outcome: 'ACCEPTED' as InspectionOutcome, restock: true, note: '' }]),
    ),
  );
  const [classification, setClassification] = useState(CLASSIFICATIONS[0].value);
  const [note, setNote] = useState('');

  const update = useCallback((id: string, patch: Partial<Verdict>) => {
    setVerdicts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }, []);

  // A verdict other than "accepted" needs to say what was wrong: that text is
  // what the seller and the buyer are shown when money is withheld.
  const incomplete = items.some((item) => {
    const verdict = verdicts[item.id];
    return verdict.outcome !== 'ACCEPTED' && verdict.note.trim().length < 3;
  });

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title="Результат осмотра"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={incomplete}
            onClick={() =>
              onSubmit({
                items: items.map((item) => ({
                  returnItemId: item.id,
                  outcome: verdicts[item.id].outcome,
                  // Only an accepted unit can go back on sale.
                  restock: verdicts[item.id].outcome === 'ACCEPTED' && verdicts[item.id].restock,
                  note: verdicts[item.id].note.trim() || undefined,
                })),
                classification,
                note: note.trim() || undefined,
              })
            }
          >
            Записать осмотр
          </Button>
        </>
      }
    >
      <ul className="space-y-4">
        {items.map((item) => {
          const verdict = verdicts[item.id];
          const chosen = OUTCOMES.find((option) => option.value === verdict.outcome) ?? OUTCOMES[0];
          return (
            <li key={item.id} className="rounded-[var(--radius-md)] border border-[var(--line)] p-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[13.5px] font-medium">{item.title}</span>
                <span className="t-money shrink-0 text-[13px]">{money(item.refundAmount)}</span>
              </div>
              <p className="mt-0.5 text-[11.5px] text-[var(--fg-faint)]">
                {item.sizeLabel} · {item.quantity} шт · заявленная причина: {reasonLabel(item.reason)}
              </p>

              <div className="mt-3">
                <Field label="Заключение" required>
                  <Select
                    value={verdict.outcome}
                    onChange={(event) =>
                      update(item.id, { outcome: event.target.value as InspectionOutcome })
                    }
                  >
                    {OUTCOMES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <p className="mt-1 text-[12px] text-[var(--fg-faint)]">{chosen.hint}</p>
              </div>

              <div className="mt-3">
                <Field
                  label="Что увидели"
                  required={verdict.outcome !== 'ACCEPTED'}
                  hint={
                    verdict.outcome === 'ACCEPTED'
                      ? 'Необязательно'
                      : 'Обязательно: это объяснение увидят покупатель и продавец'
                  }
                >
                  <Input
                    value={verdict.note}
                    onChange={(event) => update(item.id, { note: event.target.value })}
                  />
                </Field>
              </div>

              {verdict.outcome === 'ACCEPTED' && (
                <div className="mt-3">
                  <Switch
                    checked={verdict.restock}
                    onChange={(next) => update(item.id, { restock: next })}
                    label="Вернуть в продажу"
                    hint="Остаток SKU увеличится на это количество. Снимите, если вещь требует чистки или ремонта."
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-4 grid gap-3.5">
        <Field label="Классификация возврата" hint="Определяет, на кого относится стоимость возврата">
          <Select value={classification} onChange={(event) => setClassification(event.target.value)}>
            {CLASSIFICATIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Общий комментарий" hint="Необязательно — для случаев, которые не ложатся в позиции">
          <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

