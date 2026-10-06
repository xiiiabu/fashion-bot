'use client';

/**
 * The parts every list screen repeats: loading, failure, emptiness, paging,
 * filtering. Written once so the twenty screens below differ only where they
 * genuinely differ.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/app-context';
import { Button, EmptyRow, ErrorState, Input, Select, SkeletonRows, cx } from './ui';

export interface ListState<T> {
  rows: T[];
  total: number;
  loading: boolean;
  error: string | null;
  reload: () => void;
  loadMore: (() => void) | null;
  loadingMore: boolean;
}

/**
 * Loads a page of rows and keeps them. `deps` is what a change should refetch
 * on: a filter, a search term, a tab.
 */
export function useList<T>(
  fetcher: (offset: number) => Promise<{ rows: T[]; total: number }>,
  deps: unknown[],
  pageSize = 50,
): ListState<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcherRef
      .current(0)
      .then((page) => {
        if (cancelled) return;
        setRows(page.rows);
        setTotal(page.total);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    fetcherRef
      .current(rows.length)
      .then((page) => setRows((current) => [...current, ...page.rows]))
      .catch(() => {
        /* a failed page leaves what is on screen */
      })
      .finally(() => setLoadingMore(false));
  }, [rows.length, loadingMore]);

  return {
    rows,
    total,
    loading,
    error,
    reload,
    loadingMore,
    loadMore: rows.length < total && rows.length >= pageSize ? loadMore : null,
  };
}

/** The body of a table: skeleton, error, empty or rows. */
export function ListBody<T>({
  state,
  columns,
  emptyTitle = 'Ничего не найдено',
  children,
}: {
  state: ListState<T>;
  columns: number;
  emptyTitle?: string;
  children: (rows: T[]) => ReactNode;
}) {
  if (state.loading) return <SkeletonRows rows={6} cols={columns} />;
  if (state.error) {
    return (
      <tr>
        <td colSpan={columns} className="p-4">
          <ErrorState message={state.error} onRetry={state.reload} />
        </td>
      </tr>
    );
  }
  if (state.rows.length === 0) return <EmptyRow colSpan={columns}>{emptyTitle}</EmptyRow>;
  return <>{children(state.rows)}</>;
}

export function ListFooter<T>({ state }: { state: ListState<T> }) {
  if (!state.loadMore) return null;
  return (
    <div className="flex justify-center border-t border-[var(--line)] py-3">
      <Button variant="outline" loading={state.loadingMore} onClick={state.loadMore}>
        Показать ещё
      </Button>
    </div>
  );
}

/** A debounced search box, so typing does not fire a request per keystroke. */
export function SearchBox({
  value,
  onChange,
  placeholder = 'Поиск',
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (draft !== value) onChange(draft);
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      className={cx('w-[220px]', className)}
    />
  );
}

export function FilterSelect({
  value,
  onChange,
  options,
  allLabel = 'Все',
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
}) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
