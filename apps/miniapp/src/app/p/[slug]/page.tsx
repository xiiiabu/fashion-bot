'use client';

/**
 * Product detail — spec BUY-005, CAT-003 (the chart and the measurements are
 * shown verbatim), FIT-003/FIT-004 (size recommendation with confidence and
 * reason, never blocking manual choice) and CAT-008 (stock is per SKU).
 *
 * The size selector is the whole screen's hinge. Three rules it obeys:
 *  - a size that cannot be bought is visibly unbuyable, not merely absent;
 *  - the recommendation is a suggestion shown next to the sizes, never a
 *    pre-selection that decides for the shopper (FIT-003);
 *  - the add-to-cart action states which size it will add.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { FitRecommendation, ProductDetail, SkuDetail } from '@fashion/core';
import { MEASUREMENT_KEYS, sortSizes } from '@fashion/core';
import { catalog, cart as cartApi, fit as fitApi, track, wishlist } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import {
  deliveryRange,
  mmToCm,
  money,
  percent,
} from '@/lib/format';
import { ProductImage, ProductRail, WishlistButton } from '@/components/product';
import { BottomBar, BottomBarSpacer, ScreenHeader, useBackButton } from '@/components/shell';
import {
  Badge,
  Button,
  Collapsible,
  ErrorState,
  HeartIcon,
  IconButton,
  LoadingScreen,
  Note,
  RulerIcon,
  Section,
  Sheet,
  ShieldIcon,
  Stars,
  StoreIcon,
  TruckIcon,
  cx,
} from '@/components/ui';
import {
  fitVerdictLabel,
  formalityLabel,
  occasionLabel,
  seasonLabel,
  silhouetteLabel,
  styleLabel,
  warmthLabel,
} from '@/lib/taxonomy-labels';
import { haptic } from '@/lib/telegram';

export default function ProductPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const { locale, refreshCartCount, toast } = useApp();
  const t = useT();
  useBackButton();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkuId, setSelectedSkuId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [fitOpen, setFitOpen] = useState(false);
  const [gallery, setGallery] = useState(0);
  const [communityFit, setCommunityFit] = useState<CommunityFit | null>(null);
  const [recommendation, setRecommendation] = useState<FitRecommendation | null>(null);

  const slug = params.slug;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setProduct(null);
    catalog
      .product(slug)
      .then((data) => {
        if (cancelled) return;
        setProduct(data);
        setRecommendation(data.fit);
        track('product_view', { productId: data.id, brandId: data.brand.id });
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught, locale));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, locale]);

  /**
   * The recommendation ships with the PDP, but the community fit signal is a
   * separate read so a slow aggregate never delays the page.
   */
  useEffect(() => {
    if (!product) return;
    let cancelled = false;
    fitApi
      .recommendation(product.id)
      .then((data) => {
        if (cancelled) return;
        setCommunityFit(data.communitySignal);
        if (data.recommendation) {
          setRecommendation(data.recommendation);
          // ANL-005: whether a recommendation was shown, and how confident it
          // was, is what makes the fit engine's effect measurable.
          track('fit_recommendation_shown', {
            productId: product.id,
            confident: data.recommendation.confident,
            hasSize: data.recommendation.recommendedSize !== null,
            chartOnly: data.recommendation.chartOnly,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [product]);

  const sizes = useMemo(
    () => (product ? sortSizes(product.skus.map((sku) => ({ ...sku }))) : []),
    [product],
  );
  const selected = sizes.find((sku) => sku.id === selectedSkuId) ?? null;
  const anyAvailable = sizes.some((sku) => sku.available > 0);

  const addToCart = useCallback(async () => {
    if (!product) return;
    if (!selected) {
      // Do not silently pick a size for the shopper; point at the selector.
      haptic.warning();
      toast(t('pdp.chooseSizeFirst'), 'error');
      document.getElementById('size-selector')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setAdding(true);
    try {
      await cartApi.addItem({
        skuId: selected.id,
        quantity: 1,
        fitConfidence: recommendation?.confident ? recommendation.confidence : null,
      });
      await refreshCartCount();
      setAdded(true);
      haptic.success();
      toast(t('pdp.addedToCart'), 'success');
      track('add_to_cart', { productId: product.id, skuId: selected.id, size: selected.sizeLabel });
      window.setTimeout(() => setAdded(false), 2200);
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setAdding(false);
    }
  }, [product, selected, recommendation, refreshCartCount, toast, t, locale]);

  const notifyBackInStock = useCallback(
    async (sku: SkuDetail) => {
      try {
        await wishlist.subscribeStock(sku.id);
        toast(t('pdp.notifyMeDone'), 'success');
      } catch (caught) {
        toast(errorMessage(caught, locale), 'error');
      }
    },
    [toast, t, locale],
  );

  if (error) {
    return (
      <div>
        <ScreenHeader back title="" />
        <ErrorState message={error} onRetry={() => router.refresh()} retryLabel={t('common.retry')} />
      </div>
    );
  }

  if (!product) {
    return (
      <div>
        <ScreenHeader back title="" />
        <LoadingScreen />
      </div>
    );
  }

  const media = product.media.length > 0 ? product.media : [];

  return (
    <div>
      {/* The gallery is the header: a PDP that opens with a toolbar instead of
          the garment wastes the only screen that sells. */}
      <div className="relative">
        <div
          className="rail snap-x snap-mandatory !px-0 !gap-0"
          onScroll={(event) => {
            const node = event.currentTarget;
            const index = Math.round(node.scrollLeft / node.clientWidth);
            if (index !== gallery) setGallery(index);
          }}
        >
          {(media.length > 0 ? media : [null]).map((item, index) => (
            <div key={item?.id ?? index} className="w-full shrink-0 snap-center">
              <ProductImage
                url={item?.url}
                alt={item?.alt || product.title}
                placeholder={item?.placeholder}
                priority={index === 0}
                className="aspect-[3/4]"
                sizes="100vw"
              />
            </div>
          ))}
        </div>

        <div
          className="absolute inset-x-0 top-0 flex items-start justify-between p-3"
          style={{ paddingTop: 'calc(var(--safe-top) + 12px)' }}
        >
          <IconButton label={t('common.back')} onClick={() => router.back()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </IconButton>
          <WishlistButton
            productId={product.id}
            initial={product.isWishlisted}
            className="h-10 w-10"
          />
        </div>

        {media.length > 1 && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
            {media.map((item, index) => (
              <span
                key={item.id}
                className={cx(
                  'h-1.5 rounded-full transition-all duration-200',
                  index === gallery ? 'w-5 bg-[var(--fg)]' : 'w-1.5 bg-[var(--fg)]/28',
                )}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Identity and price ─────────────────────────────────────────── */}
      <div className="px-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <Link
            href={`/brands/${product.brand.slug}`}
            onClick={() => haptic.tap('light')}
            className="min-w-0"
          >
            <p className="flex items-center gap-1.5 truncate text-[11.5px] font-semibold uppercase tracking-[0.11em] text-[var(--fg-muted)]">
              {product.brand.name}
              {product.brand.verified && <ShieldIcon size={12} className="text-[var(--accent)]" />}
            </p>
          </Link>
          {product.rating && product.rating.count > 0 && (
            <div className="flex shrink-0 items-center gap-1.5">
              <Stars value={product.rating.average} />
              <span className="t-num text-[12px] text-[var(--fg-faint)]">{product.rating.count}</span>
            </div>
          )}
        </div>

        <h1 className="t-title mt-1.5">{product.title}</h1>

        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="t-price text-[20px]">{money(product.price, locale)}</span>
          {product.compareAtPrice && (
            <>
              <span className="t-num text-[14px] text-[var(--fg-faint)] line-through">
                {money(product.compareAtPrice, locale)}
              </span>
              {product.discountPercent && (
                <Badge tone="danger">−{product.discountPercent}%</Badge>
              )}
            </>
          )}
        </div>

        <p className="mt-1.5 text-[12.5px] text-[var(--fg-faint)]">
          {product.colorName}
          {product.silhouette ? ` · ${silhouetteLabel(product.silhouette, locale)}` : ''}
        </p>
      </div>

      {/* ── Size ───────────────────────────────────────────────────────── */}
      <section id="size-selector" className="px-4 pt-6">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="t-eyebrow">{t('pdp.size')}</h2>
          {product.sizeChart && (
            <button
              type="button"
              onClick={() => {
                haptic.tap('light');
                setChartOpen(true);
                track('size_chart_opened', { productId: product.id });
              }}
              className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--fg-muted)] underline decoration-[var(--line)] underline-offset-2"
            >
              <RulerIcon size={14} />
              {t('pdp.sizeChart')}
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {sizes.map((sku) => {
            const soldOut = sku.available <= 0;
            const isSelected = sku.id === selectedSkuId;
            const isRecommended = recommendation?.recommendedSize === sku.sizeLabel;
            return (
              <button
                key={sku.id}
                type="button"
                onClick={() => {
                  haptic.select();
                  if (soldOut) {
                    void notifyBackInStock(sku);
                    return;
                  }
                  setSelectedSkuId(sku.id);
                  track('size_selected', {
                    productId: product.id,
                    skuId: sku.id,
                    size: sku.sizeLabel,
                    matchedRecommendation: isRecommended,
                  });
                }}
                aria-pressed={isSelected}
                // A sold-out size stays tappable on purpose — the tap
                // subscribes to the restock — so `disabled` would be wrong.
                // This states availability explicitly for assistive tech and
                // for the UI acceptance suite, which otherwise cannot tell a
                // buyable size from one that only offers an alert.
                data-stock={soldOut ? 'out' : 'in'}
                data-size={sku.sizeLabel}
                aria-label={
                  soldOut ? `${sku.sizeLabel} — ${t('pdp.outOfStock')}` : sku.sizeLabel
                }
                className={cx(
                  'pressable relative h-12 min-w-[52px] rounded-[var(--radius-md)] border px-3.5 text-[14px] font-medium',
                  isSelected
                    ? 'border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)]'
                    : soldOut
                      ? 'border-[var(--line-soft)] text-[var(--fg-faint)]'
                      : 'border-[var(--line)] bg-[var(--bg-raised)]',
                  // CAT-008: a sold-out size stays visible and struck through, so
                  // the shopper knows it exists in this product and can subscribe.
                  soldOut && 'line-through decoration-[1.5px]',
                )}
              >
                {sku.sizeLabel}
                {isRecommended && !isSelected && !soldOut && (
                  <span
                    className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[var(--accent)]"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>

        {selected && selected.lowStock && selected.available > 0 && (
          <p className="mt-2.5 text-[12.5px] font-medium text-warn">
            {t('pdp.onlyLeft', { n: selected.available })}
          </p>
        )}

        {!anyAvailable && (
          <div className="mt-3">
            <Note tone="neutral">{t('pdp.outOfStock')}</Note>
          </div>
        )}

        <FitPanel
          recommendation={recommendation}
          communityFit={communityFit}
          onOpen={() => setFitOpen(true)}
        />
      </section>

      {/* ── Delivery & returns ─────────────────────────────────────────── */}
      <Section>
        <div className="space-y-3 rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-4">
          {product.delivery.length > 0 ? (
            product.delivery.map((option) => (
              <div key={option.methodCode} className="flex items-start gap-3">
                <TruckIcon size={17} className="mt-0.5 shrink-0 text-[var(--fg-muted)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium">{option.name}</p>
                  <p className="text-[12.5px] text-[var(--fg-muted)]">
                    {deliveryRange(option.minDays, option.maxDays, locale)}
                    {option.zoneName ? ` · ${option.zoneName}` : ''}
                  </p>
                </div>
                <span className="t-price shrink-0 text-[13px]">{money(option.price, locale)}</span>
              </div>
            ))
          ) : (
            <div className="flex items-center gap-3">
              <TruckIcon size={17} className="shrink-0 text-[var(--fg-muted)]" />
              <p className="text-[13.5px]">{t('pdp.handlingDays', { n: product.seller.handlingDays })}</p>
            </div>
          )}

          <div className="h-px bg-[var(--line-soft)]" />

          <div className="flex items-start gap-3">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="mt-0.5 shrink-0 text-[var(--fg-muted)]" strokeLinecap="round">
              <path d="M4 10h11a4.5 4.5 0 1 1 0 9h-3M8 6l-4 4 4 4" />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium">
                {t('pdp.returnWindow', { n: product.returnPolicy.windowDays })}
              </p>
              <p className="text-[12.5px] leading-snug text-[var(--fg-muted)]">
                {product.returnPolicy.conditions}
              </p>
            </div>
          </div>

          <div className="h-px bg-[var(--line-soft)]" />

          <Link href={`/search?seller=${product.seller.id}`} className="flex items-center gap-3">
            <StoreIcon size={17} className="shrink-0 text-[var(--fg-muted)]" />
            <div className="min-w-0 flex-1">
              <p className="t-label">{t('pdp.soldBy')}</p>
              <p className="truncate text-[13.5px] font-medium">
                {product.seller.displayName}
                {product.seller.verified && ' ✓'}
              </p>
            </div>
          </Link>
        </div>
      </Section>

      {/* ── Details ────────────────────────────────────────────────────── */}
      <Section>
        <div className="border-t border-[var(--line)]">
          {product.description && (
            <Collapsible title={t('pdp.description')} defaultOpen>
              <p className="whitespace-pre-line">{product.description}</p>
            </Collapsible>
          )}

          {(product.composition || product.materials.length > 0) && (
            <Collapsible title={t('pdp.composition')}>
              {product.composition && <p>{product.composition}</p>}
              {product.materials.length > 0 && (
                <p className="mt-1.5 text-[var(--fg-muted)]">{product.materials.join(' · ')}</p>
              )}
            </Collapsible>
          )}

          {product.care && (
            <Collapsible title={t('pdp.care')}>
              <p className="whitespace-pre-line">{product.care}</p>
            </Collapsible>
          )}

          <Collapsible title={t('pdp.details')}>
            <dl className="space-y-2">
              <Spec label={t('filter.style')} value={product.styleTags.map((tag) => styleLabel(tag, locale)).join(', ')} />
              <Spec label={t('filter.occasion')} value={product.occasions.map((o) => occasionLabel(o, locale)).join(', ')} />
              <Spec label={t('filter.season')} value={seasonLabel(product.season, locale)} />
              <Spec label={t('pdp.formality')} value={formalityLabel(product.formality, locale)} />
              <Spec label={t('pdp.warmth')} value={warmthLabel(product.warmth, locale)} />
              <Spec label={t('pdp.countryOfOrigin')} value={product.countryOfOrigin} />
              {product.authenticity && <Spec label={t('pdp.authenticity')} value={product.authenticity} />}
            </dl>
          </Collapsible>

          {/* CAT-003: the brand's own measurements, verbatim, in centimetres. */}
          {selected?.measurements && Object.keys(selected.measurements).length > 0 && (
            <Collapsible title={`${t('pdp.measurements')} · ${selected.sizeLabel}`}>
              <dl className="space-y-2">
                {MEASUREMENT_KEYS.filter((key) => selected.measurements?.[key] !== undefined).map((key) => (
                  <Spec
                    key={key}
                    label={t(`fit.${key}`)}
                    value={`${mmToCm(selected.measurements![key])} ${t('fit.cm')}`}
                  />
                ))}
              </dl>
              {product.fitNotes && (
                <p className="mt-3 text-[12.5px] text-[var(--fg-muted)]">{product.fitNotes}</p>
              )}
            </Collapsible>
          )}
        </div>
      </Section>

      {/* ── Complete the look / related ───────────────────────────────── */}
      {product.completeTheLook.length > 0 && (
        <Section flush title={t('pdp.completeLook')}>
          <div className="px-4">
            <ProductRail products={product.completeTheLook} />
          </div>
        </Section>
      )}

      <BottomBarSpacer height={82} />

      <BottomBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="t-price text-[16px]">{money(selected?.price ?? product.price, locale)}</p>
            <p className="truncate text-[11.5px] text-[var(--fg-faint)]">
              {selected ? `${t('pdp.size')} ${selected.sizeLabel}` : t('pdp.selectSize')}
            </p>
          </div>
          <Button
            size="lg"
            className="min-w-[56%]"
            disabled={!anyAvailable}
            loading={adding}
            onClick={addToCart}
            icon={added ? <CheckMark /> : undefined}
          >
            {!anyAvailable ? t('pdp.outOfStock') : added ? t('pdp.addedToCart') : t('pdp.addToCart')}
          </Button>
        </div>
      </BottomBar>

      {/* ── Sheets ─────────────────────────────────────────────────────── */}
      <SizeChartSheet open={chartOpen} onClose={() => setChartOpen(false)} product={product} />
      <FitExplanationSheet
        open={fitOpen}
        onClose={() => setFitOpen(false)}
        recommendation={recommendation}
        communityFit={communityFit}
      />
    </div>
  );
}

function CheckMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Spec({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <dt className="w-[42%] shrink-0 text-[13px] text-[var(--fg-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13px]">{value}</dd>
    </div>
  );
}

/* ── Fit ─────────────────────────────────────────────────────────────────── */

/**
 * FIT-003 and FIT-004 in one component. There are three honest states:
 *  - a confident recommendation: show the size and why;
 *  - an answer we are not confident in: show it, say so, offer what would help;
 *  - no basis at all: offer the chart and ask for nothing.
 */
/** FIT-005: the aggregated verdict plus the split behind it. */
interface CommunityFit {
  verdict: string;
  sampleSize: number;
  shares: { runsSmall: number; runsTrue: number; runsLarge: number };
}

/** The share of reports backing the headline verdict, 0..1. */
function dominantShare(signal: CommunityFit): number | null {
  const { runsSmall, runsTrue, runsLarge } = signal.shares;
  switch (signal.verdict) {
    case 'runs_small':
      return runsSmall;
    case 'runs_large':
      return runsLarge;
    case 'true_to_size':
      return runsTrue;
    default:
      return null;
  }
}

function FitPanel({
  recommendation,
  communityFit,
  onOpen,
}: {
  recommendation: FitRecommendation | null;
  communityFit: CommunityFit | null;
  onOpen: () => void;
}) {
  const { locale } = useApp();
  const t = useT();

  const hasCommunitySignal =
    communityFit && communityFit.verdict !== 'unknown' && communityFit.sampleSize >= 5;

  if (!recommendation || (!recommendation.recommendedSize && !hasCommunitySignal)) {
    if (!recommendation?.chartOnly && !hasCommunitySignal) return null;
    return (
      <button
        type="button"
        onClick={onOpen}
        className="mt-3.5 flex w-full items-center gap-3 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] p-3.5 text-left"
      >
        <RulerIcon size={17} className="shrink-0 text-[var(--fg-muted)]" />
        <span className="min-w-0 flex-1 text-[13px] text-[var(--fg-soft)]">{t('pdp.improveFit')}</span>
        <span className="shrink-0 text-[var(--fg-faint)]">›</span>
      </button>
    );
  }

  const confident = recommendation.confident && recommendation.recommendedSize;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        'mt-3.5 flex w-full items-start gap-3 rounded-[var(--radius-md)] p-3.5 text-left',
        confident ? 'bg-[var(--accent-soft)]' : 'bg-[var(--bg-sunken)]',
      )}
    >
      <RulerIcon
        size={17}
        className={cx('mt-0.5 shrink-0', confident ? 'text-[var(--accent-deep)]' : 'text-[var(--fg-muted)]')}
      />
      <div className="min-w-0 flex-1">
        {recommendation.recommendedSize && (
          <p className="text-[13.5px] font-semibold">
            {t('pdp.yourSize')}: {recommendation.recommendedSize}
            {!confident && (
              <span className="ml-1.5 font-normal text-[var(--fg-muted)]">
                · {percent(recommendation.confidence, locale)}
              </span>
            )}
          </p>
        )}
        <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--fg-soft)]">
          {t(recommendation.explanation)}
        </p>
        {hasCommunitySignal && (
          <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
            {fitVerdictLabel(communityFit.verdict, locale)}
            {(() => {
              const share = dominantShare(communityFit);
              return share !== null ? ` · ${percent(share, locale)}` : '';
            })()}
            {` · ${communityFit.sampleSize}`}
          </p>
        )}
      </div>
      <span className="shrink-0 text-[var(--fg-faint)]">›</span>
    </button>
  );
}

function FitExplanationSheet({
  open,
  onClose,
  recommendation,
  communityFit,
}: {
  open: boolean;
  onClose: () => void;
  recommendation: FitRecommendation | null;
  communityFit: CommunityFit | null;
}) {
  const { locale } = useApp();
  const t = useT();

  return (
    <Sheet open={open} onClose={onClose} title={t('pdp.whySize')}>
      <div className="space-y-5 pb-2">
        {recommendation?.recommendedSize && (
          <div className="flex items-baseline gap-3">
            <span className="t-display text-[2.6rem] leading-none">{recommendation.recommendedSize}</span>
            <div>
              <p className="text-[13px] font-semibold">
                {recommendation.confident ? t('common.yes') : t('fit.low_confidence')}
              </p>
              <p className="t-num text-[12.5px] text-[var(--fg-muted)]">
                {percent(recommendation.confidence, locale)}
              </p>
            </div>
          </div>
        )}

        {recommendation && <p className="text-[14px] leading-relaxed">{t(recommendation.explanation)}</p>}

        {recommendation && recommendation.reasonCodes.length > 0 && (
          <ul className="space-y-1.5">
            {recommendation.reasonCodes.map((code) => (
              <li key={code} className="flex gap-2 text-[13px] text-[var(--fg-soft)]">
                <span className="text-[var(--accent)]">·</span>
                {reasonText(code, locale)}
              </li>
            ))}
          </ul>
        )}

        {recommendation && recommendation.alternatives.length > 0 && (
          <div>
            <h3 className="t-eyebrow mb-2">{t('ai.alternatives')}</h3>
            <div className="flex flex-wrap gap-2">
              {recommendation.alternatives.map((alt) => (
                <span
                  key={`${alt.sizeLabel}-${alt.note}`}
                  className="rounded-full border border-[var(--line)] px-3 py-1.5 text-[13px]"
                >
                  {alt.sizeLabel}
                  <span className="ml-1.5 text-[var(--fg-faint)]">{altNote(alt.note, locale)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {communityFit && communityFit.verdict !== 'unknown' && communityFit.sampleSize >= 5 && (
          <Note tone="info" title={t('pdp.fitVerdict')}>
            <span className="block font-medium">
              {fitVerdictLabel(communityFit.verdict, locale)}
            </span>
            {/* FIT-005: the split, not just the winner — "60% runs small" and
                "95% runs small" are different pieces of advice. */}
            <span className="mt-1 block">
              {t('orders.fitRunsSmall')} {percent(communityFit.shares.runsSmall, locale)} ·{' '}
              {t('orders.fitTrue')} {percent(communityFit.shares.runsTrue, locale)} ·{' '}
              {t('orders.fitRunsLarge')} {percent(communityFit.shares.runsLarge, locale)}
            </span>
            <span className="mt-0.5 block opacity-70">n = {communityFit.sampleSize}</span>
          </Note>
        )}

        {/* FIT-004: say what would improve the answer, never demand it. */}
        {recommendation && recommendation.improveWith.length > 0 && (
          <div>
            <h3 className="t-eyebrow mb-2">{t('pdp.improveFit')}</h3>
            <Link href="/profile/fit" onClick={onClose}>
              <Button variant="outline" block>
                {t('fit.title')}
              </Button>
            </Link>
          </div>
        )}

        <p className="text-[12px] leading-relaxed text-[var(--fg-faint)]">{t('pdp.fitDisclaimer')}</p>
      </div>
    </Sheet>
  );
}

function reasonText(code: string, locale: string): string {
  const map: Record<string, Record<string, string>> = {
    body_measurements_match: {
      ru: 'Сравнили ваши мерки с замерами изделия',
      uz: 'Oʻlchamlaringizni buyum oʻlchamlari bilan solishtirdik',
      en: 'Your measurements were compared with the garment',
    },
    usual_brand_size: {
      ru: 'Учли ваш обычный размер в этом бренде',
      uz: 'Bu brenddagi odatdagi oʻlchamingiz hisobga olindi',
      en: 'Your usual size in this brand was used',
    },
    height_weight_estimate: {
      ru: 'Оценка по росту и весу — менее точно, чем по меркам',
      uz: 'Boʻy va vazn boʻyicha taxmin — oʻlchamlardan koʻra aniq emas',
      en: 'Estimated from height and weight — less precise than measurements',
    },
    community_feedback_adjusted: {
      ru: 'Покупатели сообщили об особенностях посадки',
      uz: 'Xaridorlar oʻtirish xususiyatini qayd etgan',
      en: 'Shoppers reported how this model fits',
    },
    preferred_fit_applied: {
      ru: 'Применили вашу предпочтительную посадку',
      uz: 'Afzal koʻrgan oʻtirish turi qoʻllanildi',
      en: 'Your preferred fit was applied',
    },
    chart_only_no_profile: {
      ru: 'Показываем только размерную сетку бренда',
      uz: 'Faqat brend oʻlcham jadvalini koʻrsatamiz',
      en: 'Only the brand size chart is shown',
    },
    no_chart_available: {
      ru: 'Бренд не предоставил размерную сетку',
      uz: 'Brend oʻlcham jadvalini bermagan',
      en: 'The brand provided no size chart',
    },
    between_sizes: {
      ru: 'Вы между размерами',
      uz: 'Siz ikki oʻlcham orasidasiz',
      en: 'You sit between two sizes',
    },
    out_of_stock_fallback: {
      ru: 'Рекомендованный размер закончился — показан ближайший',
      uz: 'Tavsiya etilgan oʻlcham tugagan — eng yaqini koʻrsatildi',
      en: 'The recommended size sold out — the nearest one is shown',
    },
  };
  return map[code]?.[locale] ?? map[code]?.ru ?? code;
}

function altNote(note: string, locale: string): string {
  const map: Record<string, Record<string, string>> = {
    tighter: { ru: 'плотнее', uz: 'tigʻizroq', en: 'tighter' },
    looser: { ru: 'свободнее', uz: 'erkinroq', en: 'looser' },
    in_stock_alternative: { ru: 'в наличии', uz: 'mavjud', en: 'in stock' },
  };
  return map[note]?.[locale] ?? map[note]?.ru ?? note;
}

/* ── Size chart ──────────────────────────────────────────────────────────── */

/**
 * CAT-003: the brand's chart as the brand published it, plus its note verbatim.
 * We convert millimetres to centimetres for display and nothing else — no
 * "equivalent EU size" invented by us.
 */
function SizeChartSheet({
  open,
  onClose,
  product,
}: {
  open: boolean;
  onClose: () => void;
  product: ProductDetail;
}) {
  const { locale } = useApp();
  const t = useT();
  const chart = product.sizeChart;
  if (!chart) return null;

  const keys = MEASUREMENT_KEYS.filter((key) =>
    chart.rows.some((row) => row.body?.[key] !== undefined || row.garment?.[key] !== undefined),
  );

  return (
    <Sheet open={open} onClose={onClose} title={t('pdp.sizeChart')} height="tall">
      <div className="space-y-5 pb-2">
        <p className="t-eyebrow">{t('fit.cm')}</p>

        <div className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-[var(--line)]">
                <th className="sticky left-0 bg-[var(--bg)] py-2.5 pr-3 text-left font-semibold">
                  {t('pdp.size')}
                </th>
                {keys.map((key) => (
                  <th key={key} className="whitespace-nowrap px-3 py-2.5 text-right font-medium text-[var(--fg-muted)]">
                    {t(`fit.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.rows.map((row) => (
                <tr key={row.sizeLabel} className="border-b border-[var(--line-soft)]">
                  <td className="sticky left-0 bg-[var(--bg)] py-2.5 pr-3 font-semibold">{row.sizeLabel}</td>
                  {keys.map((key) => {
                    const value = row.body?.[key] ?? row.garment?.[key];
                    return (
                      <td key={key} className="t-num whitespace-nowrap px-3 py-2.5 text-right">
                        {value !== undefined ? mmToCm(value) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {chart.note?.[locale] && (
          <Note tone="neutral" title={t('fit.howToMeasure')}>
            {chart.note[locale]}
          </Note>
        )}

        <p className="text-[12px] leading-relaxed text-[var(--fg-faint)]">{t('pdp.fitDisclaimer')}</p>

        <Link href="/profile/fit" onClick={onClose}>
          <Button variant="outline" block icon={<HeartIcon size={15} />}>
            {t('fit.title')}
          </Button>
        </Link>
      </div>
    </Sheet>
  );
}
