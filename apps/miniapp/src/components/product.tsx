'use client';

/**
 * Product presentation — spec BUY-004 (the card) and §5.4 (imagery).
 *
 * Two shapes only: a tall editorial card for grids and rails, and a compact row
 * for the cart, orders and returns. A marketplace that invents a third card
 * shape per screen stops reading as one shop.
 *
 * The image is a 3:4 portrait on a tinted field, because garments are
 * photographed standing up and a square crop cuts a hem off. The brand name
 * leads, the product title follows: in a multi-brand catalogue the brand is the
 * thing the shopper is scanning for.
 */

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { ProductCard as ProductCardDto } from '@fashion/core';
import { API_BASE } from '@/lib/api';
import { track, wishlist } from '@/lib/endpoints';
import { useApp, useT } from '@/lib/app-context';
import { mediaUrl, money, moneyCompact } from '@/lib/format';
import { haptic } from '@/lib/telegram';
import { Badge, HeartIcon, Skeleton, cx } from './ui';

export function ProductImage({
  url,
  alt,
  placeholder,
  className,
  ratio = 'portrait',
  sizes,
  priority,
}: {
  url: string | null | undefined;
  alt: string;
  placeholder?: string | null;
  className?: string;
  ratio?: 'portrait' | 'square' | 'wide';
  sizes?: string;
  priority?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const src = mediaUrl(url, API_BASE);
  const aspect = ratio === 'portrait' ? 'aspect-[3/4]' : ratio === 'square' ? 'aspect-square' : 'aspect-[16/9]';

  return (
    <div
      className={cx('img-field', aspect, className)}
      // The average colour ships with the media record, so a slow image fades
      // in from roughly the right tone instead of a grey rectangle.
      style={placeholder ? { backgroundColor: placeholder } : undefined}
    >
      {src ? (
        // The API serves self-hosted SVG/raster assets of known size; next/image
        // would add a proxy hop for no benefit inside a webview.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          sizes={sizes}
          onLoad={() => setLoaded(true)}
          className={cx('transition-opacity duration-300', loaded ? 'opacity-100' : 'opacity-0')}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-[var(--fg-faint)]">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M8 3.5 5 5v6l2 .6V20h10v-8.4l2-.6V5l-3-1.5-2 2h-4z" />
          </svg>
        </div>
      )}
    </div>
  );
}

export function WishlistButton({
  productId,
  initial,
  className,
}: {
  productId: string;
  initial: boolean;
  className?: string;
}) {
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();
  const t = useT();

  const toggle = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      setBusy(true);
      const next = !saved;
      setSaved(next); // optimistic: the heart must answer the tap immediately
      haptic.tap(next ? 'medium' : 'light');
      try {
        if (next) {
          await wishlist.add(productId);
          track('wishlist_add', { productId });
        } else {
          await wishlist.remove(productId);
        }
        toast(t(next ? 'wishlist.added' : 'wishlist.removed'), 'success');
      } catch {
        setSaved(!next);
        toast(t('common.error'), 'error');
      } finally {
        setBusy(false);
      }
    },
    [busy, productId, saved, t, toast],
  );

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t(saved ? 'wishlist.added' : 'wishlist.title')}
      aria-pressed={saved}
      className={cx(
        'pressable flex h-8 w-8 items-center justify-center rounded-full',
        'bg-[var(--bg-raised)]/85 backdrop-blur-md',
        saved ? 'text-[var(--accent)]' : 'text-[var(--fg-soft)]',
        className,
      )}
    >
      <HeartIcon size={16} filled={saved} />
    </button>
  );
}

function badgeTone(badge: string) {
  switch (badge) {
    case 'SALE':
      return 'danger' as const;
    case 'NEW':
      return 'dark' as const;
    case 'AI_PICK':
      return 'accent' as const;
    case 'LAST_ITEMS':
      return 'warn' as const;
    default:
      return 'neutral' as const;
  }
}

function badgeLabel(badge: string, locale: string): string {
  const labels: Record<string, Record<string, string>> = {
    NEW: { ru: 'Новое', uz: 'Yangi', en: 'New' },
    SALE: { ru: 'Скидка', uz: 'Chegirma', en: 'Sale' },
    LAST_ITEMS: { ru: 'Мало', uz: 'Kam', en: 'Low' },
    VERIFIED_BRAND: { ru: 'Бренд', uz: 'Brend', en: 'Verified' },
    AI_PICK: { ru: 'Подбор', uz: 'Tanlov', en: 'Pick' },
  };
  return labels[badge]?.[locale] ?? labels[badge]?.ru ?? badge;
}

export function ProductTile({
  product,
  width,
  priority,
  compactPrice,
  showWishlist = true,
}: {
  product: ProductCardDto;
  /** Set for a rail; a grid lets the column define the width. */
  width?: number;
  priority?: boolean;
  compactPrice?: boolean;
  showWishlist?: boolean;
}) {
  const { locale } = useApp();
  const t = useT();
  const main = product.media[0];
  const shownBadges = product.badges.filter((badge) => badge !== 'VERIFIED_BRAND').slice(0, 1);

  return (
    <Link
      href={`/p/${product.slug}`}
      onClick={() => haptic.tap('light')}
      className="pressable group block"
      style={width ? { width } : undefined}
    >
      <div className="relative overflow-hidden rounded-[var(--radius-md)]">
        <ProductImage
          url={main?.url}
          alt={main?.alt || `${product.brand.name} — ${product.title}`}
          placeholder={main?.placeholder}
          priority={priority}
          sizes={width ? `${width}px` : '(max-width: 640px) 50vw, 240px'}
        />
        {shownBadges.length > 0 && (
          <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
            {shownBadges.map((badge) => (
              <Badge key={badge} tone={badgeTone(badge)}>
                {badge === 'SALE' && product.discountPercent
                  ? `−${product.discountPercent}%`
                  : badgeLabel(badge, locale)}
              </Badge>
            ))}
          </div>
        )}
        {showWishlist && (
          <WishlistButton
            productId={product.id}
            initial={product.isWishlisted}
            className="absolute right-2 top-2"
          />
        )}
        {!product.inStock && (
          <div className="absolute inset-0 flex items-end bg-[var(--bg)]/55">
            <span className="w-full bg-[var(--bg-raised)]/92 py-1.5 text-center text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
              {t('pdp.outOfStock')}
            </span>
          </div>
        )}
      </div>

      <div className="pt-2.5">
        <p className="truncate text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--fg-muted)]">
          {product.brand.name}
        </p>
        <h3 className="mt-0.5 line-clamp-2 text-[13.5px] leading-[1.32] text-[var(--fg)]">
          {product.title}
        </h3>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="t-price text-[14px]">
            {compactPrice ? moneyCompact(product.price, locale) : money(product.price, locale)}
          </span>
          {product.compareAtPrice && (
            <span className="t-num text-[12px] text-[var(--fg-faint)] line-through">
              {compactPrice
                ? moneyCompact(product.compareAtPrice, locale)
                : money(product.compareAtPrice, locale)}
            </span>
          )}
        </div>
        {product.availableSizes.length > 0 && (
          <p className="mt-1 truncate text-[11.5px] text-[var(--fg-faint)]">
            {product.availableSizes.slice(0, 6).join(' · ')}
            {product.availableSizes.length > 6 ? ' …' : ''}
          </p>
        )}
      </div>
    </Link>
  );
}

/** A compact line, used wherever a product appears inside a list of its own. */
export function ProductLine({
  imageUrl,
  title,
  brandName,
  meta,
  price,
  comparePrice,
  href,
  trailing,
  note,
  children,
}: {
  imageUrl: string | null | undefined;
  title: string;
  brandName?: string;
  meta?: string;
  price?: React.ReactNode;
  comparePrice?: React.ReactNode;
  href?: string;
  trailing?: React.ReactNode;
  note?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <div className="w-[68px] shrink-0 overflow-hidden rounded-[var(--radius-sm)]">
        <ProductImage url={imageUrl} alt={title} sizes="68px" />
      </div>
      <div className="min-w-0 flex-1">
        {brandName && (
          <p className="truncate text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[var(--fg-muted)]">
            {brandName}
          </p>
        )}
        <h4 className="line-clamp-2 text-[13.5px] leading-snug">{title}</h4>
        {meta && <p className="mt-0.5 truncate text-[12px] text-[var(--fg-faint)]">{meta}</p>}
        {(price || comparePrice) && (
          <p className="mt-1 flex items-baseline gap-2">
            {price && <span className="t-price text-[13.5px]">{price}</span>}
            {comparePrice && (
              <span className="t-num text-[11.5px] text-[var(--fg-faint)] line-through">{comparePrice}</span>
            )}
          </p>
        )}
        {note}
        {children}
      </div>
      {trailing && <div className="shrink-0 self-center">{trailing}</div>}
    </>
  );

  if (href) {
    return (
      <Link href={href} onClick={() => haptic.tap('light')} className="pressable flex gap-3">
        {body}
      </Link>
    );
  }
  return <div className="flex gap-3">{body}</div>;
}

/* ── Grids and rails ────────────────────────────────────────────────────── */

export function ProductGrid({
  products,
  priorityCount = 4,
}: {
  products: ProductCardDto[];
  priorityCount?: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-6">
      {products.map((product, index) => (
        <ProductTile key={product.id} product={product} priority={index < priorityCount} />
      ))}
    </div>
  );
}

export function ProductRail({ products }: { products: ProductCardDto[] }) {
  return (
    <div className="rail -mx-4 pb-1">
      {products.map((product, index) => (
        <ProductTile key={product.id} product={product} width={158} priority={index < 2} compactPrice />
      ))}
    </div>
  );
}

export function ProductGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-6">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index}>
          <Skeleton className="aspect-[3/4] w-full" />
          <Skeleton className="mt-2.5 h-2.5 w-1/2" />
          <Skeleton className="mt-2 h-3 w-4/5" />
          <Skeleton className="mt-2 h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

export function RailSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="rail -mx-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} style={{ width: 158 }}>
          <Skeleton className="aspect-[3/4] w-full" />
          <Skeleton className="mt-2.5 h-2.5 w-1/2" />
          <Skeleton className="mt-2 h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}
