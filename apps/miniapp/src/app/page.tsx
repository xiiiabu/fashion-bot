'use client';

/**
 * Home — spec BUY-001/BUY-002 and ADM-009 (the blocks are CMS-driven, so the
 * merchandising team changes the shop without a release).
 *
 * The screen renders whatever block list the API returns, in order. It knows
 * how to draw nine kinds of block and ignores a kind it does not recognise,
 * which is what lets the CMS ship a new rail before the app is updated.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { BrandSummary, CategorySummary, HomeBlock } from '@fashion/core';
import { API_BASE } from '@/lib/api';
import { catalog, trackScreen } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { mediaUrl, money } from '@/lib/format';
import { ProductImage, ProductRail, RailSkeleton } from '@/components/product';
import {
  Badge,
  Button,
  ChevronIcon,
  ErrorState,
  SearchIcon,
  Section,
  Skeleton,
  SparkleIcon,
  cx,
} from '@/components/ui';
import { haptic, hideBackButton } from '@/lib/telegram';

export default function HomePage() {
  const { locale, user } = useApp();
  const t = useT();
  const [blocks, setBlocks] = useState<HomeBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await catalog.home();
      setBlocks(data.blocks);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [locale]);

  useEffect(() => {
    // Home is a tab root, so Telegram's back button must not linger here from a
    // previous screen.
    hideBackButton();
    void load();
    trackScreen('home');
  }, [load]);

  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return t('home.greetingMorning');
    if (hour >= 18) return t('home.greetingEvening');
    return t('home.greeting');
  })();

  return (
    <div className="pb-4">
      <Masthead
        greeting={greeting}
        name={user?.firstName ?? null}
        subtitle={t('home.subtitle')}
      />

      {error && <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />}

      {!blocks && !error && <HomeSkeleton />}

      {blocks?.map((block, index) => (
        <BlockRenderer key={block.id} block={block} index={index} />
      ))}

      {blocks && blocks.length === 0 && !error && <StylistPitch />}
    </div>
  );
}

function Masthead({
  greeting,
  name,
  subtitle,
}: {
  greeting: string;
  name: string | null;
  subtitle: string;
}) {
  const t = useT();
  return (
    <header className="px-4 pb-1 pt-3" style={{ paddingTop: 'calc(var(--safe-top) + 12px)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="t-eyebrow">
            {greeting}
            {name ? `, ${name}` : ''}
          </p>
          <h1
            className="mt-1 text-[1.75rem] leading-[1.05] tracking-[-0.028em]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Atlas
          </h1>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">{subtitle}</p>
        </div>
      </div>

      <Link
        href="/search"
        onClick={() => haptic.tap('light')}
        className="pressable mt-4 flex h-11 items-center gap-2.5 rounded-full border border-[var(--line)] bg-[var(--bg-raised)] px-4 text-[14px] text-[var(--fg-faint)]"
      >
        <SearchIcon size={17} />
        {t('search.placeholder')}
      </Link>
    </header>
  );
}

function BlockRenderer({ block, index }: { block: HomeBlock; index: number }) {
  switch (block.kind) {
    case 'HERO':
      return <HeroBlock block={block} priority={index === 0} />;
    case 'BANNER':
      return <BannerBlock block={block} />;
    case 'PRODUCT_RAIL':
    case 'SALE_RAIL':
      return <RailBlock block={block} />;
    case 'BRAND_RAIL':
      return <BrandRailBlock block={block} />;
    case 'CATEGORY_GRID':
      return <CategoryGridBlock block={block} />;
    case 'LOOK_RAIL':
      return <LookRailBlock block={block} />;
    case 'EDITORIAL':
      return <EditorialBlock block={block} />;
    case 'AI_PROMPT':
      return <StylistPitch prompts={block.prompts} title={block.title} subtitle={block.subtitle} />;
    default:
      // A CMS block this build does not know about is skipped, not crashed on.
      return null;
  }
}

/* ── Hero ────────────────────────────────────────────────────────────────── */

function HeroBlock({ block, priority }: { block: HomeBlock; priority: boolean }) {
  const t = useT();
  const href = block.ctaHref || '/search';
  return (
    <section className="px-4 pt-4">
      <Link
        href={href}
        onClick={() => haptic.tap('light')}
        className="pressable relative block overflow-hidden rounded-[var(--radius-lg)]"
      >
        <ProductImage
          url={block.imageUrl}
          alt={block.title ?? ''}
          ratio="portrait"
          priority={priority}
          className="aspect-[4/5]"
          sizes="100vw"
        />
        {/* A single bottom-up scrim, not a decorative gradient: it exists so the
            type below stays legible over any photograph. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to top, rgb(16 13 11 / 0.82) 0%, rgb(16 13 11 / 0.3) 42%, transparent 72%)',
          }}
        />
        <div className="absolute inset-x-0 bottom-0 p-5">
          {block.subtitle && (
            <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-white/72">
              {block.subtitle}
            </p>
          )}
          {block.title && (
            <h2 className="t-display max-w-[20ch] text-[1.95rem] text-white">{block.title}</h2>
          )}
          <span className="mt-3.5 inline-flex h-10 items-center gap-1.5 rounded-full bg-white px-4 text-[13.5px] font-semibold text-[#16130f]">
            {block.ctaLabel || t('home.viewAll')}
            <ChevronIcon size={15} />
          </span>
        </div>
      </Link>
    </section>
  );
}

function BannerBlock({ block }: { block: HomeBlock }) {
  const t = useT();
  return (
    <section className="px-4 pt-5">
      <Link
        href={block.ctaHref || '/search'}
        onClick={() => haptic.tap('light')}
        className="pressable relative block overflow-hidden rounded-[var(--radius-lg)]"
      >
        <ProductImage
          url={block.imageUrl}
          alt={block.title ?? ''}
          ratio="wide"
          className="aspect-[2/1]"
          sizes="100vw"
        />
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to right, rgb(16 13 11 / 0.72), transparent 78%)' }}
        />
        <div className="absolute inset-y-0 left-0 flex max-w-[64%] flex-col justify-center p-5">
          {block.title && <h3 className="t-display text-[1.3rem] text-white">{block.title}</h3>}
          {block.subtitle && <p className="mt-1 text-[12.5px] text-white/78">{block.subtitle}</p>}
          {block.ctaLabel && (
            <span className="mt-2.5 text-[12.5px] font-semibold text-white underline decoration-white/45 underline-offset-4">
              {block.ctaLabel || t('home.viewAll')}
            </span>
          )}
        </div>
      </Link>
    </section>
  );
}

/* ── Rails ───────────────────────────────────────────────────────────────── */

function RailBlock({ block }: { block: HomeBlock }) {
  const t = useT();
  if (!block.products?.length) return null;
  return (
    <Section
      flush
      eyebrow={block.subtitle ?? undefined}
      title={block.title ?? t('home.newIn')}
      action={
        block.ctaHref ? (
          <Link
            href={block.ctaHref}
            onClick={() => haptic.tap('light')}
            className="text-[12.5px] font-medium text-[var(--fg-muted)]"
          >
            {block.ctaLabel || t('home.viewAll')}
          </Link>
        ) : undefined
      }
    >
      <div className="px-4">
        <ProductRail products={block.products} />
      </div>
    </Section>
  );
}

function BrandRailBlock({ block }: { block: HomeBlock }) {
  const t = useT();
  if (!block.brands?.length) return null;
  return (
    <Section
      flush
      title={block.title ?? t('home.brands')}
      action={
        <Link href="/brands" onClick={() => haptic.tap('light')} className="text-[12.5px] font-medium text-[var(--fg-muted)]">
          {t('home.viewAll')}
        </Link>
      }
    >
      <div className="rail">
        {block.brands.map((brand) => (
          <BrandCard key={brand.id} brand={brand} />
        ))}
      </div>
    </Section>
  );
}

function BrandCard({ brand }: { brand: BrandSummary }) {
  const logo = mediaUrl(brand.logoUrl, API_BASE);
  return (
    <Link
      href={`/brands/${brand.slug}`}
      onClick={() => haptic.tap('light')}
      className="pressable flex w-[112px] flex-col items-center gap-2 text-center"
    >
      <div className="flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-full border border-[var(--line)] bg-[var(--bg-raised)]">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt={brand.name} className="h-full w-full object-contain p-2.5" loading="lazy" />
        ) : (
          <span className="t-display text-[1.25rem] text-[var(--fg-muted)]">{brand.name.charAt(0)}</span>
        )}
      </div>
      <span className="line-clamp-2 text-[12px] font-medium leading-tight">{brand.name}</span>
      {brand.productCount !== undefined && (
        <span className="t-num -mt-1 text-[11px] text-[var(--fg-faint)]">{brand.productCount}</span>
      )}
    </Link>
  );
}

function CategoryGridBlock({ block }: { block: HomeBlock }) {
  const t = useT();
  if (!block.categories?.length) return null;
  return (
    <Section title={block.title ?? t('home.categories')}>
      <div className="grid grid-cols-2 gap-3">
        {block.categories.slice(0, 6).map((category) => (
          <CategoryCard key={category.id} category={category} />
        ))}
      </div>
    </Section>
  );
}

function CategoryCard({ category }: { category: CategorySummary }) {
  return (
    <Link
      href={`/search?category=${encodeURIComponent(category.slug)}`}
      onClick={() => haptic.tap('light')}
      className="pressable relative block overflow-hidden rounded-[var(--radius-md)]"
    >
      <ProductImage
        url={category.imageUrl}
        alt={category.name}
        ratio="square"
        className="aspect-[5/4]"
        sizes="50vw"
      />
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to top, rgb(16 13 11 / 0.62), transparent 62%)' }}
      />
      <div className="absolute inset-x-0 bottom-0 p-3">
        <p className="text-[13.5px] font-semibold text-white">{category.name}</p>
        {category.productCount !== undefined && (
          <p className="t-num text-[11px] text-white/70">{category.productCount}</p>
        )}
      </div>
    </Link>
  );
}

function LookRailBlock({ block }: { block: HomeBlock }) {
  const { locale } = useApp();
  const t = useT();
  if (!block.looks?.length) return null;
  return (
    <Section
      flush
      title={block.title ?? t('home.looks')}
      eyebrow={block.subtitle ?? undefined}
      action={
        <Link href="/looks" onClick={() => haptic.tap('light')} className="text-[12.5px] font-medium text-[var(--fg-muted)]">
          {t('home.viewAll')}
        </Link>
      }
    >
      <div className="rail">
        {block.looks.map((look) => (
          <Link
            key={look.id}
            href={`/looks/${look.id}`}
            onClick={() => haptic.tap('light')}
            className="pressable w-[232px]"
          >
            <div className="relative overflow-hidden rounded-[var(--radius-md)]">
              {/* A look is several garments, so the card shows the garments
                  rather than one hero image the merchandiser had to shoot. */}
              <div className="grid aspect-[4/5] grid-cols-2 gap-px bg-[var(--line-soft)]">
                {look.products.slice(0, 4).map((product) => (
                  <div key={product.id} className="img-field">
                    <ProductImage
                      url={product.media[0]?.url}
                      alt={product.title}
                      ratio="square"
                      className="h-full"
                      sizes="116px"
                    />
                  </div>
                ))}
              </div>
              <div className="absolute left-2 top-2">
                <Badge tone="dark">{look.itemCount}</Badge>
              </div>
            </div>
            <p className="mt-2 line-clamp-1 text-[13.5px] font-medium">{look.title}</p>
            <p className="t-price mt-0.5 text-[13px] text-[var(--fg-muted)]">{money(look.total, locale)}</p>
          </Link>
        ))}
      </div>
    </Section>
  );
}

function EditorialBlock({ block }: { block: HomeBlock }) {
  return (
    <Section>
      <div className="rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-5">
        {block.subtitle && <p className="t-eyebrow mb-2">{block.subtitle}</p>}
        {block.title && <h3 className="t-section max-w-[26ch]">{block.title}</h3>}
        {block.ctaHref && (
          <Link
            href={block.ctaHref}
            onClick={() => haptic.tap('light')}
            className="mt-3.5 inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--accent)]"
          >
            {block.ctaLabel}
            <ChevronIcon size={14} />
          </Link>
        )}
      </div>
    </Section>
  );
}

/* ── Stylist pitch ───────────────────────────────────────────────────────── */

function StylistPitch({
  prompts,
  title,
  subtitle,
}: {
  prompts?: string[];
  title?: string | null;
  subtitle?: string | null;
}) {
  const t = useT();
  return (
    <Section flush>
      <div className="mx-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--accent-soft)] p-5">
        <div className="flex items-center gap-2 text-[var(--accent-deep)]">
          <SparkleIcon size={17} />
          <span className="t-eyebrow text-[var(--accent-deep)]">{t('ai.title')}</span>
        </div>
        <h3 className="t-section mt-2.5 max-w-[24ch]">{title || t('home.askStylist')}</h3>
        <p className="mt-1.5 max-w-[34ch] text-[13.5px] leading-relaxed text-[var(--fg-soft)]">
          {subtitle || t('home.stylistPitch')}
        </p>
        <Link href="/stylist" onClick={() => haptic.tap('medium')} className="mt-4 block">
          <Button block>{t('ai.generate')}</Button>
        </Link>
      </div>
      {prompts && prompts.length > 0 && (
        <div className="rail mt-3">
          {prompts.slice(0, 6).map((prompt) => (
            <Link
              key={prompt}
              href={`/stylist?q=${encodeURIComponent(prompt)}`}
              onClick={() => haptic.tap('light')}
              className={cx(
                'pressable max-w-[70vw] shrink-0 rounded-full border border-[var(--line)]',
                'bg-[var(--bg-raised)] px-3.5 py-2 text-[12.5px] text-[var(--fg-soft)]',
              )}
            >
              {prompt}
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}

function HomeSkeleton() {
  return (
    <div className="px-4 pt-4">
      <Skeleton className="aspect-[4/5] w-full rounded-[var(--radius-lg)]" />
      <div className="pt-7">
        <Skeleton className="h-4 w-36" />
        <div className="pt-3.5">
          <RailSkeleton />
        </div>
      </div>
      <div className="pt-7">
        <Skeleton className="h-4 w-28" />
        <div className="pt-3.5">
          <RailSkeleton />
        </div>
      </div>
    </div>
  );
}
