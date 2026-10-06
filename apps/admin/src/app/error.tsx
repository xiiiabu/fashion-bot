'use client';

/**
 * The boundary that keeps one broken screen from taking the panel with it.
 *
 * Without it, a render error unmounts the whole tree: the sidebar goes, the
 * session appears lost, and an operator mid-task has no way back except
 * reloading and finding their place again. That is exactly what happened when
 * the ledger verification read a field the API does not return — one undefined
 * property blanked the page.
 *
 * So the failure is contained and named. "Повторить" re-renders the segment,
 * which is usually enough when the cause was a one-off response; the digest is
 * what support needs to find it in the logs.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { Button, Card } from '@/components/ui';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Next's overlay only shows in development, so in production this is the
    // one place the stack is recoverable from a browser console.
    console.error('screen failed to render', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-[560px] py-10">
      <Card title="Экран не отрисовался">
        <p className="text-[13.5px] leading-relaxed">
          Ошибка в этом экране — остальная панель работает. Данные не изменились: до записи дело не
          дошло.
        </p>

        <p className="mt-3 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3.5 py-2.5 text-[12.5px] leading-relaxed">
          <span className="t-mono">{error.message || 'Unknown error'}</span>
          {error.digest && (
            <>
              <br />
              <span className="t-mono text-[11px] text-[var(--fg-faint)]">digest: {error.digest}</span>
            </>
          )}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" onClick={reset}>
            Повторить
          </Button>
          <Link href="/">
            <Button variant="outline">На дашборд</Button>
          </Link>
        </div>

        <p className="mt-4 text-[12px] leading-relaxed text-[var(--fg-faint)]">
          Если повторяется — пришлите в поддержку адрес страницы и digest выше. По нему запрос
          находится в логах с точностью до секунды.
        </p>
      </Card>
    </div>
  );
}
