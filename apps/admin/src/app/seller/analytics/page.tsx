'use client';

/**
 * Seller analytics — spec §11.6, SEL-008 and RET-009.
 *
 * Four numbers a seller can act on, and one they are judged by.
 *
 * The return reasons table is the most useful thing here and the reason the
 * screen exists: a size-driven return is a measurement problem, not a
 * difficult customer, and it is fixable by editing a size chart. Separating it
 * from the rest is what makes that visible.
 *
 * The quality score is shown with its factors for the same reason it is on the
 * platform side: a seller told "0.72" can do nothing; a seller told "11 of 40
 * confirmations were late" can.
 */

import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/app-context';
import { seller } from '@/lib/endpoints';
import { money, number, percent, ratio } from '@/lib/format';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  Note,
  PageHeader,
  Pill,
  Stat,
  Table,
} from '@/components/ui';
import { QualityCard } from '@/components/quality';

const REASON_LABELS: Record<string, string> = {
  SIZE_TOO_SMALL: 'Мал размер',
  SIZE_TOO_LARGE: 'Велик размер',
  SIZE_WRONG: 'Не подошёл размер',
  NOT_AS_DESCRIBED: 'Не соответствует описанию',
  QUALITY: 'Качество',
  DEFECT: 'Брак',
  DAMAGED: 'Повреждён при доставке',
  WRONG_ITEM: 'Прислали не то',
  CHANGED_MIND: 'Передумал',
  LATE_DELIVERY: 'Долгая доставка',
  OTHER: 'Другое',
};

/** Reasons the seller can actually fix by changing data, not behaviour. */
const FIXABLE_BY_DATA = new Set(['SIZE_TOO_SMALL', 'SIZE_TOO_LARGE', 'SIZE_WRONG', 'NOT_AS_DESCRIBED']);

export default function SellerAnalyticsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof seller.analytics>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      setData(await seller.analytics({ from: from || undefined, to: to || undefined }));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;

  const sizeShare =
    data && data.returns.total > 0 ? (data.returns.bySizeReason / data.returns.total) * 100 : 0;
  const returnRate =
    data && data.totals.itemCount > 0 ? (data.returns.total / data.totals.itemCount) * 100 : 0;

  return (
    <>
      <PageHeader
        title="Аналитика"
        subtitle="Продажи, возвраты и оценка качества магазина"
        action={
          <>
            <Field label="С" className="w-[150px]">
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field label="По" className="w-[150px]">
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
            {(from || to) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFrom('');
                  setTo('');
                }}
              >
                За всё время
              </Button>
            )}
          </>
        }
      />

      {!data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton h-[86px] rounded-[var(--radius-lg)]" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Заказов" value={number(data.totals.orderCount)} />
            <Stat
              label="Оборот"
              value={money(data.totals.gmv)}
              hint={`средний заказ ${money(data.totals.averageOrderValue)}`}
            />
            <Stat
              label="Комиссия платформы"
              value={money(data.totals.commission)}
              hint="10% от стоимости товаров"
            />
            <Stat
              label="Доля возвратов"
              value={percent(returnRate)}
              hint={`${number(data.returns.total)} из ${number(data.totals.itemCount)} вещей`}
              tone={returnRate > 20 ? 'danger' : returnRate > 10 ? 'warn' : undefined}
            />
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card title="Продажи">
              <dl className="space-y-2 text-[13px]">
                <Row label="Стоимость товаров" value={money(data.totals.goods)} />
                <Row label="Скидки" value={`−${money(data.totals.discounts)}`} />
                <Row label="Доставка" value={money(data.totals.delivery)} />
                <Row label="Оборот" value={money(data.totals.gmv)} />
                <Row label="Возвращено" value={`−${money(data.totals.refunded)}`} />
                <div className="border-t border-[var(--line)] pt-2">
                  <Row label="Вещей продано" value={number(data.totals.itemCount)} />
                  <Row label="Вещей в заказе" value={ratio(data.totals.itemsPerOrder)} />
                </div>
              </dl>
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
                Оборот считается по оплаченным заказам. Доставка показана отдельно, потому что в
                базу комиссии она не входит.
              </p>
            </Card>

            <QualityCard
              quality={data.quality}
              note="Оценка влияет на то, как часто ваши товары показываются в каталоге и в подборках стилиста."
            />
          </div>

          {/* RET-009: the number the size charts are judged by. */}
          {data.returns.total > 0 && (
            <>
              {sizeShare > 30 && (
                <div className="mt-5">
                  <Note tone="warn" title="Главная причина возвратов — размер">
                    {percent(sizeShare)} возвратов — из-за размера. Это почти всегда размерная
                    сетка или замеры конкретных моделей, а не покупатели: подсказка размера строится
                    на ваших замерах, и ошибка в сантиметре возвращается вещью. Проверьте замеры у
                    моделей из таблицы ниже.
                  </Note>
                </div>
              )}

              <Card className="mt-5" title="Причины возвратов" padded={false}>
                <Table>
                  <thead>
                    <tr>
                      <th>Причина</th>
                      <th className="num">Количество</th>
                      <th className="num">Доля</th>
                      <th>Что с этим делать</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.returns.reasons)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason, count]) => {
                        const share = (count / data.returns.total) * 100;
                        return (
                          <tr key={reason}>
                            <td>{REASON_LABELS[reason] ?? reason}</td>
                            <td className="num t-num">{number(count)}</td>
                            <td className="num t-num">{percent(share)}</td>
                            <td className="text-[12.5px] text-[var(--fg-muted)]">
                              {FIXABLE_BY_DATA.has(reason) ? (
                                <span className="flex items-center gap-1.5">
                                  <Pill tone="accent">исправимо</Pill>
                                  {reason === 'NOT_AS_DESCRIBED'
                                    ? 'уточнить описание, состав и фотографии'
                                    : 'проверить размерную сетку и замеры модели'}
                                </span>
                              ) : reason === 'DEFECT' || reason === 'WRONG_ITEM' ? (
                                <span className="flex items-center gap-1.5">
                                  <Pill tone="danger">контроль сборки</Pill>
                                  проверка перед передачей курьеру
                                </span>
                              ) : (
                                'нормальный фон розницы'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </Table>
              </Card>
            </>
          )}

          {data.returns.total === 0 && (
            <div className="mt-5">
              <Note tone="success">Возвратов за период не было.</Note>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="t-money shrink-0">{value}</dd>
    </div>
  );
}
