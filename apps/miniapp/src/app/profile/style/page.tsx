'use client';

/**
 * Style profile — spec USR-002 (the onboarding quiz, which is also permanently
 * editable here) and AI-007 (the stylist weights these preferences).
 *
 * Nothing is required. A shopper who taps nothing still gets a working stylist
 * driven by the brief alone, which is why the finish button is never disabled.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import type { BrandSummary, ColorFamily, FitPreference, Occasion, StyleTag } from '@fashion/core';
import { COLOR_FAMILIES, FIT_PREFERENCES, OCCASIONS, STYLE_TAGS } from '@fashion/core';
import { catalog, me as meApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { minorFromMajor } from '@/lib/format';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Button,
  Chip,
  Field,
  Input,
  LoadingScreen,
  Note,
  Section,
  cx,
} from '@/components/ui';
import { colorLabel, colorSwatch, occasionLabel, styleLabel } from '@/lib/taxonomy-labels';
import { haptic } from '@/lib/telegram';

export default function StyleProfilePage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <StyleProfileScreen />
    </Suspense>
  );
}

function StyleProfileScreen() {
  const router = useRouter();
  const search = useSearchParams();
  const { user, locale, refreshUser, toast } = useApp();
  const t = useT();

  /** Onboarding mode lands back on home; editing mode goes back to profile. */
  const onboarding = search.get('onboarding') === '1';
  useBackButton(onboarding ? '/' : '/profile');

  const [styles, setStyles] = useState<StyleTag[]>([]);
  const [colors, setColors] = useState<ColorFamily[]>([]);
  const [dislikedColors, setDislikedColors] = useState<ColorFamily[]>([]);
  const [occasions, setOccasions] = useState<Occasion[]>([]);
  const [preferredFit, setPreferredFit] = useState<FitPreference | null>(null);
  const [budget, setBudget] = useState('');
  const [brands, setBrands] = useState<BrandSummary[]>([]);
  const [favouriteBrands, setFavouriteBrands] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    catalog
      .brands(40)
      .then((data) => setBrands(data.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const profile = user?.styleProfile;
    if (!profile) return;
    setStyles([...profile.styles]);
    setColors([...profile.colors]);
    setDislikedColors([...profile.dislikedColors]);
    setPreferredFit(profile.preferredFit ?? null);
    setFavouriteBrands([...profile.favouriteBrandIds]);
    if (profile.budgetPerItem) {
      setBudget(String(Number(BigInt(profile.budgetPerItem.amount) / 100n)));
    }
  }, [user?.styleProfile]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const budgetValue = Number(budget.replace(/\s/g, '').replace(',', '.'));
      await meApi.putStyleProfile({
        styles,
        colors,
        dislikedColors,
        occasions,
        preferredFit,
        favouriteBrandIds: favouriteBrands,
        budgetPerItemMinor:
          Number.isFinite(budgetValue) && budgetValue > 0 ? minorFromMajor(budgetValue) : null,
        completed: true,
      });
      await refreshUser();
      haptic.success();
      toast(t('common.saved'), 'success');
      router.push(onboarding ? '/' : '/profile');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setSaving(false);
    }
  }, [
    styles,
    colors,
    dislikedColors,
    occasions,
    preferredFit,
    favouriteBrands,
    budget,
    refreshUser,
    toast,
    t,
    locale,
    router,
    onboarding,
  ]);

  /** Toggle helper with a cap, so a profile stays a preference, not a filter. */
  function toggler<T>(
    list: T[],
    setList: (next: T[]) => void,
    max: number,
    /** The opposite list, so a colour cannot be both liked and disliked. */
    exclusive?: { list: T[]; set: (next: T[]) => void },
  ) {
    return (value: T) => {
      haptic.select();
      if (list.includes(value)) {
        setList(list.filter((item) => item !== value));
        return;
      }
      if (list.length >= max) return;
      if (exclusive?.list.includes(value)) {
        exclusive.set(exclusive.list.filter((item) => item !== value));
      }
      setList([...list, value]);
    };
  }

  const toggleStyle = toggler(styles, setStyles, 8);
  const toggleColor = toggler(colors, setColors, 10, { list: dislikedColors, set: setDislikedColors });
  const toggleDisliked = toggler(dislikedColors, setDislikedColors, 10, { list: colors, set: setColors });
  const toggleOccasion = toggler(occasions, setOccasions, 8);
  const toggleBrand = toggler(favouriteBrands, setFavouriteBrands, 30);

  return (
    <div className="pb-8">
      <ScreenHeader
        back={onboarding ? '/' : '/profile'}
        title={t('style.title')}
        action={
          onboarding ? (
            <button
              type="button"
              onClick={() => router.push('/')}
              className="px-2 text-[13px] text-[var(--fg-muted)]"
            >
              {t('style.skip')}
            </button>
          ) : undefined
        }
      />

      <div className="px-4 pt-4">
        <Note tone="neutral">{t('style.intro')}</Note>
      </div>

      <Section title={t('style.pickStyles')}>
        <div className="flex flex-wrap gap-2">
          {STYLE_TAGS.map((style: StyleTag) => (
            <Chip key={style} selected={styles.includes(style)} onClick={() => toggleStyle(style)}>
              {styleLabel(style, locale)}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title={t('style.pickColors')}>
        <ColorPicker selected={colors} onToggle={toggleColor} />
      </Section>

      <Section title={t('style.avoidColors')}>
        <ColorPicker selected={dislikedColors} onToggle={toggleDisliked} tone="avoid" />
      </Section>

      <Section title={t('style.occasions')}>
        <div className="flex flex-wrap gap-2">
          {OCCASIONS.map((occasion: Occasion) => (
            <Chip
              key={occasion}
              selected={occasions.includes(occasion)}
              onClick={() => toggleOccasion(occasion)}
            >
              {occasionLabel(occasion, locale)}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title={t('style.fitPreference')}>
        <div className="flex flex-wrap gap-2">
          {FIT_PREFERENCES.map((preference: FitPreference) => (
            <Chip
              key={preference}
              selected={preferredFit === preference}
              onClick={() => {
                haptic.select();
                setPreferredFit(preferredFit === preference ? null : preference);
              }}
            >
              {t(`fit.preference.${preference}`)}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title={t('style.budget')}>
        <Field hint="UZS">
          <Input
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            type="number"
            inputMode="numeric"
            step={100_000}
            placeholder="1 500 000"
          />
        </Field>
      </Section>

      {brands.length > 0 && (
        <Section title={t('style.favouriteBrands')}>
          <div className="flex flex-wrap gap-2">
            {brands.map((brand) => (
              <Chip
                key={brand.id}
                selected={favouriteBrands.includes(brand.id)}
                onClick={() => toggleBrand(brand.id)}
              >
                {brand.name}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      <div className="px-4 pt-4">
        <Button block loading={saving} onClick={() => void save()}>
          {onboarding ? t('style.finish') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}

function ColorPicker({
  selected,
  onToggle,
  tone = 'like',
}: {
  selected: ColorFamily[];
  onToggle: (color: ColorFamily) => void;
  tone?: 'like' | 'avoid';
}) {
  const { locale } = useApp();
  return (
    <div className="grid grid-cols-5 gap-x-2 gap-y-3.5">
      {COLOR_FAMILIES.map((color: ColorFamily) => {
        const isSelected = selected.includes(color);
        const swatch = colorSwatch(color);
        return (
          <button
            key={color}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onToggle(color)}
            className="pressable flex flex-col items-center gap-1.5"
          >
            <span
              className={cx(
                'relative flex h-[42px] w-[42px] items-center justify-center rounded-full border-2',
                isSelected
                  ? tone === 'avoid'
                    ? 'border-danger'
                    : 'border-[var(--accent)]'
                  : 'border-[var(--line)]',
              )}
            >
              <span
                className="h-[32px] w-[32px] rounded-full"
                style={swatch.startsWith('#') ? { backgroundColor: swatch } : { background: swatch }}
              />
              {/* A disliked colour reads as struck out, not merely outlined. */}
              {isSelected && tone === 'avoid' && (
                <span
                  aria-hidden
                  className="absolute h-[2px] w-[34px] rotate-45 rounded-full bg-danger"
                />
              )}
            </span>
            <span className="line-clamp-1 text-[10.5px] text-[var(--fg-muted)]">
              {colorLabel(color, locale)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
