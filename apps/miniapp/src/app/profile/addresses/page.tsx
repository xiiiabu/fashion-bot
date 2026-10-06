'use client';

/** Saved addresses — spec USR-005. */

import { useCallback, useEffect, useState } from 'react';
import type { AddressView } from '@fashion/core';
import { addresses as addressApi } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { AddressForm } from '@/components/address-form';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PinIcon,
  Section,
  Sheet,
  Skeleton,
  cx,
} from '@/components/ui';
import { confirm, haptic } from '@/lib/telegram';

export default function AddressesPage() {
  const { locale, toast } = useApp();
  const t = useT();
  useBackButton('/profile');

  const [items, setItems] = useState<AddressView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AddressView | 'new' | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await addressApi.list();
      setItems(data.items);
    } catch (caught) {
      setError(errorMessage(caught, locale));
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (address: AddressView) => {
      if (!(await confirm(t('address.deleteConfirm')))) return;
      try {
        await addressApi.remove(address.id);
        setItems((current) => (current ?? []).filter((item) => item.id !== address.id));
        haptic.success();
      } catch (caught) {
        toast(errorMessage(caught, locale), 'error');
      }
    },
    [toast, t, locale],
  );

  const makeDefault = useCallback(
    async (address: AddressView) => {
      try {
        await addressApi.update(address.id, { isDefault: true });
        await load();
        haptic.success();
      } catch (caught) {
        toast(errorMessage(caught, locale), 'error');
      }
    },
    [load, toast, locale],
  );

  return (
    <div className="pb-8">
      <ScreenHeader back="/profile" title={t('address.title')} />

      {error && <ErrorState message={error} onRetry={load} retryLabel={t('common.retry')} />}

      {!items && !error && (
        <div className="space-y-3 px-4 pt-4">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-[96px] w-full rounded-[var(--radius-lg)]" />
          ))}
        </div>
      )}

      {items && items.length === 0 && (
        <EmptyState
          icon={<PinIcon size={32} />}
          title={t('address.empty')}
          action={<Button onClick={() => setEditing('new')}>{t('address.add')}</Button>}
        />
      )}

      {items && items.length > 0 && (
        <>
          <div className="space-y-3 px-4 pt-4">
            {items.map((address) => (
              <div
                key={address.id}
                className={cx(
                  'rounded-[var(--radius-lg)] border p-3.5',
                  address.isDefault
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--line)] bg-[var(--bg-raised)]',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[14px] font-semibold">
                      <span className="truncate">{address.label || address.recipientName}</span>
                      {address.isDefault && <Badge tone="accent">{t('address.default')}</Badge>}
                    </p>
                    <p className="mt-0.5 text-[13px] leading-snug text-[var(--fg-muted)]">
                      {[
                        address.city,
                        address.district,
                        address.street,
                        address.building,
                        address.apartment ? `кв. ${address.apartment}` : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                    <p className="t-num mt-0.5 text-[12.5px] text-[var(--fg-faint)]">{address.phone}</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--line-soft)] pt-2.5">
                  <button
                    type="button"
                    onClick={() => setEditing(address)}
                    className="text-[12.5px] font-medium text-[var(--accent)]"
                  >
                    {t('common.edit')}
                  </button>
                  {!address.isDefault && (
                    <>
                      <span className="text-[var(--fg-faint)]">·</span>
                      <button
                        type="button"
                        onClick={() => void makeDefault(address)}
                        className="text-[12.5px] text-[var(--fg-muted)]"
                      >
                        {t('address.setDefault')}
                      </button>
                    </>
                  )}
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => void remove(address)}
                    className="text-[12.5px] text-[var(--fg-faint)]"
                  >
                    {t('common.remove')}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="px-4 pt-4">
            <Button variant="outline" block onClick={() => setEditing('new')}>
              {t('address.add')}
            </Button>
          </div>
        </>
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('address.add') : t('common.edit')}
        height="tall"
      >
        {editing && (
          <AddressForm
            initial={editing === 'new' ? undefined : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
          />
        )}
      </Sheet>
    </div>
  );
}
