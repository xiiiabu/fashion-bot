'use client';

/**
 * Search and browse — spec BUY-003 (facets, sort, pagination) and CAT-007
 * (RU/UZ/EN search including transliteration, which the API handles).
 *
 * The URL is the state. Every filter writes into the query string, so a shopper
 * can go into a product and come back to exactly the same result set, and the
 * bot can deep-link into a filtered view (TG-002).
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { SearchFacets, SearchResult } from '@fashion/core';
import { catalog, track, trackScreen, type SearchParams } from '@/lib/endpoints';
import { colorLabel, colorSwatch, seasonLabel, styleLabel } from '@/lib/taxonomy-labels';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { majorUnits, money, number } from '@/lib/format';
import { ProductGrid, ProductGridSkeleton } from '@/components/product';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Button,
  Chip,
  CloseIcon,
  EmptyState,
  ErrorState,
  FilterIcon,
  Input,
  SearchIcon,
  Sheet,
  SortIcon,
  Spinner,
  Switch,
  cx,
} from '@/components/ui';
import { haptic } from '@/lib/telegram';

const SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'discount', 'popular'] as const;
type Sort = (typeof SORTS)[number];

/** Multi-value filters that live in the query string as comma-joined lists. */
const LIST_KEYS = ['category', 'brand', 'size', 'color', 'material', 'style', 'season', 'fit'] as const;
type ListKey = (typeof LIST_KEYS)[number];

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="px-4 pt-6"><ProductGridSkeleton /></div>}>
      <SearchScreen />
    </Suspense>
  );
}

function SearchScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { locale } = useApp();
  const t = useT();
  useBackButton();

  const [query, setQuery] = useState(params.get('q') ?? '');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  /** The request derived from the URL. Rebuilt whenever the query string moves. */
  const searchParams = useMemo<SearchParams>(() => {
    const next: SearchParams = {};
    const q = params.get('q');
    if (q) next.q = q;
    for (const key of LIST_KEYS) {
      const raw = params.get(key);
      if (raw) (next as Record<string, string[]>)[key] = raw.split(',').filter(Boolean);
    }
    const sort = params.get('sort');
    if (sort && (SORTS as readonly string[]).includes(sort)) next.sort = sort as Sort;
    const priceMin = params.get('priceMin');
    if (priceMin) next.priceMin = priceMin;
    const priceMax = params.get('priceMax');
    if (priceMax) next.priceMax = priceMax;
    if (params.get('discount') === 'true') next.discount = 'true';
    if (params.get('inStock') === 'true') next.inStock = 'true';
    const collection = params.get('collection');
    if (collection) next.collection = collection;
    next.limit = 24;
    return next;
  }, [params]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    for (const key of LIST_KEYS) {
      const raw = params.get(key);
      if (raw) count += raw.split(',').filter(Boolean).length;
    }
    if (params.get('priceMin') || params.get('priceMax')) count += 1;
    if (params.get('discount') === 'true') count += 1;
    if (params.get('inStock') === 'true') count += 1;
    return count;
  }, [params]);

  /** Rewrites the query string; the effect below refetches off that change. */
  const navigate = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params.toString());
      mutate(next);
      const search = next.toString();
      router.replace(search ? `/search?${search}` : '/search', { scroll: false });
    },
    [params, router],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    catalog
      .search(searchParams)
      .then((data) => {
        if (cancelled) return;
        setResult(data);
        track('search_performed', {
          query: searchParams.q ?? null,
          total: data.total,
          filters: activeFilterCount,
        });
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught, locale));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // activeFilterCount is only used for the analytics payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, locale]);

  /** BUY-003: infinite scroll over the cursor the server returns. */
  const loadMore = useCallback(async () => {
    if (!result?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await catalog.search({ ...searchParams, cursor: result.nextCursor });
      setResult((current) =>
        current
          ? { ...page, items: [...current.items, ...page.items], facets: current.facets }
          : page,
      );
    } catch {
      /* a failed page leaves what is already on screen */
    } finally {
      setLoadingMore(false);
    }
  }, [result, loadingMore, searchParams]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !result?.nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [result?.nextCursor, loadMore]);

  const submitQuery = useCallback(
    (value: string) => {
      navigate((next) => {
        if (value.trim()) next.set('q', value.trim());
        else next.delete('q');
      });
    },
    [navigate],
  );

  const currentSort = (params.get('sort') as Sort | null) ?? 'relevance';

  return (
    <div>
      <ScreenHeader
        back
        sticky
        title={
          <SearchField
            value={query}
            onChange={setQuery}
            onSubmit={submitQuery}
            placeholder={t('search.placeholder')}
          />
        }
      />

      <div className="sticky top-[52px] z-10 flex items-center gap-2 overflow-x-auto bg-[var(--bg)]/92 px-4 py-2.5 backdrop-blur-xl no-scrollbar">
        <Chip selected={activeFilterCount > 0} onClick={() => setFiltersOpen(true)}>
          <FilterIcon size={14} />
          {t('search.filters')}
          {activeFilterCount > 0 && <span className="t-num">{activeFilterCount}</span>}
        </Chip>
        <Chip selected={currentSort !== 'relevance'} onClick={() => setSortOpen(true)}>
          <SortIcon size={14} />
          {t(`sort.${currentSort}`)}
        </Chip>
        {activeFilterCount > 0 && (
          <Chip
            onClick={() =>
              navigate((next) => {
                for (const key of LIST_KEYS) next.delete(key);
                next.delete('priceMin');
                next.delete('priceMax');
                next.delete('discount');
                next.delete('inStock');
              })
            }
          >
            <CloseIcon size={13} />
            {t('search.clearFilters')}
          </Chip>
        )}
      </div>

      <div className="px-4 pb-6">
        {result && !loading && (
          <p className="pb-3 text-[12.5px] text-[var(--fg-faint)]">
            {t('search.results')}: <span className="t-num">{number(result.total, locale)}</span>
          </p>
        )}

        {result?.didYouMean && (
          <p className="pb-3 text-[13px] text-[var(--fg-muted)]">
            {t('search.didYouMean')}{' '}
            <button
              type="button"
              className="font-semibold text-[var(--accent)] underline underline-offset-2"
              onClick={() => {
                setQuery(result.didYouMean!);
                submitQuery(result.didYouMean!);
              }}
            >
              {result.didYouMean}
            </button>
          </p>
        )}

        {error && <ErrorState message={error} onRetry={() => submitQuery(query)} retryLabel={t('common.retry')} />}

        {loading && !error && <ProductGridSkeleton count={6} />}

        {!loading && !error && result && result.items.length === 0 && (
          <EmptyState
            icon={<SearchIcon size={30} />}
            title={t('search.nothing')}
            body={t('search.nothingHint')}
            action={
              activeFilterCount > 0 ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    navigate((next) => {
                      for (const key of LIST_KEYS) next.delete(key);
                      next.delete('priceMin');
                      next.delete('priceMax');
                      next.delete('discount');
                      next.delete('inStock');
                    })
                  }
                >
                  {t('search.clearFilters')}
                </Button>
              ) : undefined
            }
          />
        )}

        {!loading && !error && result && result.items.length > 0 && (
          <>
            <ProductGrid products={result.items} />
            <div ref={sentinel} className="h-px" />
            {loadingMore && (
              <div className="flex justify-center py-7">
                <Spinner size={18} className="text-[var(--fg-faint)]" />
              </div>
            )}
          </>
        )}
      </div>

      {result && (
        <FilterSheet
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          facets={result.facets}
          params={params}
          navigate={navigate}
          total={result.total}
        />
      )}

      <Sheet open={sortOpen} onClose={() => setSortOpen(false)} title={t('search.sort')}>
        <div className="space-y-1 pb-2">
          {SORTS.map((sort) => (
            <button
              key={sort}
              type="button"
              onClick={() => {
                haptic.select();
                navigate((next) => {
                  if (sort === 'relevance') next.delete('sort');
                  else next.set('sort', sort);
                });
                setSortOpen(false);
              }}
              className={cx(
                'flex w-full items-center justify-between rounded-[var(--radius-md)] px-3.5 py-3.5 text-left text-[15px]',
                currentSort === sort ? 'bg-[var(--accent-soft)] font-semibold' : 'active:bg-[var(--bg-sunken)]',
              )}
            >
              {t(`sort.${sort}`)}
              {currentSort === sort && <span className="text-[var(--accent)]">✓</span>}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.blur();
        onSubmit(value);
      }}
      className="flex h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--bg-raised)] px-3.5"
    >
      <SearchIcon size={16} className="shrink-0 text-[var(--fg-faint)]" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        enterKeyHint="search"
        inputMode="search"
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-[var(--fg-faint)] focus:outline-none"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear"
          onClick={() => {
            onChange('');
            onSubmit('');
          }}
          className="shrink-0 text-[var(--fg-faint)]"
        >
          <CloseIcon size={15} />
        </button>
      )}
    </form>
  );
}

/* ── Filters ─────────────────────────────────────────────────────────────── */


function FilterSheet({
  open,
  onClose,
  facets,
  params,
  navigate,
  total,
}: {
  open: boolean;
  onClose: () => void;
  facets: SearchFacets;
  params: URLSearchParams;
  navigate: (mutate: (next: URLSearchParams) => void) => void;
  total: number;
}) {
  const { locale } = useApp();
  const t = useT();

  const selected = useCallback(
    (key: ListKey) => (params.get(key) ?? '').split(',').filter(Boolean),
    [params],
  );

  const toggle = useCallback(
    (key: ListKey, value: string) => {
      const current = selected(key);
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      navigate((search) => {
        if (next.length > 0) search.set(key, next.join(','));
        else search.delete(key);
      });
    },
    [navigate, selected],
  );

  const priceMinMajor = majorUnits(facets.priceRange.min) ?? 0;
  const priceMaxMajor = majorUnits(facets.priceRange.max) ?? 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('search.filters')}
      height="tall"
      footer={
        <div className="flex gap-2.5">
          <Button
            variant="outline"
            onClick={() =>
              navigate((next) => {
                for (const key of LIST_KEYS) next.delete(key);
                next.delete('priceMin');
                next.delete('priceMax');
                next.delete('discount');
                next.delete('inStock');
              })
            }
          >
            {t('common.reset')}
          </Button>
          <Button block onClick={onClose}>
            {t('common.apply')} · <span className="t-num">{number(total, locale)}</span>
          </Button>
        </div>
      }
    >
      <div className="space-y-7 pb-3">
        <FilterGroup title={t('filter.inStockOnly')} bare>
          <div className="space-y-3.5">
            <Switch
              checked={params.get('inStock') === 'true'}
              onChange={(next) =>
                navigate((search) => (next ? search.set('inStock', 'true') : search.delete('inStock')))
              }
              label={t('filter.inStockOnly')}
            />
            <Switch
              checked={params.get('discount') === 'true'}
              onChange={(next) =>
                navigate((search) => (next ? search.set('discount', 'true') : search.delete('discount')))
              }
              label={t('filter.discountOnly')}
            />
          </div>
        </FilterGroup>

        {facets.categories.length > 0 && (
          <FilterGroup title={t('filter.category')}>
            {facets.categories.map((category) => (
              <Chip
                key={category.slug}
                selected={selected('category').includes(category.slug)}
                count={category.count}
                onClick={() => toggle('category', category.slug)}
              >
                {category.name}
              </Chip>
            ))}
          </FilterGroup>
        )}

        {facets.brands.length > 0 && (
          <FilterGroup title={t('filter.brand')}>
            {facets.brands.map((brand) => (
              <Chip
                key={brand.id}
                selected={selected('brand').includes(brand.id)}
                count={brand.count}
                onClick={() => toggle('brand', brand.id)}
              >
                {brand.name}
              </Chip>
            ))}
          </FilterGroup>
        )}

        {facets.sizes.length > 0 && (
          <FilterGroup title={t('filter.size')}>
            {facets.sizes.map((size) => (
              <Chip
                key={size.label}
                selected={selected('size').includes(size.label)}
                onClick={() => toggle('size', size.label)}
              >
                {size.label}
              </Chip>
            ))}
          </FilterGroup>
        )}

        {facets.colors.length > 0 && (
          <FilterGroup title={t('filter.color')} bare>
            <div className="flex flex-wrap gap-2.5">
              {facets.colors.map((color) => {
                const isSelected = selected('color').includes(color.family);
                const swatch = colorSwatch(color.family);
                return (
                  <button
                    key={color.family}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      haptic.select();
                      toggle('color', color.family);
                    }}
                    className="pressable flex w-[56px] flex-col items-center gap-0.5"
                  >
                    <span
                      className={cx(
                        'flex h-[38px] w-[38px] items-center justify-center rounded-full border-2',
                        isSelected ? 'border-[var(--accent)]' : 'border-[var(--line)]',
                      )}
                    >
                      <span
                        className="h-[28px] w-[28px] rounded-full"
                        style={swatch.startsWith('#') ? { backgroundColor: swatch } : { background: swatch }}
                      />
                    </span>
                    <span className="line-clamp-1 text-[10px] leading-tight text-[var(--fg-muted)]">
                      {colorLabel(color.family, locale)}
                    </span>
                    <span className="t-num text-[10px] text-[var(--fg-faint)]">{color.count}</span>
                  </button>
                );
              })}
            </div>
          </FilterGroup>
        )}

        <FilterGroup title={t('filter.price')} bare>
          <div className="flex items-center gap-2.5">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              placeholder={String(priceMinMajor)}
              defaultValue={params.get('priceMin') ? majorUnits({ amount: params.get('priceMin')!, currency: 'UZS' }) ?? '' : ''}
              onBlur={(event) => {
                const value = event.target.value.trim();
                navigate((search) => {
                  if (value) search.set('priceMin', String(BigInt(Math.round(Number(value))) * 100n));
                  else search.delete('priceMin');
                });
              }}
              aria-label={t('filter.priceFrom')}
            />
            <span className="text-[var(--fg-faint)]">—</span>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              placeholder={String(priceMaxMajor)}
              defaultValue={params.get('priceMax') ? majorUnits({ amount: params.get('priceMax')!, currency: 'UZS' }) ?? '' : ''}
              onBlur={(event) => {
                const value = event.target.value.trim();
                navigate((search) => {
                  if (value) search.set('priceMax', String(BigInt(Math.round(Number(value))) * 100n));
                  else search.delete('priceMax');
                });
              }}
              aria-label={t('filter.priceTo')}
            />
          </div>
          <p className="mt-1.5 text-[12px] text-[var(--fg-faint)]">
            {money(facets.priceRange.min, locale)} — {money(facets.priceRange.max, locale)}
          </p>
        </FilterGroup>

        {facets.styles.length > 0 && (
          <FilterGroup title={t('filter.style')}>
            {facets.styles.map((style) => (
              <Chip
                key={style.value}
                selected={selected('style').includes(style.value)}
                count={style.count}
                onClick={() => toggle('style', style.value)}
              >
                {styleLabel(style.value, locale)}
              </Chip>
            ))}
          </FilterGroup>
        )}

        {facets.materials.length > 0 && (
          <FilterGroup title={t('filter.material')}>
            {facets.materials.slice(0, 18).map((material) => (
              <Chip
                key={material.value}
                selected={selected('material').includes(material.value)}
                count={material.count}
                onClick={() => toggle('material', material.value)}
              >
                {material.value}
              </Chip>
            ))}
          </FilterGroup>
        )}

        {facets.seasons.length > 0 && (
          <FilterGroup title={t('filter.season')}>
            {facets.seasons.map((season) => (
              <Chip
                key={season.value}
                selected={selected('season').includes(season.value)}
                count={season.count}
                onClick={() => toggle('season', season.value)}
              >
                {seasonLabel(season.value, locale)}
              </Chip>
            ))}
          </FilterGroup>
        )}

        {facets.fits.length > 0 && (
          <FilterGroup title={t('filter.fitPreference')}>
            {facets.fits.map((entry) => (
              <Chip
                key={entry.value}
                selected={selected('fit').includes(entry.value)}
                count={entry.count}
                onClick={() => toggle('fit', entry.value)}
              >
                {t(`fit.preference.${entry.value}`)}
              </Chip>
            ))}
          </FilterGroup>
        )}
      </div>
    </Sheet>
  );
}

function FilterGroup({
  title,
  children,
  bare,
}: {
  title: string;
  children: React.ReactNode;
  bare?: boolean;
}) {
  return (
    <div>
      <h3 className="t-eyebrow mb-2.5">{title}</h3>
      {bare ? children : <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}
