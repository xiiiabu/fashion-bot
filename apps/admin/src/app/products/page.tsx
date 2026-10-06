'use client';

/**
 * Catalogue moderation — spec §10.2, CAT-006 (the publish checklist) and
 * ADM-011 (locale completeness).
 *
 * The publish check is the point of this screen. A product is not published by
 * someone deciding it looks fine; it is published when every blocking item
 * passes, and the panel shows exactly which ones do not.
 */

import { useCallback, useEffect, useState } from 'react';
import { allowedTransitions, type ProductLifecycle } from '@fashion/core';
import { API_BASE } from '@/lib/api';
import { errorMessage, useApp } from '@/lib/app-context';
import { catalog, type ProductRow } from '@/lib/endpoints';
import { dateTime, mediaUrl, money, nameOf, number } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  CopyId,
  Modal,
  Note,
  PageHeader,
  Pill,
  Table,
  Textarea,
  cx,
} from '@/components/ui';
import { FilterSelect, ListBody, ListFooter, SearchBox, useList } from '@/components/data-screen';
import { LIFECYCLE_OPTIONS, lifecycleLabel, lifecycleTone } from '@/lib/status';

const PAGE = 25;

/** ADM-011: the fields that must exist in every required locale. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Название',
  description: 'Описание',
  composition: 'Состав',
};

/**
 * What a transition means in words. The machine (CAT-009) decides which are
 * legal from a given state; this only names them, so the button says what the
 * operator is doing rather than naming a state they have to decode.
 */
const TRANSITION_LABELS: Record<string, string> = {
  DRAFT: 'Вернуть в черновик',
  IN_REVIEW: 'На модерацию',
  PUBLISHED: 'Опубликовать',
  ARCHIVED: 'В архив',
  REJECTED: 'Отклонить',
};

/** A transition that takes a product off the shop floor, or refuses it. */
const DESTRUCTIVE = new Set<string>(['ARCHIVED', 'REJECTED']);

export default function ProductsPage() {
  const { can, toast } = useApp();
  const [lifecycle, setLifecycle] = useState('');
  const [query, setQuery] = useState('');
  const [checking, setChecking] = useState<ProductRow | null>(null);
  const [acting, setActing] = useState<{ product: ProductRow; to: ProductLifecycle } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const list = useList<ProductRow>(
    (offset) =>
      catalog
        .products({ lifecycle: lifecycle || undefined, q: query || undefined, limit: PAGE, offset })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [lifecycle, query],
    PAGE,
  );

  const applyAction = useCallback(async () => {
    if (!acting) return;
    setBusy(true);
    try {
      await catalog.setLifecycle(acting.product.id, acting.to, reason.trim() || undefined);
      toast('Статус товара обновлён', 'success');
      setActing(null);
      setReason('');
      list.reload();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [acting, reason, toast, list]);

  return (
    <>
      <PageHeader
        title="Товары"
        subtitle={`${number(list.total)} в каталоге`}
        action={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="Название или артикул" />
            <FilterSelect
              value={lifecycle}
              onChange={setLifecycle}
              options={LIFECYCLE_OPTIONS}
              allLabel="Все статусы"
            />
            {can('product:write') && (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await catalog.reindex();
                    toast('Поисковый индекс перестроен', 'success');
                  } catch (caught) {
                    toast(errorMessage(caught), 'error');
                  }
                }}
              >
                Переиндексировать
              </Button>
            )}
          </>
        }
      />

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th style={{ width: 44 }} />
              <th>Товар</th>
              <th>Бренд</th>
              <th>Продавец</th>
              <th>Статус</th>
              <th className="num">SKU</th>
              <th className="num">Остаток</th>
              <th className="num">Цена от</th>
              <th>Локали</th>
              <th>Обновлён</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <ListBody state={list} columns={11} emptyTitle="Товаров не найдено">
              {(rows) =>
                rows.map((product) => {
                  const image = mediaUrl(product.imageUrl, API_BASE);
                  return (
                    <tr key={product.id}>
                      <td>
                        <div className="h-9 w-9 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--bg-sunken)]">
                          {image && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
                          )}
                        </div>
                      </td>
                      <td className="max-w-[260px]">
                        <p className="truncate font-medium" title={product.title}>
                          {product.title}
                        </p>
                        <p className="t-mono truncate text-[11px] text-[var(--fg-faint)]">{product.slug}</p>
                      </td>
                      <td>{nameOf(product.brand)}</td>
                      <td>{nameOf(product.seller)}</td>
                      <td>
                        <Pill tone={lifecycleTone(product.lifecycle)}>{lifecycleLabel(product.lifecycle)}</Pill>
                      </td>
                      <td className="num">{number(product.skuCount)}</td>
                      <td className={cx('num', product.onHand === 0 && 'text-danger')}>
                        {number(product.onHand)}
                      </td>
                      <td className="num t-money">{money(product.priceFrom)}</td>
                      <td>
                        {/* ADM-011: a product missing a required locale cannot be
                            published, so the gap is visible in the list. */}
                        <Pill tone={product.localeComplete ? 'success' : 'warn'}>
                          {product.localeComplete ? 'полные' : 'неполные'}
                        </Pill>
                      </td>
                      <td className="whitespace-nowrap text-[var(--fg-muted)]">{dateTime(product.updatedAt)}</td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          <Button size="xs" variant="ghost" onClick={() => setChecking(product)}>
                            Проверка
                          </Button>
                          {can('product:publish') &&
                            (allowedTransitions('product', product.lifecycle) as ProductLifecycle[]).map(
                              (to) => (
                                <Button
                                  key={to}
                                  size="xs"
                                  variant={
                                    to === 'PUBLISHED' ? 'primary' : DESTRUCTIVE.has(to) ? 'ghost' : 'outline'
                                  }
                                  onClick={() => setActing({ product, to })}
                                >
                                  {TRANSITION_LABELS[to] ?? lifecycleLabel(to)}
                                </Button>
                              ),
                            )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              }
            </ListBody>
          </tbody>
        </Table>
        <ListFooter state={list} />
      </Card>

      {checking && <PublishCheck product={checking} onClose={() => setChecking(null)} />}

      {acting && (
        <Modal
          open
          onClose={() => setActing(null)}
          title={TRANSITION_LABELS[acting.to] ?? lifecycleLabel(acting.to)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setActing(null)}>
                Отмена
              </Button>
              <Button variant="primary" loading={busy} onClick={applyAction}>
                Применить
              </Button>
            </>
          }
        >
          <p className="text-[13.5px]">{acting.product.title}</p>
          <div className="mt-3">
            <span className="t-label mb-1 block">Причина (попадёт в аудит)</span>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
          </div>
          {acting.to === 'PUBLISHED' && !acting.product.localeComplete && (
            <div className="mt-3">
              <Note tone="warn">
                У товара заполнены не все обязательные локали. Публикация может быть отклонена
                проверкой на сервере.
              </Note>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

/** CAT-006: the checklist, with the blocking items separated from the advice. */
function PublishCheck({ product, onClose }: { product: ProductRow; onClose: () => void }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof catalog.publishCheck>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    catalog
      .publishCheck(product.id)
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  return (
    <Modal open onClose={onClose} title="Проверка перед публикацией" footer={<Button onClick={onClose}>Закрыть</Button>}>
      <p className="mb-3 text-[13.5px] font-medium">{product.title}</p>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      {!result && !error && <div className="skeleton h-24 w-full" />}
      {result && (
        <div className="space-y-3">
          <Note tone={result.ready ? 'success' : 'danger'}>
            {result.ready ? 'Товар можно публиковать.' : 'Публикация заблокирована.'}
          </Note>
          {result.blockers.length > 0 && (
            <div>
              <h3 className="t-eyebrow mb-1.5 text-danger">Блокирует публикацию</h3>
              <ul className="space-y-1 text-[13px]">
                {result.blockers.map((item) => (
                  <li key={`${item.code}:${item.field ?? ''}`} className="flex gap-2">
                    <span className="text-danger">✗</span>
                    <span>{item.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {Object.keys(result.localeCompleteness).length > 0 && (
            <div>
              <h3 className="t-eyebrow mb-1.5">Локализация</h3>
              <ul className="space-y-1 text-[13px]">
                {Object.entries(result.localeCompleteness).map(([field, state]) => (
                  <li key={field} className="flex gap-2">
                    <span className={state.complete ? 'text-success' : 'text-warn'}>
                      {state.complete ? '✓' : '!'}
                    </span>
                    <span>
                      {FIELD_LABELS[field] ?? field}
                      {state.complete
                        ? ''
                        : ` — не заполнено: ${state.missing.map((l) => l.toUpperCase()).join(', ')}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.warnings.length > 0 && (
            <div>
              <h3 className="t-eyebrow mb-1.5">Рекомендации</h3>
              <ul className="space-y-1 text-[13px] text-[var(--fg-muted)]">
                {result.warnings.map((item) => (
                  <li key={item.code} className="flex gap-2">
                    <span className="text-warn">!</span>
                    <span>{item.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
