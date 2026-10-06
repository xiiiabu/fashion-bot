'use client';

/**
 * CMS document — the terms, the privacy policy and the public offer (§12.1).
 *
 * The API returns the body as localised Markdown. It is rendered by our own
 * small renderer (components/markdown.tsx) rather than a library, because a
 * general Markdown parser passes raw HTML through by default and a CMS field
 * is not a place to accept HTML. Rendering it as plain text was tried first
 * and showed the shopper the literal '#' and '_' characters.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { catalog } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { date } from '@/lib/format';
import { ScreenHeader, useBackButton } from '@/components/shell';
import { ErrorState, LoadingScreen } from '@/components/ui';
import { Markdown } from '@/components/markdown';

export default function CmsPage() {
  const params = useParams<{ slug: string }>();
  const { locale } = useApp();
  const t = useT();
  useBackButton('/profile');

  const [page, setPage] = useState<{
    slug: string;
    title: string;
    body: string;
    updatedAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPage(await catalog.page(params.slug));
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [params.slug, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div>
        <ScreenHeader back="/profile" title="" />
        <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!page) {
    return (
      <div>
        <ScreenHeader back="/profile" title="" />
        <LoadingScreen />
      </div>
    );
  }

  return (
    <div className="pb-10">
      <ScreenHeader back="/profile" title={page.title} />
      <article className="px-4 pt-5">
        <h1 className="t-title">{page.title}</h1>
        <p className="mt-1.5 text-[12px] text-[var(--fg-faint)]">{date(page.updatedAt, locale)}</p>
        <div className="mt-5">
          <Markdown source={page.body} />
        </div>
      </article>
    </div>
  );
}
