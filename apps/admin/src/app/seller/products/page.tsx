'use client';

/**
 * Seller catalogue — spec §11.2, SEL-002, CAT-006, INV-004.
 *
 * A seller can edit and submit; publishing is the platform's call. So the
 * important thing here is the publish check: it tells the seller exactly what
 * is missing *before* they submit, instead of leaving them to guess why a
 * product sat in moderation for two days.
 *
 * Stock has three numbers and they are not the same thing. On-hand is what is
 * in the room. Safety stock (INV-004) is what is held back from sale so the
 * last unit is never sold twice while two carts are open. The low-stock
 * threshold only decides when to warn. Showing them separately is the
 * difference between a seller who oversells and one who does not.
 */

import { useCallback, useEffect, useState } from 'react';
import { errorMessage, useApp } from '@/lib/app-context';
import { seller, type ImportReport, type ProductRow } from '@/lib/endpoints';
import { API_BASE } from '@/lib/api';
import { dateTime, mediaUrl, money, nameOf, number } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  CopyId,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Pill,
  Table,
  Tabs,
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

type Pane = 'catalog' | 'import';

export default function SellerProductsPage() {
  const [pane, setPane] = useState<Pane>('catalog');

  return (
    <>
      <PageHeader title="Каталог" subtitle="Товары, остатки и загрузка из файла" />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'catalog', label: 'Товары' },
          { value: 'import', label: 'Загрузка из CSV' },
        ]}
      />

      {pane === 'catalog' ? <Catalog /> : <Import />}
    </>
  );
}

/* ── Catalogue ───────────────────────────────────────────────────────────── */

function Catalog() {
  const { can, toast } = useApp();
  const [query, setQuery] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [checking, setChecking] = useState<ProductRow | null>(null);
  const [submitting, setSubmitting] = useState<ProductRow | null>(null);
  const [stockFor, setStockFor] = useState<ProductRow | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useList<ProductRow>(
    (offset) =>
      seller
        .products({ q: query || undefined, lifecycle: lifecycle || undefined, limit: PAGE, offset })
        .then((page) => ({ rows: page.rows, total: page.total })),
    [query, lifecycle],
    PAGE,
  );

  const submit = useCallback(async () => {
    if (!submitting) return;
    setBusy(true);
    try {
      await seller.submitProduct(submitting.id);
      toast('Товар отправлен на модерацию', 'success');
      setSubmitting(null);
      list.reload();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [submitting, toast, list]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-[var(--fg-muted)]">{number(list.total)} товаров</p>
        <div className="flex items-center gap-2">
          <SearchBox value={query} onChange={setQuery} placeholder="Название или артикул" />
          <FilterSelect
            value={lifecycle}
            onChange={setLifecycle}
            options={LIFECYCLE_OPTIONS}
            allLabel="Все статусы"
          />
        </div>
      </div>

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <th style={{ width: 44 }} />
              <th>Товар</th>
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
            <ListBody state={list} columns={9} emptyTitle="Товаров нет">
              {(rows) =>
                rows.map((product) => {
                  const image = mediaUrl(product.imageUrl, API_BASE);
                  const canSubmit = product.lifecycle === 'DRAFT' || product.lifecycle === 'REJECTED';
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
                      <td className="max-w-[280px]">
                        <p className="truncate font-medium" title={product.title}>
                          {product.title}
                        </p>
                        <p className="t-mono truncate text-[11px] text-[var(--fg-faint)]">
                          {product.externalId ?? product.slug}
                        </p>
                      </td>
                      <td>
                        <Pill tone={lifecycleTone(product.lifecycle)}>
                          {lifecycleLabel(product.lifecycle)}
                        </Pill>
                      </td>
                      <td className="num t-num">{number(product.skuCount)}</td>
                      <td className={cx('num t-num', product.onHand === 0 && 'font-semibold text-danger')}>
                        {number(product.onHand)}
                      </td>
                      <td className="num t-money">{money(product.priceFrom)}</td>
                      <td>
                        {/* ADM-011: RU and UZ are required to publish. */}
                        <Pill tone={product.localeComplete ? 'success' : 'warn'}>
                          {product.localeComplete ? 'полные' : 'неполные'}
                        </Pill>
                      </td>
                      <td className="whitespace-nowrap text-[var(--fg-muted)]">
                        {dateTime(product.updatedAt)}
                      </td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          <Button size="xs" variant="ghost" onClick={() => setChecking(product)}>
                            Проверка
                          </Button>
                          {can('inventory:write') && (
                            <Button size="xs" variant="ghost" onClick={() => setStockFor(product)}>
                              Остаток
                            </Button>
                          )}
                          {can('product:write') && canSubmit && (
                            <Button size="xs" variant="primary" onClick={() => setSubmitting(product)}>
                              На модерацию
                            </Button>
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

      <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
        Публикует товары платформа — так проверяются фотографии, замеры и права на контент. Перед
        отправкой на модерацию запустите проверку: она показывает ровно то, что помешает публикации.
      </p>

      {checking && <PublishCheck product={checking} onClose={() => setChecking(null)} />}

      {stockFor && (
        <StockModal
          product={stockFor}
          onClose={() => setStockFor(null)}
          onSaved={() => {
            setStockFor(null);
            list.reload();
          }}
        />
      )}

      {submitting && (
        <ConfirmModal
          open
          onClose={() => setSubmitting(null)}
          onConfirm={submit}
          busy={busy}
          title="Отправить на модерацию"
          confirmLabel="Отправить"
          body={
            <>
              <p>{submitting.title}</p>
              {!submitting.localeComplete && (
                <div className="mt-3">
                  <Note tone="warn">
                    Заполнены не все обязательные локали. Модерация, скорее всего, вернёт товар —
                    быстрее дозаполнить сейчас.
                  </Note>
                </div>
              )}
              {submitting.onHand === 0 && (
                <div className="mt-3">
                  <Note tone="warn">
                    Остаток нулевой. Опубликованный товар без остатка не попадёт ни в каталог, ни в
                    подборки стилиста.
                  </Note>
                </div>
              )}
            </>
          }
        />
      )}
    </>
  );
}

/* ── Publish check (CAT-006) ────────────────────────────────────────────── */

function PublishCheck({ product, onClose }: { product: ProductRow; onClose: () => void }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof seller.publishCheck>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    seller
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
    <Modal
      open
      onClose={onClose}
      title="Проверка перед публикацией"
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <p className="mb-3 text-[13.5px] font-medium">{product.title}</p>
      {error && <Note tone="danger">{error}</Note>}
      {!result && !error && <div className="skeleton h-24 w-full" />}
      {result && (
        <div className="space-y-3">
          <Note tone={result.ready ? 'success' : 'danger'}>
            {result.ready
              ? 'Товар готов к публикации — можно отправлять на модерацию.'
              : 'Публикация заблокирована: сначала нужно закрыть пункты ниже.'}
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
              <h3 className="t-eyebrow mb-1.5 text-warn">Стоит исправить</h3>
              <ul className="space-y-1 text-[13px]">
                {result.warnings.map((item) => (
                  <li key={item.code} className="flex gap-2">
                    <span className="text-warn">!</span>
                    <span>{item.message}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--fg-faint)]">
                Это не помешает публикации, но влияет на то, как часто товар показывается и как
                точно работает подсказка размера.
              </p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ── Stock (INV-004) ────────────────────────────────────────────────────── */

/**
 * The stock numbers live on a nested inventory record, not on the SKU — the
 * first pass read them off the SKU and showed zero everywhere, which for a
 * seller checking why something is out of stock is worse than showing nothing.
 */
interface SkuInventory {
  onHand?: number;
  reserved?: number;
  safetyStock?: number;
  lowStockThreshold?: number;
  location?: string | null;
  lastFeedAt?: string | null;
}

interface SkuRow {
  id: string;
  sizeLabel?: string;
  colorName?: string;
  sellerSku?: string | null;
  barcode?: string | null;
  inventory?: SkuInventory | null;
  [extra: string]: unknown;
}

function StockModal({
  product,
  onClose,
  onSaved,
}: {
  product: ProductRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [skus, setSkus] = useState<SkuRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkuRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const detail = await seller.product(product.id);
      setSkus(((detail.skus as SkuRow[] | undefined) ?? []).slice());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [product.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title={`Остатки · ${product.title}`}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      {error && <Note tone="danger">{error}</Note>}
      {!skus && !error && <div className="skeleton h-[160px] w-full rounded-[var(--radius-md)]" />}

      {skus && (
        <>
          <Table>
            <thead>
              <tr>
                <th>Размер</th>
                <th>Цвет</th>
                <th className="num">В наличии</th>
                <th className="num">В заказах</th>
                <th className="num">Резерв</th>
                <th className="num">Доступно</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {skus.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-[13px] text-[var(--fg-muted)]">
                    У товара нет SKU
                  </td>
                </tr>
              ) : (
                skus.map((sku) => {
                  const onHand = sku.inventory?.onHand ?? 0;
                  const reserved = sku.inventory?.reserved ?? 0;
                  const safety = sku.inventory?.safetyStock ?? 0;
                  const available = Math.max(0, onHand - reserved - safety);
                  return (
                    <tr key={sku.id}>
                      <td className="font-medium">{sku.sizeLabel ?? '—'}</td>
                      <td className="text-[12.5px] text-[var(--fg-muted)]">{sku.colorName ?? '—'}</td>
                      <td className="num t-num">{number(onHand)}</td>
                      <td className="num t-num text-[var(--fg-muted)]">{number(reserved)}</td>
                      <td className="num t-num text-[var(--fg-muted)]">{number(safety)}</td>
                      <td className={cx('num t-num font-semibold', available === 0 && 'text-danger')}>
                        {number(available)}
                      </td>
                      <td className="text-right">
                        <Button size="xs" variant="ghost" onClick={() => setEditing(sku)}>
                          Изменить
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </Table>

          <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
            «Доступно» = в наличии − в заказах − резерв. Резерв (INV-004) — это страховка от
            двойной продажи последней вещи: пока два покупателя держат её в корзине, продать можно
            только одну.
          </p>
        </>
      )}

      {editing && (
        <StockForm
          sku={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            setBusy(true);
            try {
              await seller.setStock(editing.id, body);
              toast('Остаток обновлён', 'success');
              setEditing(null);
              await load();
              onSaved();
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </Modal>
  );
}

function StockForm({
  sku,
  busy,
  onClose,
  onSave,
}: {
  sku: SkuRow;
  busy: boolean;
  onClose: () => void;
  onSave: (body: { onHand?: number; safetyStock?: number; lowStockThreshold?: number }) => void;
}) {
  const [onHand, setOnHand] = useState(String(sku.inventory?.onHand ?? 0));
  const [safety, setSafety] = useState(String(sku.inventory?.safetyStock ?? 0));
  const [threshold, setThreshold] = useState(String(sku.inventory?.lowStockThreshold ?? 0));

  const reserved = sku.inventory?.reserved ?? 0;
  const parsed = {
    onHand: Number(onHand),
    safetyStock: Number(safety),
    lowStockThreshold: Number(threshold),
  };
  const valid = Object.values(parsed).every((value) => Number.isInteger(value) && value >= 0);
  // Setting on-hand below what is already promised to buyers oversells.
  const belowReserved = valid && parsed.onHand < reserved;

  return (
    <Modal
      open
      onClose={onClose}
      title={`SKU · ${sku.sizeLabel ?? ''} ${sku.colorName ?? ''}`.trim()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => onSave(parsed)}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <Field label="В наличии" hint="Сколько физически есть у вас на складе">
          <Input
            type="number"
            min={0}
            value={onHand}
            onChange={(event) => setOnHand(event.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="Резерв"
          hint="Сколько держать вне продажи. 1 на ходовых размерах почти всегда стоит того."
        >
          <Input type="number" min={0} value={safety} onChange={(event) => setSafety(event.target.value)} />
        </Field>
        <Field label="Порог «мало осталось»" hint="При каком остатке предупреждать вас">
          <Input
            type="number"
            min={0}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
          />
        </Field>
      </div>

      {reserved > 0 && (
        <div className="mt-3">
          <Note tone={belowReserved ? 'danger' : 'neutral'}>
            {belowReserved
              ? `В заказах уже ${reserved} шт. Если поставить ${parsed.onHand}, часть заказов останется без товара — их придётся отменять.`
              : `${reserved} шт уже в заказах покупателей и в это число входят.`}
          </Note>
        </div>
      )}

      {sku.sellerSku && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--fg-faint)]">
          Артикул: <span className="t-mono">{sku.sellerSku}</span>
          {sku.inventory?.location ? ` · склад ${sku.inventory.location}` : ''}
          {sku.inventory?.lastFeedAt
            ? `. Остатки последний раз приходили из вашей системы ${dateTime(sku.inventory.lastFeedAt)} — ручная правка продержится до следующей синхронизации.`
            : ''}
        </p>
      )}
    </Modal>
  );
}

/* ── CSV import (SEL-002) ───────────────────────────────────────────────── */

function Import() {
  const { can, toast } = useApp();
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<Array<Record<string, unknown>> | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const data = await seller.importJobs();
      setJobs(data.items);
    } catch {
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const run = useCallback(
    async (dryRun: boolean) => {
      setBusy(true);
      try {
        const result = await seller.importCsv({
          fileName: fileName || 'catalog.csv',
          content,
          dryRun,
        });
        setReport(result);
        toast(
          dryRun
            ? `Проверка: создастся ${result.summary.created}, обновится ${result.summary.updated}`
            : `Загружено: создано ${result.summary.created}, обновлено ${result.summary.updated}`,
          result.summary.invalid > 0 ? 'error' : 'success',
        );
        if (!dryRun) void loadJobs();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [fileName, content, toast, loadJobs],
  );

  const download = useCallback(async () => {
    try {
      const response = await seller.importTemplate();
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'catalog-template.csv';
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  }, [toast]);

  const dryRunClean = report?.dryRun && report.summary.invalid === 0;

  return (
    <>
      <div className="mb-4">
        <Note tone="neutral" title="Сначала проверка, потом загрузка">
          Проверка ничего не меняет: она разбирает файл и показывает, что получится. Загружайте
          только после того, как проверка пройдёт чисто — отменить загрузку одной кнопкой нельзя.
        </Note>
      </div>

      <Card
        title="Файл"
        action={
          <Button size="sm" variant="outline" onClick={download}>
            Скачать шаблон
          </Button>
        }
      >
        <div className="grid gap-3.5">
          <Field label="Имя файла" hint="Попадёт в историю загрузок — так потом понятно, что это было">
            <Input
              value={fileName}
              onChange={(event) => setFileName(event.target.value)}
              placeholder="catalog-oct.csv"
            />
          </Field>

          <Field
            label="Содержимое CSV"
            hint="Вставьте содержимое файла. Первая строка — заголовки из шаблона."
          >
            <Textarea
              rows={10}
              className="t-mono text-[12px]"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setReport(null);
              }}
            />
          </Field>

          <label className="text-[12.5px] text-[var(--fg-muted)]">
            …или выберите файл:{' '}
            <input
              type="file"
              accept=".csv,text/csv"
              className="text-[12.5px]"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setFileName(file.name);
                setContent(await file.text());
                setReport(null);
              }}
            />
          </label>
        </div>

        {can('product:write') && (
          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="outline"
              loading={busy}
              disabled={content.trim().length < 10}
              onClick={() => void run(true)}
            >
              Проверить
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!dryRunClean}
              title={dryRunClean ? undefined : 'Сначала проверьте файл — загрузка откроется после чистой проверки'}
              onClick={() => void run(false)}
            >
              Загрузить
            </Button>
          </div>
        )}
      </Card>

      {report && (
        <Card className="mt-5" title={report.dryRun ? 'Результат проверки' : 'Результат загрузки'}>
          <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            <Metric label="Строк" value={report.summary.total} />
            <Metric label="Создано" value={report.summary.created} />
            <Metric label="Обновлено" value={report.summary.updated} />
            <Metric label="С ошибками" value={report.summary.invalid} danger={report.summary.invalid > 0} />
          </div>

          {report.errors.length > 0 && (
            <div className="mt-4">
              <h3 className="t-eyebrow mb-1.5 text-danger">Ошибки</h3>
              <ul className="space-y-1 text-[12.5px]">
                {report.errors.slice(0, 30).map((item, index) => (
                  <li key={index} className="flex gap-2">
                    <span className="t-num shrink-0 text-[var(--fg-faint)]">
                      {item.row !== undefined ? `стр. ${item.row}` : '—'}
                    </span>
                    <span>{item.message ?? JSON.stringify(item)}</span>
                  </li>
                ))}
              </ul>
              {report.errors.length > 30 && (
                <p className="mt-1.5 text-[12px] text-[var(--fg-faint)]">
                  …и ещё {report.errors.length - 30}
                </p>
              )}
            </div>
          )}

          {report.dryRun && report.summary.invalid === 0 && (
            <div className="mt-4">
              <Note tone="success">Файл разобран без ошибок — можно загружать.</Note>
            </div>
          )}
        </Card>
      )}

      {jobs && jobs.length > 0 && (
        <Card className="mt-5" title="История загрузок" padded={false}>
          <Table>
            <thead>
              <tr>
                <th>Файл</th>
                <th>Статус</th>
                <th className="num">Создано</th>
                <th className="num">Обновлено</th>
                <th>Когда</th>
              </tr>
            </thead>
            <tbody>
              {jobs.slice(0, 15).map((job) => (
                <tr key={String(job.id)}>
                  <td className="max-w-[220px] truncate">{String(job.fileName ?? '—')}</td>
                  <td>
                    <Pill
                      tone={
                        job.status === 'COMPLETED'
                          ? 'success'
                          : job.status === 'FAILED'
                            ? 'danger'
                            : 'info'
                      }
                    >
                      {String(job.status ?? '')}
                      {job.dryRun ? ' (проверка)' : ''}
                    </Pill>
                  </td>
                  <td className="num t-num">{number(Number(job.createdRows ?? 0))}</td>
                  <td className="num t-num">{number(Number(job.updatedRows ?? 0))}</td>
                  <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                    {job.finishedAt ? dateTime(String(job.finishedAt)) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function Metric({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div>
      <p className="t-label">{label}</p>
      <p className={cx('t-money mt-0.5 text-[20px]', danger && 'text-danger')}>{number(value)}</p>
    </div>
  );
}
