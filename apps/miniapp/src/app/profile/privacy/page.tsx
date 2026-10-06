'use client';

/**
 * Privacy centre — spec USR-003 (granular, revocable consent), USR-006 (a
 * machine-readable export), USR-007 (a deletion request) and §12.2, which maps
 * these to the Uzbek personal-data obligations (O'RQ-547 on personal data, and
 * O'RQ-1173 on consumer rights from 12.12.2026).
 *
 * The point of this screen is that every switch does something immediately and
 * visibly. A consent toggle that only takes effect "on the next save" is not a
 * consent mechanism.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { me as meApi, track } from '@/lib/endpoints';
import { errorMessage, useApp, useT } from '@/lib/app-context';
import { dateTime } from '@/lib/format';
import { ScreenHeader, useBackButton } from '@/components/shell';
import {
  Badge,
  Button,
  DownloadIcon,
  LockIcon,
  Note,
  Row,
  RowGroup,
  Section,
  Switch,
  Textarea,
  Sheet,
} from '@/components/ui';
import { confirm, haptic } from '@/lib/telegram';

/**
 * The scopes a shopper controls. TERMS and PRIVACY are acceptance records
 * rather than switches, so they are displayed but not toggleable: withdrawing
 * acceptance of the terms is an account deletion, which has its own action.
 */
const TOGGLEABLE = ['PERSONALIZATION', 'FIT_PROFILE', 'MARKETING', 'ANALYTICS'] as const;
const ACCEPTANCE = ['TERMS', 'PRIVACY'] as const;

type Scope = (typeof TOGGLEABLE)[number];

export default function PrivacyPage() {
  const router = useRouter();
  const { user, locale, refreshUser, toast } = useApp();
  const t = useT();
  useBackButton('/profile');

  const [busy, setBusy] = useState<string | null>(null);
  const [requests, setRequests] = useState<
    Array<{ id: string; kind: string; status: string; createdAt: string }>
  >([]);
  const [deleteSheet, setDeleteSheet] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    meApi
      .privacyRequests()
      .then((data) => setRequests(data.items))
      .catch(() => {});
  }, []);

  const setConsent = useCallback(
    async (scope: Scope, granted: boolean) => {
      setBusy(scope);
      try {
        await meApi.setConsents([{ scope, granted }]);
        await refreshUser();
        track('consent_updated', { scope, granted });
        haptic.success();
      } catch (caught) {
        toast(errorMessage(caught, locale), 'error');
      } finally {
        setBusy(null);
      }
    },
    [refreshUser, toast, locale],
  );

  const togglePersonalization = useCallback(
    async (enabled: boolean) => {
      setBusy('personalization');
      try {
        await meApi.setPersonalization(enabled);
        await refreshUser();
        track('consent_updated', { scope: 'PERSONALIZATION_MASTER', granted: enabled });
        haptic.success();
      } catch (caught) {
        toast(errorMessage(caught, locale), 'error');
      } finally {
        setBusy(null);
      }
    },
    [refreshUser, toast, locale],
  );

  /**
   * USR-006: the export is a file the shopper keeps, not a page they read. It
   * is assembled by the API and downloaded here as JSON.
   */
  const exportData = useCallback(async () => {
    setExporting(true);
    try {
      const data = await meApi.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `atlas-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      haptic.success();
      toast(t('privacy.exportReady'), 'success');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setExporting(false);
    }
  }, [toast, t, locale]);

  const requestDeletion = useCallback(async () => {
    setBusy('delete');
    try {
      await meApi.requestDeletion(deleteReason.trim() || undefined);
      const data = await meApi.privacyRequests();
      setRequests(data.items);
      setDeleteSheet(false);
      haptic.success();
      toast(t('privacy.requestSent'), 'success');
    } catch (caught) {
      toast(errorMessage(caught, locale), 'error');
    } finally {
      setBusy(null);
    }
  }, [deleteReason, toast, t, locale]);

  const consents = user?.consents ?? {};

  return (
    <div className="pb-8">
      <ScreenHeader back="/profile" title={t('privacy.title')} />

      <div className="px-4 pt-4">
        <Note tone="neutral">{t('privacy.intro')}</Note>
      </div>

      {/* ── Personalisation master switch ─────────────────────────────── */}
      <Section title={t('privacy.personalization')}>
        <div className="rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-4">
          <Switch
            checked={user?.personalizationEnabled ?? false}
            disabled={busy === 'personalization'}
            onChange={(next) => void togglePersonalization(next)}
            label={t('privacy.consent.PERSONALIZATION')}
            hint={
              user?.personalizationEnabled
                ? t('privacy.consent.PERSONALIZATION.hint')
                : t('privacy.personalizationOff')
            }
          />
        </div>
      </Section>

      {/* ── Per-scope consents (USR-003) ──────────────────────────────── */}
      <Section title={t('privacy.consents')}>
        <div className="space-y-4 rounded-[var(--radius-lg)] bg-[var(--bg-raised)] p-4">
          {TOGGLEABLE.map((scope) => (
            <Switch
              key={scope}
              checked={consents[scope]?.granted ?? false}
              disabled={busy === scope}
              onChange={(next) => void setConsent(scope, next)}
              label={t(`privacy.consent.${scope}`)}
              hint={t(`privacy.consent.${scope}.hint`)}
            />
          ))}
        </div>

        {/* The acceptance record: shown so a shopper can see which version of
            the documents they agreed to, and when (§12.1). */}
        <div className="mt-3">
          <RowGroup>
            {ACCEPTANCE.map((scope) => {
              const record = consents[scope];
              return (
                <Row
                  key={scope}
                  icon={<LockIcon size={16} />}
                  title={t(`privacy.consent.${scope}`)}
                  hint={
                    record
                      ? `${record.version} · ${dateTime(record.at, locale)}`
                      : undefined
                  }
                  trailing={record?.granted ? '✓' : '—'}
                />
              );
            })}
          </RowGroup>
        </div>
      </Section>

      {/* ── Data rights ───────────────────────────────────────────────── */}
      <Section title={t('privacy.requests')}>
        <RowGroup>
          <Row
            icon={<DownloadIcon size={17} />}
            title={t('privacy.export')}
            hint={t('privacy.exportHint')}
            onClick={() => void exportData()}
            trailing={exporting ? '…' : undefined}
          />
          <Row
            title={t('privacy.delete')}
            hint={t('privacy.deleteHint')}
            danger
            onClick={() => setDeleteSheet(true)}
          />
        </RowGroup>

        {requests.length > 0 && (
          <div className="mt-3">
            <RowGroup>
              {requests.map((request) => (
                <Row
                  key={request.id}
                  title={requestKindLabel(request.kind, locale)}
                  hint={dateTime(request.createdAt, locale)}
                  trailing={<Badge tone="neutral">{request.status}</Badge>}
                />
              ))}
            </RowGroup>
          </div>
        )}
      </Section>

      <Section>
        <RowGroup>
          <Row title={t('profile.privacyPolicy')} onClick={() => router.push('/pages/privacy')} />
          <Row title={t('profile.terms')} onClick={() => router.push('/pages/terms')} />
        </RowGroup>
      </Section>

      <Sheet open={deleteSheet} onClose={() => setDeleteSheet(false)} title={t('privacy.delete')}>
        <div className="space-y-4 pb-2">
          <p className="text-[14px] leading-relaxed">{t('privacy.deleteConfirm')}</p>
          {/* §12.2: an obligation to keep order and tax records outlives a
              deletion request, so we say so rather than promising erasure. */}
          <Note tone="warn">
            {locale === 'uz'
              ? 'Buyurtmalar va soliq hujjatlari qonun talab qilgan muddat saqlanadi. Qolgan maʼlumotlar oʻchiriladi yoki anonimlashtiriladi.'
              : locale === 'en'
                ? 'Order and tax records are kept for the period the law requires. Everything else is deleted or anonymised.'
                : 'Данные о заказах и налоговые документы хранятся установленный законом срок. Остальное удаляется или анонимизируется.'}
          </Note>
          <Textarea
            value={deleteReason}
            onChange={(event) => setDeleteReason(event.target.value)}
            placeholder={t('common.optional')}
            maxLength={2000}
          />
          <div className="flex gap-2.5">
            <Button variant="outline" onClick={() => setDeleteSheet(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              block
              variant="danger"
              loading={busy === 'delete'}
              onClick={async () => {
                if (!(await confirm(t('privacy.deleteConfirm')))) return;
                await requestDeletion();
              }}
            >
              {t('privacy.delete')}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function requestKindLabel(kind: string, locale: string): string {
  const map: Record<string, Record<string, string>> = {
    ACCESS: { ru: 'Доступ к данным', uz: 'Maʼlumotlarga kirish', en: 'Access request' },
    CORRECTION: { ru: 'Исправление', uz: 'Tuzatish', en: 'Correction' },
    DELETION: { ru: 'Удаление', uz: 'Oʻchirish', en: 'Deletion' },
    ANONYMIZATION: { ru: 'Анонимизация', uz: 'Anonimlashtirish', en: 'Anonymisation' },
    CONSENT_WITHDRAWAL: { ru: 'Отзыв согласия', uz: 'Rozilikni qaytarish', en: 'Consent withdrawal' },
    PROCESSING_INFO: { ru: 'Сведения об обработке', uz: 'Qayta ishlash haqida', en: 'Processing info' },
  };
  return map[kind]?.[locale] ?? map[kind]?.ru ?? kind;
}
