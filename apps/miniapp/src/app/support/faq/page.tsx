'use client';

/** FAQ — spec §10.1, answered from the CMS so support can edit it directly. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { support as supportApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { ScreenHeader, useBackButton } from '@/components/shell';
import { Collapsible, EmptyState, ErrorState, Note, Section, Skeleton } from '@/components/ui';

export default function FaqPage() {
  const { locale } = useApp();
  const t = useT();
  useBackButton('/support');

  const [items, setItems] = useState<
    Array<{ id: string; question: string; answer: string; category: string }> | null
  >(null);
  const [escalation, setEscalation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await supportApi.faq(locale);
      setItems(data.entries);
      setEscalation(data.escalation);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ id: string; question: string; answer: string }>>();
    for (const entry of items ?? []) {
      const bucket = map.get(entry.category);
      if (bucket) bucket.push(entry);
      else map.set(entry.category, [entry]);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className="pb-8">
      <ScreenHeader back="/support" title={t('profile.faq')} />

      {error && <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />}

      {!items && !error && (
        <div className="space-y-3 px-4 pt-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-[52px] w-full" />
          ))}
        </div>
      )}

      {items && items.length === 0 && <EmptyState title={t('common.empty')} />}

      {/* §10.1: when the FAQ does not answer it, say where a person will. */}
      {escalation && (
        <div className="px-4 pt-4">
          <Note tone="neutral">{escalation}</Note>
        </div>
      )}

      {grouped.map(([category, entries]) => (
        <Section key={category} title={category}>
          <div className="border-t border-[var(--line)]">
            {entries.map((entry) => (
              <Collapsible key={entry.id} title={entry.question}>
                <p className="whitespace-pre-line">{entry.answer}</p>
              </Collapsible>
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}
