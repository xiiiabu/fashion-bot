'use client';

/**
 * The landing screen. An admin gets the platform dashboard (§10 Dashboard,
 * ANL-002); a seller gets their own cabinet overview (§11.1).
 *
 * The monetisation block is the one that matters most and is the one most
 * easily got wrong, so it is explicit about where its numbers come from: the
 * ledger, not a recomputation over orders. The effective take rate is shown
 * next to the nominal 10% precisely so a divergence — refunds, platform-funded
 * discounts, a per-seller rule — is visible rather than averaged away.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { errorMessage, useApp } from '@/lib/app-context';
import { dashboard, seller as sellerApi, type Dashboard, type SellerOverview } from '@/lib/endpoints';
import { date, money, number, percent, ratio } from '@/lib/format';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Note,
  PageHeader,
  Pill,
  Stat,
  Table,
  cx,
} from '@/components/ui';
import { QualityCard } from '@/components/quality';
import { severityTone } from '@/lib/status';

export default function HomePage() {
  const { isSeller } = useApp();
  return isSeller ? <SellerOverviewScreen /> : <AdminDashboard />;
}

/* ── Admin dashboard ─────────────────────────────────────────────────────── */

function AdminDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await dashboard.get());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;

  if (!data) {
    return (
      <>
        <PageHeader title="Дашборд" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="skeleton h-[86px] rounded-[var(--radius-lg)]" />
          ))}
        </div>
      </>
    );
  }

  const conversionSteps = Object.entries(data.conversion.steps ?? {});

  return (
    <>
      <PageHeader
        title="Дашборд"
        subtitle={`${date(data.period.from)} — ${date(data.period.to)}`}
        action={
          data.pendingApprovals > 0 ? (
            <Link href="/approvals">
              <Button variant="primary">
                Согласований: {number(data.pendingApprovals)}
              </Button>
            </Link>
          ) : undefined
        }
      />

      {/* Anything an operator must act on comes before the numbers. */}
      {data.alerts.length > 0 && (
        <div className="mb-5 space-y-2">
          {data.alerts.slice(0, 3).map((alert) => (
            <Note key={alert.id} tone={alert.severity === 'CRITICAL' ? 'danger' : 'warn'}>
              <span className="font-medium">{alert.kind}</span> — {alert.message}
            </Note>
          ))}
        </div>
      )}

      {/* ── Sales ─────────────────────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="t-eyebrow mb-2.5">Продажи</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="GMV" value={money(data.sales.gmv)} hint={`${number(data.sales.paidOrders)} оплаченных заказов`} />
          <Stat label="Товары" value={money(data.sales.goods)} hint={`возвращено ${money(data.sales.refunded)}`} />
          <Stat label="Средний чек" value={money(data.sales.averageOrderValue)} hint={`${data.sales.itemsPerOrder.toFixed(1)} поз. в заказе`} />
          <Stat label="Активных продавцов" value={number(data.sales.activeSellers)} />
        </div>
      </section>

      {/* ── Monetisation (§8, ANL-002) ────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="t-eyebrow mb-2.5">Монетизация · из реестра</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Комиссия, начислено"
            value={money(data.monetization.commissionAccrued)}
            hint={`реверсы ${money(data.monetization.commissionReversed)}`}
          />
          <Stat label="Комиссия, нетто" value={money(data.monetization.commissionNet)} />
          <Stat
            label="Эффективная ставка"
            value={percent(data.monetization.effectiveTakeRatePercent, 2)}
            hint={`номинальная ${percent(data.monetization.nominalRatePercent, 0)}`}
            // A take rate that has drifted from the nominal one is the single
            // most useful early signal that something in pricing is off.
            tone={
              Math.abs(
                data.monetization.effectiveTakeRatePercent - data.monetization.nominalRatePercent,
              ) > 1.5
                ? 'danger'
                : undefined
            }
          />
          <Stat label="Выплачено продавцам" value={money(data.monetization.payouts)} />
          <Stat label="Скидки продавцов" value={money(data.monetization.sellerDiscounts)} hint="уменьшают базу комиссии" />
          <Stat label="Скидки платформы" value={money(data.monetization.platformDiscounts)} hint="база комиссии не меняется" />
          <Stat label="Комиссии PSP" value={money(data.monetization.pspFees)} />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ── Conversion ──────────────────────────────────────────────── */}
        <Card title="Воронка">
          {conversionSteps.length === 0 ? (
            <EmptyState title="Пока нет данных" body="События появятся, как только в приложении начнётся активность." />
          ) : (
            <ul className="space-y-2.5">
              {conversionSteps.map(([step, value]) => {
                const max = Math.max(...Object.values(data.conversion.steps));
                const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
                return (
                  <li key={step}>
                    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                      <span className="truncate text-[var(--fg-muted)]">{step}</span>
                      <span className="t-num shrink-0 font-medium">{number(value)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-[var(--bg-sunken)]">
                      <div
                        className="h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* ── AI attribution (ANL-005) ────────────────────────────────── */}
        <Card title="AI-стилист">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Сессий" value={number(data.ai.sessions)} />
            <Stat label="Заказов с образом" value={number(data.ai.aiOrders)} />
            <Stat label="GMV через стилиста" value={money(data.ai.aiGmv)} hint={percent(data.ai.aiGmvSharePercent)} />
            <Stat label="Добавили образ целиком" value={ratio(data.ai.addWholeLookRate)} />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
            Замен на сессию: {data.ai.replacementsPerSession.toFixed(2)}. Доля сессий с покупкой:{' '}
            {ratio(data.ai.purchaseRate)}.
          </p>
        </Card>

        {/* ── Operations ──────────────────────────────────────────────── */}
        <Card title="Операции">
          <dl className="space-y-2 text-[13px]">
            <Row
              label="Просроченные подтверждения"
              value={number(data.operations.overdueConfirmations)}
              tone={data.operations.overdueConfirmations > 0 ? 'danger' : undefined}
              href={data.operations.overdueConfirmations > 0 ? '/orders?overdue=1' : undefined}
            />
            <Row
              label="Отказы из-за стока"
              value={`${number(data.operations.stockRejections)} · ${percent(data.operations.stockRejectionRatePercent)}`}
              tone={data.operations.stockRejectionRatePercent > 3 ? 'warn' : undefined}
            />
            <Row
              label="Медиана подтверждения"
              value={data.operations.medianConfirmHours === null ? '—' : `${data.operations.medianConfirmHours.toFixed(1)} ч`}
            />
            <Row
              label="Медиана доставки"
              value={data.operations.medianDeliveryDays === null ? '—' : `${data.operations.medianDeliveryDays.toFixed(1)} дн.`}
            />
            <Row label="Отправлено посылок" value={number(data.operations.shippedSubOrders)} />
            <Row label="Запросов на возврат" value={number(data.operations.returnRequests)} href="/returns" />
          </dl>
        </Card>

        {/* ── Payments & reconciliation ───────────────────────────────── */}
        <Card title="Платежи и сверка">
          <dl className="space-y-2 text-[13px]">
            <Row
              label="Несопоставленные записи"
              value={number(data.payments.unmatchedRecords)}
              tone={data.payments.unmatchedRecords > 0 ? 'danger' : undefined}
              href={data.payments.unmatchedRecords > 0 ? '/finance/reconciliation' : undefined}
            />
            <Row
              label="Медиана возврата средств"
              value={data.payments.medianRefundHours === null ? '—' : `${data.payments.medianRefundHours.toFixed(1)} ч`}
            />
          </dl>
          {data.payments.providers.length > 0 && (
            <Table className="mt-3">
              <thead>
                <tr>
                  <th>Провайдер</th>
                  <th className="num">Успешно</th>
                  <th className="num">Ошибки</th>
                  <th className="num">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.providers.map((provider) => (
                  <tr key={provider.provider}>
                    <td className="font-medium">{provider.provider}</td>
                    <td className="num">{number(provider.captured)}</td>
                    <td className={cx('num', provider.failed > 0 && 'text-danger')}>
                      {number(provider.failed)}
                    </td>
                    <td className="num t-money">{money(provider.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {/* ── Top sellers ───────────────────────────────────────────────── */}
      {data.topSellers.length > 0 && (
        <Card title="Продавцы по обороту" className="mt-5" padded={false}>
          <Table>
            <thead>
              <tr>
                <th>Продавец</th>
                <th className="num">Качество</th>
                <th className="num">Посылок</th>
                <th className="num">Товары</th>
                <th className="num">Комиссия</th>
              </tr>
            </thead>
            <tbody>
              {data.topSellers.map((entry) => (
                <tr key={entry.sellerId}>
                  <td>
                    <Link href={`/sellers/${entry.sellerId}`} className="font-medium hover:text-[var(--accent)]">
                      {entry.name}
                    </Link>
                  </td>
                  <td className="num">
                    {entry.qualityScore === null ? (
                      '—'
                    ) : (
                      <Pill tone={entry.qualityScore >= 80 ? 'success' : entry.qualityScore >= 60 ? 'warn' : 'danger'}>
                        {entry.qualityScore.toFixed(0)}
                      </Pill>
                    )}
                  </td>
                  <td className="num">{number(entry.subOrders)}</td>
                  <td className="num t-money">{money(entry.goods)}</td>
                  <td className="num t-money">{money(entry.commission)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/* ── Quality (FIT-005 feeds this) ──────────────────────────────── */}
      <Card title="Качество" className="mt-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Отзывы"
            value={data.quality.reviews.average === null ? '—' : data.quality.reviews.average.toFixed(2)}
            hint={`${number(data.quality.reviews.count)} шт.`}
          />
          <Stat
            label="Покупки с низкой уверенностью по размеру"
            value={number(data.quality.lowConfidenceFitPurchases)}
            hint="кандидаты на возврат"
          />
          <Stat label="Отзывов о посадке" value={number(sum(data.quality.fitFeedback))} />
          <Stat label="Возвратов" value={number(sum(data.quality.returns))} />
        </div>
        {Object.keys(data.quality.fitFeedback).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(data.quality.fitFeedback).map(([verdict, count]) => (
              <Pill key={verdict} tone={verdict === 'true_to_size' ? 'success' : 'warn'}>
                {verdict}: {number(count)}
              </Pill>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function sum(record: Record<string, number>): number {
  return Object.values(record ?? {}).reduce((total, value) => total + value, 0);
}

function Row({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: string;
  tone?: 'danger' | 'warn';
  href?: string;
}) {
  const content = (
    <>
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd
        className={cx(
          't-num font-medium',
          tone === 'danger' && 'text-danger',
          tone === 'warn' && 'text-warn',
        )}
      >
        {value}
      </dd>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="flex items-baseline justify-between gap-3 hover:text-[var(--accent)]">
        {content}
      </Link>
    );
  }
  return <div className="flex items-baseline justify-between gap-3">{content}</div>;
}

/* ── Seller overview (§11.1) ─────────────────────────────────────────────── */

function SellerOverviewScreen() {
  const [data, setData] = useState<SellerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await sellerApi.overview());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) {
    return (
      <>
        <PageHeader title="Обзор" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton h-[86px] rounded-[var(--radius-lg)]" />
          ))}
        </div>
      </>
    );
  }

  const outstanding = data.seller.checklist?.filter((item) => !item.done) ?? [];

  return (
    <>
      <PageHeader
        title={data.seller.displayName}
        subtitle={data.seller.legalName}
        action={
          <Pill tone={data.seller.onboardingStatus === 'ACTIVE' ? 'success' : 'accent'}>
            {data.seller.onboardingStatus}
          </Pill>
        }
      />

      {/* SEL-001: what is still missing before this seller can trade. */}
      {outstanding.length > 0 && (
        <div className="mb-5">
          <Note tone="warn" title="Чтобы начать продавать, осталось">
            <ul className="mt-1.5 space-y-1">
              {outstanding.map((item) => (
                <li key={item.key}>· {item.label}</li>
              ))}
            </ul>
          </Note>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="К выплате"
          value={money(data.finance.payableBalance)}
          hint={`доступно ${money(data.finance.availableForPayout)}`}
        />
        <Stat
          label="Заказы к подтверждению"
          value={number(data.pendingOrders)}
          tone={data.pendingOrders > 0 ? 'danger' : undefined}
        />
        <Stat label="Возвраты в работе" value={number(data.pendingReturns)} />
        <Stat label="Товаров" value={number(data.productCount)} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Финансы">
          <dl className="space-y-2 text-[13px]">
            <Row label="Продажи" value={money(data.finance.salesGross)} />
            <Row label="Комиссия платформы" value={`−${money(data.finance.commission)}`} />
            <Row label="Скидки за ваш счёт" value={`−${money(data.finance.discountsSellerFunded)}`} />
            <Row label="Возвраты" value={`−${money(data.finance.refunds)}`} />
            <Row label="Реверс комиссии" value={`+${money(data.finance.commissionReversals)}`} />
            <Row label="Корректировки" value={money(data.finance.adjustments)} />
            <Row label="Уже выплачено" value={money(data.finance.paidOut)} />
            <div className="border-t border-[var(--line)] pt-2">
              <Row label="Баланс" value={money(data.finance.payableBalance)} />
            </div>
            <Row label="Резерв под возвраты" value={money(data.finance.reserve)} />
            {data.finance.hold.amount !== '0' && (
              <Row label="Удержано" value={money(data.finance.hold)} tone="warn" />
            )}
          </dl>
        </Card>

        <QualityCard
          quality={data.quality}
          note="Оценка пересчитывается по заказам и возвратам. Она влияет на позицию ваших товаров в выдаче."
        />
      </div>
    </>
  );
}
