'use client';

/**
 * Storefront content — spec §13, CNT-001 … CNT-003 and ADM-011.
 *
 * Two kinds of content, with different rules:
 *
 *  - Blocks are the Mini App's home screen: hero, rails, promos. ADM-011 says
 *    a block cannot go live in a locale it has no title for, and the API
 *    refuses it. The editor shows the gap per locale while editing, so the
 *    refusal is never a surprise.
 *  - Pages are the legal and informational texts (offer, privacy, delivery),
 *    keyed by slug *and* locale. Each locale is a separate row, and the list
 *    shows which locales a slug is missing — a privacy policy that exists only
 *    in Russian is a compliance gap, not a to-do.
 *
 * The preview reads through the same endpoint the Mini App uses, so what is
 * shown here is what a shopper gets rather than the panel's own rendering.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOCALES, type Locale } from '@fashion/core';
import { errorMessage, useApp } from '@/lib/app-context';
import {
  cms,
  type CmsBlock,
  type CmsBlockKind,
  type CmsPreviewBlock,
  type ContentPageRow,
} from '@/lib/endpoints';
import { date, dateTime, number } from '@/lib/format';
import {
  Button,
  Card,
  ConfirmModal,
  ErrorState,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Pill,
  Select,
  Switch,
  Table,
  Tabs,
  Textarea,
  cx,
} from '@/components/ui';

const LOCALE_NAMES: Record<Locale, string> = { ru: 'Русский', uz: "O'zbekcha", en: 'English' };

/** CNT-001: the block kinds the Mini App knows how to render. */
const KINDS: Array<{ value: CmsBlockKind; label: string }> = [
  { value: 'HERO', label: 'Hero — большой блок сверху' },
  { value: 'BANNER', label: 'Баннер — картинка и ссылка' },
  { value: 'PRODUCT_RAIL', label: 'Полка товаров' },
  { value: 'BRAND_RAIL', label: 'Полка брендов' },
  { value: 'CATEGORY_GRID', label: 'Сетка категорий' },
  { value: 'LOOK_RAIL', label: 'Полка готовых образов' },
  { value: 'SALE_RAIL', label: 'Полка со скидками' },
  { value: 'EDITORIAL', label: 'Редакционный блок' },
  { value: 'AI_PROMPT', label: 'Приглашение к стилисту' },
];

type Pane = 'blocks' | 'pages' | 'preview';

export default function CmsPage() {
  const { can } = useApp();
  const [pane, setPane] = useState<Pane>('blocks');

  return (
    <>
      <PageHeader title="Витрина" subtitle="Блоки главного экрана и информационные страницы" />

      <Tabs
        className="mb-4"
        value={pane}
        onChange={setPane}
        options={[
          { value: 'blocks', label: 'Блоки' },
          { value: 'pages', label: 'Страницы' },
          { value: 'preview', label: 'Предпросмотр' },
        ]}
      />

      {pane === 'blocks' && <Blocks canWrite={can('cms:write')} />}
      {pane === 'pages' && <Pages canWrite={can('cms:write')} />}
      {pane === 'preview' && <Preview />}
    </>
  );
}

/* ── Blocks ──────────────────────────────────────────────────────────────── */

/** Which locales a block is publishable in: ADM-011's rule, read-only. */
function blockGaps(block: Partial<CmsBlock>): Locale[] {
  if (block.kind === 'BANNER') return [];
  const required: Locale[] = block.locales ?? ['ru', 'uz'];
  const titles: Record<Locale, string | null | undefined> = {
    ru: block.titleRu,
    uz: block.titleUz,
    en: block.titleEn,
  };
  return required.filter((locale) => !titles[locale]?.trim());
}

function Blocks({ canWrite }: { canWrite: boolean }) {
  const { toast } = useApp();
  const [rows, setRows] = useState<CmsBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CmsBlock | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CmsBlock | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await cms.blocks();
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (block: Partial<CmsBlock> & { key: string; kind: string }) => {
      setBusy(true);
      try {
        await cms.saveBlock(block);
        toast('Блок сохранён', 'success');
        setEditing(null);
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, load],
  );

  const remove = useCallback(async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await cms.deleteBlock(deleting.key);
      toast('Блок удалён', 'success');
      setDeleting(null);
      await load();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }, [deleting, toast, load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <div className="skeleton h-[220px] rounded-[var(--radius-lg)]" />;

  const liveWithGaps = rows.filter((row) => row.isActive && blockGaps(row).length > 0);

  return (
    <>
      {liveWithGaps.length > 0 && (
        <div className="mb-4">
          <Note tone="warn" title="Активные блоки без перевода">
            {liveWithGaps.length} блок(ов) показываются, но не заполнены во всех обязательных
            локалях. Покупатель на узбекском увидит пустое место там, где должен быть заголовок.
          </Note>
        </div>
      )}

      <Card
        title={`Блоки · ${number(rows.length)}`}
        padded={false}
        action={
          canWrite ? (
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              Новый блок
            </Button>
          ) : undefined
        }
      >
        <Table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Ключ</th>
              <th>Тип</th>
              <th>Заголовок (RU)</th>
              <th>Локали</th>
              <th>Показ</th>
              <th>Период</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-[13px] text-[var(--fg-muted)]">
                  Блоков нет — главный экран покажет каталог без подборок
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const gaps = blockGaps(row);
                return (
                  <tr key={row.id}>
                    <td className="num t-num text-[var(--fg-faint)]">{row.sortOrder}</td>
                    <td className="t-mono text-[12.5px]">{row.key}</td>
                    <td className="text-[12.5px] text-[var(--fg-muted)]">{row.kind}</td>
                    <td className="max-w-[220px] truncate">{row.titleRu ?? '—'}</td>
                    <td>
                      <div className="flex gap-1">
                        {LOCALES.map((locale) => {
                          const filled = !gaps.includes(locale);
                          const title =
                            locale === 'ru' ? row.titleRu : locale === 'uz' ? row.titleUz : row.titleEn;
                          return (
                            <Pill
                              key={locale}
                              tone={title ? 'success' : filled ? 'neutral' : 'warn'}
                              title={title ?? 'не заполнено'}
                            >
                              {locale.toUpperCase()}
                            </Pill>
                          );
                        })}
                      </div>
                    </td>
                    <td>
                      {row.isActive ? (
                        <Pill tone={gaps.length > 0 ? 'warn' : 'success'}>показывается</Pill>
                      ) : (
                        <Pill tone="neutral">скрыт</Pill>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                      {row.startsAt ? date(row.startsAt) : 'сразу'}
                      {' → '}
                      {row.endsAt ? date(row.endsAt) : 'бессрочно'}
                    </td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        {canWrite && (
                          <>
                            <Button size="xs" variant="ghost" onClick={() => setEditing(row)}>
                              Изменить
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => setDeleting(row)}>
                              Удалить
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Card>

      {editing && (
        <BlockEditor
          block={editing === 'new' ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}

      {deleting && (
        <ConfirmModal
          open
          onClose={() => setDeleting(null)}
          onConfirm={remove}
          busy={busy}
          danger
          title="Удалить блок"
          confirmLabel="Удалить"
          body={
            <p>
              Блок <span className="t-mono">{deleting.key}</span> исчезнёт с главного экрана. Если
              нужно временно убрать его — лучше снять галочку «Показывать».
            </p>
          }
        />
      )}
    </>
  );
}

function BlockEditor({
  block,
  busy,
  onClose,
  onSave,
}: {
  block: CmsBlock | null;
  busy: boolean;
  onClose: () => void;
  onSave: (block: Partial<CmsBlock> & { key: string; kind: CmsBlockKind }) => void;
}) {
  const [draft, setDraft] = useState(() => ({
    key: block?.key ?? '',
    kind: (block?.kind ?? 'PRODUCT_RAIL') as CmsBlockKind,
    titleRu: block?.titleRu ?? '',
    titleUz: block?.titleUz ?? '',
    titleEn: block?.titleEn ?? '',
    subtitleRu: block?.subtitleRu ?? '',
    subtitleUz: block?.subtitleUz ?? '',
    subtitleEn: block?.subtitleEn ?? '',
    ctaLabelRu: block?.ctaLabelRu ?? '',
    ctaLabelUz: block?.ctaLabelUz ?? '',
    ctaLabelEn: block?.ctaLabelEn ?? '',
    ctaHref: block?.ctaHref ?? '',
    imageUrl: block?.imageUrl ?? '',
    sortOrder: String(block?.sortOrder ?? 0),
    isActive: block?.isActive ?? false,
    config: JSON.stringify(block?.config ?? {}, null, 2),
  }));
  const [locale, setLocale] = useState<Locale>('ru');

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const configValid = useMemo(() => {
    if (draft.config.trim() === '') return true;
    try {
      const parsed: unknown = JSON.parse(draft.config);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, [draft.config]);

  const gaps = blockGaps({
    kind: draft.kind,
    titleRu: draft.titleRu,
    titleUz: draft.titleUz,
    titleEn: draft.titleEn,
  } as Partial<CmsBlock>);

  // ADM-011: the API refuses to activate a block with a missing title, so the
  // button refuses first and names the locale.
  const blockedByLocale = draft.isActive && gaps.length > 0;
  const valid = /^[a-z0-9][a-z0-9._-]{1,78}$/.test(draft.key) && configValid && !blockedByLocale;

  const titleField = locale === 'ru' ? 'titleRu' : locale === 'uz' ? 'titleUz' : 'titleEn';
  const subtitleField = locale === 'ru' ? 'subtitleRu' : locale === 'uz' ? 'subtitleUz' : 'subtitleEn';
  const ctaField = locale === 'ru' ? 'ctaLabelRu' : locale === 'uz' ? 'ctaLabelUz' : 'ctaLabelEn';

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={block ? `Блок · ${block.key}` : 'Новый блок'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            title={
              blockedByLocale
                ? `Нет заголовка для локали: ${gaps.map((item) => item.toUpperCase()).join(', ')}`
                : undefined
            }
            onClick={() =>
              onSave({
                key: draft.key.trim(),
                kind: draft.kind,
                titleRu: draft.titleRu.trim() || null,
                titleUz: draft.titleUz.trim() || null,
                titleEn: draft.titleEn.trim() || null,
                subtitleRu: draft.subtitleRu.trim() || null,
                subtitleUz: draft.subtitleUz.trim() || null,
                subtitleEn: draft.subtitleEn.trim() || null,
                ctaLabelRu: draft.ctaLabelRu.trim() || null,
                ctaLabelUz: draft.ctaLabelUz.trim() || null,
                ctaLabelEn: draft.ctaLabelEn.trim() || null,
                ctaHref: draft.ctaHref.trim() || null,
                imageUrl: draft.imageUrl.trim() || null,
                sortOrder: Number(draft.sortOrder) || 0,
                isActive: draft.isActive,
                config: draft.config.trim() ? (JSON.parse(draft.config) as Record<string, unknown>) : {},
              })
            }
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Ключ" required hint="Латиница, цифры, точка, дефис. Менять у живого блока не стоит.">
          <Input
            value={draft.key}
            disabled={Boolean(block)}
            onChange={(event) => set('key', event.target.value.toLowerCase())}
          />
        </Field>
        <Field label="Тип">
          <Select
            value={draft.kind}
            onChange={(event) => set('kind', event.target.value as CmsBlockKind)}
          >
            {KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-4">
        <Tabs
          value={locale}
          onChange={setLocale}
          options={LOCALES.map((value) => ({
            value,
            label: (
              <span className="flex items-center gap-1.5">
                {LOCALE_NAMES[value]}
                {gaps.includes(value) && <span className="text-warn">•</span>}
              </span>
            ),
          }))}
        />
        <div className="mt-3.5 grid gap-3.5">
          <Field
            label="Заголовок"
            required={locale !== 'en' && draft.kind !== 'BANNER'}
            hint={locale === 'en' ? 'EN необязателен (D-09)' : undefined}
          >
            <Input value={draft[titleField]} onChange={(event) => set(titleField, event.target.value)} />
          </Field>
          <Field label="Подзаголовок">
            <Input
              value={draft[subtitleField]}
              onChange={(event) => set(subtitleField, event.target.value)}
            />
          </Field>
          <Field label="Текст кнопки">
            <Input value={draft[ctaField]} onChange={(event) => set(ctaField, event.target.value)} />
          </Field>
        </div>
      </div>

      <div className="mt-4 grid gap-3.5 sm:grid-cols-2">
        <Field label="Ссылка кнопки" hint="Путь внутри Mini App, например /catalog?style=smart_casual">
          <Input value={draft.ctaHref} onChange={(event) => set('ctaHref', event.target.value)} />
        </Field>
        <Field label="Картинка">
          <Input value={draft.imageUrl} onChange={(event) => set('imageUrl', event.target.value)} />
        </Field>
        <Field label="Порядок" hint="Меньше — выше на экране">
          <Input
            type="number"
            value={draft.sortOrder}
            onChange={(event) => set('sortOrder', event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field
          label="Параметры (JSON)"
          error={configValid ? null : 'Это не объект JSON'}
          hint="Например, фильтр полки: { &quot;style&quot;: &quot;smart_casual&quot;, &quot;limit&quot;: 12 }"
        >
          <Textarea
            rows={5}
            className="t-mono text-[12px]"
            value={draft.config}
            onChange={(event) => set('config', event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Switch
          checked={draft.isActive}
          onChange={(next) => set('isActive', next)}
          label="Показывать на главном экране"
          hint="Блок без заголовка в обязательной локали опубликовать нельзя (ADM-011)"
        />
      </div>

      {blockedByLocale && (
        <div className="mt-3">
          <Note tone="warn">
            Не заполнены заголовки: {gaps.map((item) => LOCALE_NAMES[item]).join(', ')}. Заполните их
            или снимите галочку «Показывать».
          </Note>
        </div>
      )}
    </Modal>
  );
}

/* ── Pages ───────────────────────────────────────────────────────────────── */

type PageRow = ContentPageRow;

function Pages({ canWrite }: { canWrite: boolean }) {
  const { toast } = useApp();
  const [rows, setRows] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PageRow | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await cms.pages();
      setRows(data.items);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** A slug is complete when RU and UZ exist; EN is a SHOULD (D-09). */
  const bySlug = useMemo(() => {
    const map = new Map<string, Partial<Record<Locale, PageRow>>>();
    for (const row of rows ?? []) {
      const entry = map.get(row.slug) ?? {};
      entry[row.locale] = row;
      map.set(row.slug, entry);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const save = useCallback(
    async (body: Parameters<typeof cms.savePage>[0]) => {
      setBusy(true);
      try {
        await cms.savePage(body);
        toast('Страница сохранена', 'success');
        setEditing(null);
        await load();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast, load],
  );

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <div className="skeleton h-[220px] rounded-[var(--radius-lg)]" />;

  const missingRequired = bySlug.filter(([, locales]) => !locales.ru || !locales.uz);

  return (
    <>
      {missingRequired.length > 0 && (
        <div className="mb-4">
          <Note tone="warn" title="Страницы без обязательной локали">
            RU и UZ обязательны (D-09). Не хватает переводов для:{' '}
            {missingRequired.map(([slug]) => slug).join(', ')}. Для публичной оферты и политики
            конфиденциальности это не задача на потом, а требование.
          </Note>
        </div>
      )}

      <Card
        title="Страницы"
        padded={false}
        action={
          canWrite ? (
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              Новая страница
            </Button>
          ) : undefined
        }
      >
        <Table>
          <thead>
            <tr>
              <th>Адрес</th>
              {LOCALES.map((locale) => (
                <th key={locale}>{locale.toUpperCase()}</th>
              ))}
              <th>Обновлено</th>
            </tr>
          </thead>
          <tbody>
            {bySlug.length === 0 ? (
              <tr>
                <td colSpan={LOCALES.length + 2} className="py-8 text-center text-[13px] text-[var(--fg-muted)]">
                  Страниц нет
                </td>
              </tr>
            ) : (
              bySlug.map(([slug, locales]) => {
                const latest = Object.values(locales)
                  .map((row) => row?.updatedAt)
                  .filter(Boolean)
                  .sort()
                  .pop();
                return (
                  <tr key={slug}>
                    <td className="t-mono text-[12.5px]">/{slug}</td>
                    {LOCALES.map((locale) => {
                      const row = locales[locale];
                      return (
                        <td key={locale}>
                          {row ? (
                            <button
                              type="button"
                              onClick={() => canWrite && setEditing(row)}
                              className={cx(
                                'text-left text-[12.5px]',
                                canWrite && 'hover:text-[var(--accent-deep)]',
                              )}
                            >
                              <Pill tone={row.isPublished ? 'success' : 'neutral'}>
                                {row.isPublished ? 'опубликована' : 'черновик'}
                              </Pill>
                            </button>
                          ) : (
                            <Pill tone={locale === 'en' ? 'neutral' : 'warn'}>
                              {locale === 'en' ? 'нет' : 'нужен перевод'}
                            </Pill>
                          )}
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap text-[12px] text-[var(--fg-muted)]">
                      {latest ? dateTime(latest) : '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Card>

      <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-faint)]">
        Каждая локаль — отдельная запись: это позволяет публиковать русскую версию, пока узбекская
        на переводе, и видеть разрыв, а не прятать его за одной галочкой.
      </p>

      {editing && (
        <PageEditor
          page={editing === 'new' ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </>
  );
}

function PageEditor({
  page,
  busy,
  onClose,
  onSave,
}: {
  page: PageRow | null;
  busy: boolean;
  onClose: () => void;
  onSave: (body: {
    slug: string;
    locale: Locale;
    title: string;
    body: string;
    kind?: string;
    publish?: boolean;
  }) => void;
}) {
  const [slug, setSlug] = useState(page?.slug ?? '');
  const [locale, setLocale] = useState<Locale>(page?.locale ?? 'ru');
  const [title, setTitle] = useState(page?.title ?? '');
  const [body, setBody] = useState(page?.body ?? '');
  const [publish, setPublish] = useState(page?.isPublished ?? false);

  const valid = /^[a-z0-9][a-z0-9-]{1,60}$/.test(slug) && title.trim().length >= 2 && body.trim().length >= 10;

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title={page ? `${page.slug} · ${page.locale.toUpperCase()}` : 'Новая страница'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() =>
              onSave({
                slug: slug.trim(),
                locale,
                title: title.trim(),
                body,
                kind: page?.kind ?? 'PAGE',
                publish,
              })
            }
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Адрес" required hint="Например privacy, offer, delivery">
          <Input
            value={slug}
            disabled={Boolean(page)}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
          />
        </Field>
        <Field label="Язык" required>
          <Select
            value={locale}
            disabled={Boolean(page)}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            {LOCALES.map((value) => (
              <option key={value} value={value}>
                {LOCALE_NAMES[value]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-3.5">
        <Field label="Заголовок" required>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
      </div>

      <div className="mt-3.5">
        <Field label="Текст" required hint="Markdown: заголовки #, списки -, выделение **жирным**">
          <Textarea
            rows={16}
            className="t-mono text-[12.5px] leading-relaxed"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Switch
          checked={publish}
          onChange={setPublish}
          label="Опубликовать"
          hint="Опубликованная страница сразу доступна покупателям в Mini App и в боте"
        />
      </div>
    </Modal>
  );
}

/* ── Preview (CNT-002) ───────────────────────────────────────────────────── */

function Preview() {
  const [locale, setLocale] = useState<Locale>('ru');
  const [items, setItems] = useState<CmsPreviewBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    cms
      .preview(locale)
      .then((data) => {
        if (!cancelled) setItems(data.items);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  return (
    <>
      <div className="mb-4 flex items-end gap-3">
        <Field label="Язык" className="w-[200px]">
          <Select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
            {LOCALES.map((value) => (
              <option key={value} value={value}>
                {LOCALE_NAMES[value]}
              </option>
            ))}
          </Select>
        </Field>
        <p className="pb-1 text-[12px] leading-relaxed text-[var(--fg-muted)]">
          Читается тем же запросом, что и Mini App. Скрытые блоки показаны пунктиром: так видно
          и то, что увидит покупатель, и то, что готово, но ещё не включено.
        </p>
      </div>

      {error && <Note tone="danger">{error}</Note>}
      {!items && !error && <div className="skeleton h-[200px] rounded-[var(--radius-lg)]" />}

      {items && (
        <div className="mx-auto max-w-[420px] space-y-3 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-sunken)] p-4">
          {items.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-[var(--fg-muted)]">
              Активных блоков для этой локали нет
            </p>
          ) : (
            items.map((item) => (
              <div
                key={item.key}
                className={cx(
                  'rounded-[var(--radius-md)] border p-3.5',
                  item.isActive
                    ? 'border-[var(--line)] bg-[var(--bg-raised)]'
                    : 'border-dashed border-[var(--line)] bg-transparent opacity-60',
                )}
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <Pill tone="neutral">{item.kind}</Pill>
                  {!item.isActive && <Pill tone="warn">скрыт</Pill>}
                  {item.scheduled && <Pill tone="info">по расписанию</Pill>}
                  <span className="t-mono text-[11px] text-[var(--fg-faint)]">{item.key}</span>
                </div>
                {item.title ? <p className="text-[15px] font-medium">{item.title}</p> : null}
                {item.subtitle ? (
                  <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">{item.subtitle}</p>
                ) : null}
                {item.ctaLabel ? (
                  <span className="mt-2.5 inline-block rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--on-accent)]">
                    {item.ctaLabel}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
