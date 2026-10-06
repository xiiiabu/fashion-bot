'use client';

/**
 * Fit profile — spec FIT-002 (every signal is individually switchable),
 * FIT-007 (measurements are stored in millimetres), FIT-008 (nothing here
 * touches a photograph, a face, an age or an ethnicity) and USR-003 (consent
 * is granular and revocable at once).
 *
 * The consent switch is at the top and it genuinely gates everything: turning
 * it off stops personalised sizing on the next PDP read, which is what UAT-19
 * checks. The delete action removes the measurements rather than hiding them.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FitPreference, MeasurementKey } from '@fashion/core';
import { FIT_PREFERENCES } from '@fashion/core';
import { me as meApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { cmToMm, gramsToKg, kgToGrams, mmToCm } from '@/lib/format';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Button,
  Chip,
  Collapsible,
  Divider,
  Field,
  Input,
  Note,
  Row,
  RowGroup,
  Section,
  Switch,
} from '@/components/ui';
import { confirm, haptic } from '@/lib/telegram';

/**
 * Which measurements we ask for, in the order a tape measure goes. Only the
 * first three change a size for most garments; the rest sharpen it.
 */
const PRIMARY: MeasurementKey[] = ['chest', 'waist', 'hips'];
const SECONDARY: MeasurementKey[] = ['shoulder', 'sleeve', 'inseam', 'neck', 'thigh', 'footLength'];

export default function FitProfilePage() {
  const { user, locale, refreshUser, toast } = useApp();
  const t = useT();
  useBackButton('/profile');

  const [consent, setConsent] = useState(true);
  const [heightCm, setHeightCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [measurements, setMeasurements] = useState<Partial<Record<MeasurementKey, string>>>({});
  const [preferredFit, setPreferredFit] = useState<FitPreference | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  /* Hydrate from the profile once it arrives. */
  useEffect(() => {
    const profile = user?.fitProfile;
    if (!profile) return;
    setConsent(profile.consentPersonalizedFit);
    setHeightCm(profile.heightMm ? mmToCm(profile.heightMm) : '');
    setWeightKg(profile.weightGrams ? gramsToKg(profile.weightGrams) : '');
    setPreferredFit(profile.preferredFit ?? null);
    const next: Partial<Record<MeasurementKey, string>> = {};
    for (const [key, value] of Object.entries(profile.measurements ?? {})) {
      if (typeof value === 'number') next[key as MeasurementKey] = mmToCm(value);
    }
    setMeasurements(next);
  }, [user?.fitProfile]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const mm: Record<string, number | null> = {};
      for (const key of [...PRIMARY, ...SECONDARY]) {
        const raw = measurements[key];
        const parsed = raw ? Number(raw.replace(',', '.')) : NaN;
        mm[key] = Number.isFinite(parsed) && parsed > 0 ? cmToMm(parsed) : null;
      }
      const height = Number(heightCm.replace(',', '.'));
      const weight = Number(weightKg.replace(',', '.'));

      await meApi.putFitProfile({
        heightMm: Number.isFinite(height) && height > 0 ? cmToMm(height) : null,
        weightGrams: Number.isFinite(weight) && weight > 0 ? kgToGrams(weight) : null,
        measurements: mm,
        preferredFit,
        consentPersonalizedFit: consent,
      });
      await refreshUser();
      setDirty(false);
      haptic.success();
      toast(t('common.saved'), 'success');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setSaving(false);
    }
  }, [measurements, heightCm, weightKg, preferredFit, consent, refreshUser, toast, t, locale]);

  /**
   * FIT-002/USR-003: withdrawing consent is not "save it later". It takes
   * effect immediately, because a shopper who switches it off expects the
   * personalisation to stop now.
   */
  const changeConsent = useCallback(
    async (next: boolean) => {
      setConsent(next);
      try {
        await meApi.putFitProfile({ consentPersonalizedFit: next });
        await refreshUser();
        haptic.success();
      } catch (caught) {
        setConsent(!next);
        toast(errorMessage(caught, locale), 'error');
      }
    },
    [refreshUser, toast, locale],
  );

  const remove = useCallback(async () => {
    if (!(await confirm(t('fit.deleteConfirm')))) return;
    try {
      await meApi.deleteFitProfile();
      await refreshUser();
      setMeasurements({});
      setHeightCm('');
      setWeightKg('');
      setPreferredFit(null);
      haptic.success();
      toast(t('common.done'), 'success');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    }
  }, [refreshUser, toast, t, locale]);

  const setMeasurement = (key: MeasurementKey, value: string) => {
    setMeasurements((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  return (
    <div className="pb-8">
      <ScreenHeader back="/profile" title={t('fit.title')} />

      <div className="px-4 pt-4">
        <Note tone="neutral">{t('fit.intro')}</Note>
      </div>

      <Section>
        <div className="rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-4">
          <Switch
            checked={consent}
            onChange={(next) => void changeConsent(next)}
            label={t('fit.consent')}
            hint={consent ? undefined : t('fit.consentOff')}
          />
        </div>
      </Section>

      {/* ── Preferred fit (FIT-006) ───────────────────────────────────── */}
      <Section title={t('style.fitPreference')}>
        <div className="flex flex-wrap gap-2">
          {FIT_PREFERENCES.map((preference: FitPreference) => (
            <Chip
              key={preference}
              selected={preferredFit === preference}
              onClick={() => {
                setPreferredFit(preferredFit === preference ? null : preference);
                setDirty(true);
              }}
            >
              {t(`fit.preference.${preference}`)}
            </Chip>
          ))}
        </div>
      </Section>

      {/* ── Height & weight ───────────────────────────────────────────── */}
      <Section>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('fit.height')} hint={t('fit.cm')}>
            <Input
              value={heightCm}
              onChange={(event) => {
                setHeightCm(event.target.value);
                setDirty(true);
              }}
              type="number"
              inputMode="decimal"
              min={120}
              max={230}
              placeholder="175"
            />
          </Field>
          <Field label={t('fit.weight')} hint={t('fit.kg')}>
            <Input
              value={weightKg}
              onChange={(event) => {
                setWeightKg(event.target.value);
                setDirty(true);
              }}
              type="number"
              inputMode="decimal"
              min={30}
              max={220}
              placeholder="70"
            />
          </Field>
        </div>
        {/* FIT-004: say plainly that height and weight are the weaker signal. */}
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--fg-faint)]">
          {t('fit.estimate')}
        </p>
      </Section>

      {/* ── Measurements ──────────────────────────────────────────────── */}
      <Section title={t('pdp.measurements')}>
        <div className="grid grid-cols-2 gap-3">
          {PRIMARY.map((key) => (
            <Field key={key} label={t(`fit.${key}`)} hint={t('fit.cm')}>
              <Input
                value={measurements[key] ?? ''}
                onChange={(event) => setMeasurement(key, event.target.value)}
                type="number"
                inputMode="decimal"
                min={30}
                max={200}
              />
            </Field>
          ))}
        </div>

        <div className="mt-4 border-t border-[var(--line)]">
          <Collapsible title={t('common.more')}>
            <div className="grid grid-cols-2 gap-3 pt-1">
              {SECONDARY.map((key) => (
                <Field key={key} label={t(`fit.${key}`)} hint={t('fit.cm')}>
                  <Input
                    value={measurements[key] ?? ''}
                    onChange={(event) => setMeasurement(key, event.target.value)}
                    type="number"
                    inputMode="decimal"
                    min={5}
                    max={200}
                  />
                </Field>
              ))}
            </div>
          </Collapsible>

          <Collapsible title={t('fit.howToMeasure')}>
            <ol className="space-y-2 text-[13px] leading-relaxed">
              <li>
                <strong>{t('fit.chest')}.</strong>{' '}
                {locale === 'uz'
                  ? 'Lentani koʻkrakning eng keng joyidan, qoʻltiq ostidan oʻtkazing. Lenta tanaga tegsin, lekin bosmasin.'
                  : locale === 'en'
                    ? 'Around the fullest part of the chest, under the arms. The tape should touch, not compress.'
                    : 'По самой широкой части груди, под руками. Лента касается тела, но не стягивает.'}
              </li>
              <li>
                <strong>{t('fit.waist')}.</strong>{' '}
                {locale === 'uz'
                  ? 'Belning eng tor joyidan — odatda kindikdan yuqoriroq.'
                  : locale === 'en'
                    ? 'Around the narrowest part of the waist, usually just above the navel.'
                    : 'По самой узкой части талии — обычно чуть выше пупка.'}
              </li>
              <li>
                <strong>{t('fit.hips')}.</strong>{' '}
                {locale === 'uz'
                  ? 'Sonning eng keng joyidan, oyoqlar birga turganda.'
                  : locale === 'en'
                    ? 'Around the fullest part of the hips, with the feet together.'
                    : 'По самой широкой части бёдер, ноги вместе.'}
              </li>
            </ol>
          </Collapsible>
        </div>
      </Section>

      <div className="px-4 pt-4">
        <Button block loading={saving} disabled={!dirty} onClick={() => void save()}>
          {dirty ? t('common.save') : t('common.saved')}
        </Button>
      </div>

      <Section>
        <RowGroup>
          <Row title={t('fit.delete')} danger onClick={remove} />
        </RowGroup>
      </Section>

      {/* FIT-008, stated to the shopper rather than only honoured in code. */}
      <p className="px-4 pt-2 text-[11.5px] leading-relaxed text-[var(--fg-faint)]">
        {locale === 'uz'
          ? 'Faqat siz kiritgan oʻlchamlar ishlatiladi. Foto, yosh yoki boshqa shaxsiy belgilar tahlil qilinmaydi.'
          : locale === 'en'
            ? 'Only the measurements you entered are used. No photo, age or other personal attribute is analysed.'
            : 'Используются только введённые вами мерки. Фото, возраст и другие признаки не анализируются.'}
      </p>
    </div>
  );
}
