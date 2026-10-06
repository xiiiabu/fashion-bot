'use client';

/**
 * Address form — spec USR-005 and §12.3 (geolocation is optional and consented;
 * a shopper can always type an address instead).
 *
 * Only the fields a Tashkent courier actually needs are required. Entrance,
 * floor and landmark are the ones that get a parcel delivered in practice, and
 * they are optional because demanding them loses orders.
 */

import { useCallback, useState } from 'react';
import type { AddressView } from '@fashion/core';
import { addresses, type AddressInput } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { Button, Field, Input, Switch } from './ui';
import { haptic } from '@/lib/telegram';

const TASHKENT_DISTRICTS = [
  'Мирзо-Улугбекский',
  'Юнусабадский',
  'Чиланзарский',
  'Шайхантахурский',
  'Яшнабадский',
  'Мирабадский',
  'Алмазарский',
  'Учтепинский',
  'Сергелийский',
  'Бектемирский',
  'Яккасарайский',
];

export function AddressForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: AddressView;
  onSaved: (address: AddressView) => void;
  onCancel?: () => void;
}) {
  const { locale, toast } = useApp();
  const t = useT();

  const [form, setForm] = useState<AddressInput>({
    label: initial?.label ?? '',
    recipientName: initial?.recipientName ?? '',
    phone: initial?.phone ?? '+998 ',
    city: initial?.city ?? 'Ташкент',
    district: initial?.district ?? null,
    street: initial?.street ?? '',
    building: initial?.building ?? '',
    apartment: initial?.apartment ?? null,
    landmark: initial?.landmark ?? null,
    isDefault: initial?.isDefault ?? false,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof AddressInput, string>>>({});
  const [saving, setSaving] = useState(false);

  const set = useCallback(
    <K extends keyof AddressInput>(key: K, value: AddressInput[K]) => {
      setForm((current) => ({ ...current, [key]: value }));
      setErrors((current) => ({ ...current, [key]: undefined }));
    },
    [],
  );

  const submit = useCallback(async () => {
    const next: Partial<Record<keyof AddressInput, string>> = {};
    if (!form.recipientName || form.recipientName.trim().length < 2) {
      next.recipientName = t('common.required');
    }
    // Uzbek mobile numbers are +998 followed by nine digits; anything shorter
    // will not reach the courier, so it is rejected here rather than at the API.
    const digits = (form.phone ?? '').replace(/\D/g, '');
    if (digits.length < 12 || !digits.startsWith('998')) next.phone = '+998 XX XXX XX XX';
    if (!form.city || form.city.trim().length < 2) next.city = t('common.required');
    if (!form.street || form.street.trim().length < 2) next.street = t('common.required');
    if (!form.building || form.building.trim().length < 1) next.building = t('common.required');

    if (Object.keys(next).length > 0) {
      setErrors(next);
      haptic.error();
      return;
    }

    setSaving(true);
    try {
      const payload: AddressInput = {
        ...form,
        label: form.label?.trim() || undefined,
        phone: `+${digits}`,
        district: form.district || null,
        apartment: form.apartment || null,
        landmark: form.landmark || null,
      };
      const saved = initial
        ? await addresses.update(initial.id, payload)
        : await addresses.create(payload);
      haptic.success();
      onSaved(saved);
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setSaving(false);
    }
  }, [form, initial, onSaved, toast, t, locale]);

  return (
    <div className="space-y-3.5">
      <Field label={t('address.recipient')} required error={errors.recipientName}>
        <Input
          value={form.recipientName}
          onChange={(event) => set('recipientName', event.target.value)}
          autoComplete="name"
          invalid={Boolean(errors.recipientName)}
        />
      </Field>

      <Field label={t('address.phone')} required error={errors.phone} hint="+998 90 123 45 67">
        <Input
          value={form.phone}
          onChange={(event) => set('phone', event.target.value)}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          invalid={Boolean(errors.phone)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('address.city')} required error={errors.city}>
          <Input
            value={form.city}
            onChange={(event) => set('city', event.target.value)}
            autoComplete="address-level2"
            invalid={Boolean(errors.city)}
          />
        </Field>
        <Field label={t('address.district')}>
          <select
            value={form.district ?? ''}
            onChange={(event) => set('district', event.target.value || null)}
            className="h-12 w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--bg-raised)] px-3 text-[15px] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="">—</option>
            {TASHKENT_DISTRICTS.map((district) => (
              <option key={district} value={district}>
                {district}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={t('address.street')} required error={errors.street}>
        <Input
          value={form.street}
          onChange={(event) => set('street', event.target.value)}
          autoComplete="address-line1"
          invalid={Boolean(errors.street)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('address.building')} required error={errors.building}>
          <Input
            value={form.building}
            onChange={(event) => set('building', event.target.value)}
            invalid={Boolean(errors.building)}
          />
        </Field>
        <Field label={t('address.apartment')}>
          <Input
            value={form.apartment ?? ''}
            onChange={(event) => set('apartment', event.target.value || null)}
          />
        </Field>
      </div>

      <Field label={t('address.landmark')} hint={t('common.optional')}>
        <Input
          value={form.landmark ?? ''}
          onChange={(event) => set('landmark', event.target.value || null)}
        />
      </Field>

      <Field label={t('address.label')} hint={t('address.labelPlaceholder')}>
        <Input
          value={form.label ?? ''}
          onChange={(event) => set('label', event.target.value)}
          placeholder={t('address.labelPlaceholder')}
        />
      </Field>

      <Switch
        checked={Boolean(form.isDefault)}
        onChange={(next) => set('isDefault', next)}
        label={t('address.default')}
      />

      <div className="flex gap-2.5 pt-1">
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button block loading={saving} onClick={submit}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
