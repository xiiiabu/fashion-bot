'use client';

/**
 * The seller quality score — spec §11.6, SEL-008.
 *
 * The score alone is useless to the person being judged by it: a seller told
 * "0.92" learns nothing they can act on. So the factors are always shown with
 * it, each with the weight it carried and the count behind it, because that is
 * what turns a number into a thing someone can fix.
 *
 * The API returns `score` as a 0…1 weighted mean of factor values that are
 * themselves 0…100. Rendering it as a percentage is the only place that
 * conversion happens, so it cannot drift between screens.
 */

import type { QualityScore } from '@/lib/endpoints';
import { Card, Note } from './ui';

const FACTOR_LABELS: Record<string, string> = {
  fulfilment: 'Исполнение заказов',
  confirmation_sla: 'Подтверждение в срок',
  no_overdue: 'Нет просроченных',
  low_returns: 'Низкая доля возвратов',
};

function factorLabel(factor: string): string {
  return FACTOR_LABELS[factor] ?? factor.replaceAll('_', ' ');
}

/** Red below 70, amber below 90, green above: the thresholds the SLA uses. */
function barColour(value: number): string {
  if (value < 70) return 'var(--danger)';
  if (value < 90) return 'var(--warn)';
  return 'var(--success)';
}

export function QualityCard({
  quality,
  title = 'Качество',
  note,
}: {
  quality: QualityScore | null | undefined;
  title?: string;
  note?: string;
}) {
  const score = quality?.score ?? null;
  const factors = quality?.factors ?? [];

  return (
    <Card title={title}>
      <div className="flex items-baseline gap-2.5">
        <span className="t-money text-[32px] leading-none" style={{ color: score === null ? undefined : barColour(score * 100) }}>
          {score === null ? '—' : Math.round(score * 100)}
        </span>
        <span className="text-[13px] text-[var(--fg-muted)]">из 100</span>
      </div>

      {factors.length === 0 ? (
        <p className="mt-3 text-[12.5px] text-[var(--fg-faint)]">
          Недостаточно данных для оценки — оценка появится после первых заказов.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {factors.map((factor) => (
            <li key={factor.factor}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate">{factorLabel(factor.factor)}</span>
                <span className="t-num shrink-0 tabular-nums">
                  {factor.value.toFixed(factor.value % 1 === 0 ? 0 : 1)}
                  <span className="ml-1.5 text-[11px] text-[var(--fg-faint)]">
                    вес {Math.round(factor.weight * 100)}%
                  </span>
                </span>
              </div>
              <div className="mt-1 h-[5px] overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                <div
                  className="h-full rounded-full transition-[width]"
                  style={{
                    width: `${Math.max(0, Math.min(100, factor.value))}%`,
                    background: barColour(factor.value),
                  }}
                />
              </div>
              <p className="mt-1 text-[11.5px] text-[var(--fg-faint)]">{factor.note}</p>
            </li>
          ))}
        </ul>
      )}

      {note && (
        <div className="mt-4">
          <Note tone="neutral">{note}</Note>
        </div>
      )}
    </Card>
  );
}
