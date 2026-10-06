/**
 * Human labels for the shared taxonomy — spec USR-001.
 *
 * The keys are the taxonomy codes exactly as @fashion/core defines them. They
 * are mostly lower case (`navy`, `old_money`, `office`) with the exception of
 * seasons and outfit slots, which are upper case. Getting that wrong is not a
 * cosmetic slip: an upper-case key simply misses, and the UI then renders the
 * raw code — which is how the colour filter ended up showing grey swatches
 * labelled "BLACK".
 *
 * Colour and style names also exist in core's message catalogue, because the
 * stylist's explanation and the bot's messages interpolate them. Everything
 * here is purely presentational and belongs to whichever app renders it.
 */

import {
  COLOR_FAMILIES,
  OCCASIONS,
  OUTFIT_SLOTS,
  SEASONS,
  SILHOUETTES,
  STYLE_TAGS,
  type ColorFamily,
} from '@fashion/core';

type Trio = readonly [ru: string, uz: string, en: string];
type LabelMap = Readonly<Record<string, Trio>>;

const INDEX: Record<string, 0 | 1 | 2> = { ru: 0, uz: 1, en: 2 };

function pick(map: LabelMap, key: string, locale: string, fallback?: string): string {
  const trio = map[key];
  if (!trio) return fallback ?? key.replace(/_/g, ' ');
  return trio[INDEX[locale] ?? 0];
}

/* ── Colours ─────────────────────────────────────────────────────────────── */

const COLORS: LabelMap = {
  black: ['Чёрный', 'Qora', 'Black'],
  white: ['Белый', 'Oq', 'White'],
  grey: ['Серый', 'Kulrang', 'Grey'],
  beige: ['Бежевый', 'Bej', 'Beige'],
  brown: ['Коричневый', 'Qoʻngʻir', 'Brown'],
  navy: ['Тёмно-синий', 'Toʻq koʻk', 'Navy'],
  blue: ['Синий', 'Koʻk', 'Blue'],
  green: ['Зелёный', 'Yashil', 'Green'],
  olive: ['Оливковый', 'Zaytun', 'Olive'],
  red: ['Красный', 'Qizil', 'Red'],
  burgundy: ['Бордовый', 'Bordo', 'Burgundy'],
  pink: ['Розовый', 'Pushti', 'Pink'],
  purple: ['Фиолетовый', 'Binafsha', 'Purple'],
  yellow: ['Жёлтый', 'Sariq', 'Yellow'],
  orange: ['Оранжевый', 'Toʻq sariq', 'Orange'],
  cream: ['Кремовый', 'Krem', 'Cream'],
  camel: ['Кэмел', 'Kamel', 'Camel'],
  silver: ['Серебряный', 'Kumush', 'Silver'],
  gold: ['Золотой', 'Tilla', 'Gold'],
  multicolor: ['Разноцветный', 'Rang-barang', 'Multicolour'],
  print: ['С принтом', 'Naqshli', 'Printed'],
};

/**
 * Swatches for the colour facet and the style quiz. Chosen as the mid-tone a
 * garment of that family actually photographs as, not the CSS keyword: a real
 * "white" shirt is bone, and `#fff` on a white card would be invisible.
 */
export const COLOR_SWATCHES: Record<string, string> = {
  black: '#15120f',
  white: '#f4f1ec',
  grey: '#9a948c',
  beige: '#d8c5a8',
  brown: '#7a5336',
  navy: '#22304f',
  blue: '#3d6ea8',
  green: '#4f7a52',
  olive: '#6f7445',
  red: '#a63a33',
  burgundy: '#6b2635',
  pink: '#dba6ae',
  purple: '#6c4a7d',
  yellow: '#d8b247',
  orange: '#c87338',
  cream: '#efe4cf',
  camel: '#c19a6b',
  silver: '#b9bcc0',
  gold: '#b8903f',
  multicolor: 'linear-gradient(135deg,#a63a33,#d8b247,#3d6ea8,#4f7a52)',
  // A print is a pattern, not a colour; the swatch says so rather than
  // picking one of its colours and implying the garment is that colour.
  print:
    'repeating-linear-gradient(45deg,#8c7a63 0 4px,#d8c5a8 4px 8px)',
};

/* ── Styles ──────────────────────────────────────────────────────────────── */

const STYLES: LabelMap = {
  old_money: ['Old money', 'Old money', 'Old money'],
  quiet_luxury: ['Тихая роскошь', 'Sokin hashamat', 'Quiet luxury'],
  business_formal: ['Деловой формальный', 'Rasmiy ishbilarmon', 'Business formal'],
  business_casual: ['Деловой свободный', 'Erkin ishbilarmon', 'Business casual'],
  smart_casual: ['Smart casual', 'Smart casual', 'Smart casual'],
  minimal: ['Минимализм', 'Minimalizm', 'Minimal'],
  streetwear: ['Стритвир', 'Stritvir', 'Streetwear'],
  sporty: ['Спортивный', 'Sport', 'Sporty'],
  athleisure: ['Athleisure', 'Athleisure', 'Athleisure'],
  bohemian: ['Бохо', 'Boho', 'Bohemian'],
  romantic: ['Романтичный', 'Romantik', 'Romantic'],
  evening: ['Вечерний', 'Kechki', 'Evening'],
  resort: ['Курортный', 'Kurort', 'Resort'],
  y2k: ['Y2K', 'Y2K', 'Y2K'],
  preppy: ['Preppy', 'Preppy', 'Preppy'],
  workwear: ['Workwear', 'Workwear', 'Workwear'],
  national_modern: ['Национальный модерн', 'Milliy zamonaviy', 'Modern national'],
  avant_garde: ['Авангард', 'Avangard', 'Avant-garde'],
};

/* ── Occasions ───────────────────────────────────────────────────────────── */

const OCCASION_LABELS: LabelMap = {
  office: ['Офис', 'Ofis', 'Office'],
  business_meeting: ['Деловая встреча', 'Ishbilarmon uchrashuv', 'Business meeting'],
  everyday: ['Каждый день', 'Har kuni', 'Everyday'],
  date: ['Свидание', 'Uchrashuv', 'Date'],
  wedding_guest: ['Свадьба, гость', 'Toʻy mehmoni', 'Wedding guest'],
  celebration: ['Торжество', 'Tantana', 'Celebration'],
  evening_out: ['Вечер в городе', 'Kechki sayr', 'Evening out'],
  travel: ['Поездка', 'Safar', 'Travel'],
  sport: ['Спорт', 'Sport', 'Sport'],
  home: ['Дом', 'Uy', 'At home'],
  university: ['Университет', 'Universitet', 'University'],
  interview: ['Собеседование', 'Suhbat', 'Interview'],
};

/* ── Seasons (upper case in the taxonomy) ───────────────────────────────── */

const SEASON_LABELS: LabelMap = {
  SS: ['Весна–лето', 'Bahor–yoz', 'Spring/Summer'],
  FW: ['Осень–зима', 'Kuz–qish', 'Autumn/Winter'],
  ALL_SEASON: ['Всесезон', 'Barcha fasl', 'All season'],
  SUMMER: ['Лето', 'Yoz', 'Summer'],
  WINTER: ['Зима', 'Qish', 'Winter'],
  TRANSITIONAL: ['Межсезонье', 'Fasllar orasi', 'Transitional'],
};

/* ── Silhouettes ─────────────────────────────────────────────────────────── */

const SILHOUETTE_LABELS: LabelMap = {
  fitted: ['Облегающий', 'Tanaga yaqin', 'Fitted'],
  straight: ['Прямой', 'Toʻgʻri', 'Straight'],
  slim: ['Узкий', 'Tor', 'Slim'],
  relaxed: ['Свободный', 'Erkin', 'Relaxed'],
  oversized: ['Оверсайз', 'Oversayz', 'Oversized'],
  a_line: ['А-силуэт', 'A-siluet', 'A-line'],
  wide_leg: ['Широкие', 'Keng', 'Wide leg'],
  tapered: ['Суженный', 'Toraygan', 'Tapered'],
  cropped: ['Укороченный', 'Qisqa', 'Cropped'],
  longline: ['Удлинённый', 'Uzaytirilgan', 'Longline'],
  flared: ['Расклешённый', 'Yoyilgan', 'Flared'],
};

/* ── Outfit slots (upper case in the taxonomy) ──────────────────────────── */

const SLOT_LABELS: LabelMap = {
  HEADWEAR: ['Головной убор', 'Bosh kiyim', 'Headwear'],
  OUTERWEAR: ['Верхняя одежда', 'Ustki kiyim', 'Outerwear'],
  TOP: ['Верх', 'Ustki', 'Top'],
  MID_LAYER: ['Средний слой', 'Oʻrta qatlam', 'Mid layer'],
  BOTTOM: ['Низ', 'Pastki', 'Bottom'],
  FULL_BODY: ['Цельный образ', 'Butun kiyim', 'Full body'],
  FOOTWEAR: ['Обувь', 'Poyabzal', 'Footwear'],
  BAG: ['Сумка', 'Sumka', 'Bag'],
  ACCESSORY: ['Аксессуар', 'Aksessuar', 'Accessory'],
};

/* ── Fit verdicts ────────────────────────────────────────────────────────── */

const FIT_VERDICTS: LabelMap = {
  runs_small: ['Маломерит', 'Kichik keladi', 'Runs small'],
  true_to_size: ['В размер', 'Oʻlchamiga mos', 'True to size'],
  runs_large: ['Большемерит', 'Katta keladi', 'Runs large'],
  unknown: ['Данных мало', 'Maʼlumot kam', 'Not enough data'],
};

/* ── Numeric scales ──────────────────────────────────────────────────────── */

/**
 * Formality and warmth are 1–5 scales, not enums, because the stylist's
 * compatibility rules compare them numerically. The shopper sees a word for
 * the step; "3/5" means nothing on a product page.
 */
const FORMALITY: LabelMap = {
  '1': ['Очень неформальный', 'Juda erkin', 'Very casual'],
  '2': ['Неформальный', 'Erkin', 'Casual'],
  '3': ['Smart casual', 'Smart casual', 'Smart casual'],
  '4': ['Деловой', 'Ishbilarmon', 'Business'],
  '5': ['Торжественный', 'Tantanali', 'Formal'],
};

const WARMTH: LabelMap = {
  '1': ['Без утепления', 'Issiqliksiz', 'No insulation'],
  '2': ['Лёгкое', 'Yengil', 'Light'],
  '3': ['Среднее', 'Oʻrta', 'Medium'],
  '4': ['Тёплое', 'Issiq', 'Warm'],
  '5': ['Очень тёплое', 'Juda issiq', 'Very warm'],
};

/* ── Public API ──────────────────────────────────────────────────────────── */

export const colorLabel = (value: string, locale: string) => pick(COLORS, value, locale);
export const styleLabel = (value: string, locale: string) => pick(STYLES, value, locale);
export const occasionLabel = (value: string, locale: string) => pick(OCCASION_LABELS, value, locale);
export const seasonLabel = (value: string, locale: string) => pick(SEASON_LABELS, value, locale);
export const silhouetteLabel = (value: string, locale: string) =>
  pick(SILHOUETTE_LABELS, value, locale);
export const slotLabel = (value: string, locale: string) => pick(SLOT_LABELS, value, locale);
export const fitVerdictLabel = (value: string, locale: string) => pick(FIT_VERDICTS, value, locale);
export const formalityLabel = (value: number, locale: string) =>
  pick(FORMALITY, String(value), locale, `${value}/5`);
export const warmthLabel = (value: number, locale: string) =>
  pick(WARMTH, String(value), locale, `${value}/5`);

export function colorSwatch(family: ColorFamily | string): string {
  return COLOR_SWATCHES[family] ?? '#9a948c';
}

/**
 * Reports taxonomy values this file has no label for, keyed by taxonomy. Used
 * by the label coverage test: a code without a label reaches the shopper as a
 * raw identifier, which is how `BLACK` and `color.brown` both got shipped, so
 * the gap is worth failing a build over rather than discovering in the UI.
 */
export function missingLabels(): Record<string, string[]> {
  const gaps: Record<string, string[]> = {};
  const report = (name: string, codes: readonly string[], map: LabelMap) => {
    const missing = codes.filter((code) => !(code in map));
    if (missing.length > 0) gaps[name] = missing;
  };
  report('color', COLOR_FAMILIES, COLORS);
  report('style', STYLE_TAGS, STYLES);
  report('occasion', OCCASIONS, OCCASION_LABELS);
  report('season', SEASONS, SEASON_LABELS);
  report('silhouette', SILHOUETTES, SILHOUETTE_LABELS);
  report('slot', OUTFIT_SLOTS, SLOT_LABELS);

  const swatchGaps = COLOR_FAMILIES.filter((family) => !(family in COLOR_SWATCHES));
  if (swatchGaps.length > 0) gaps.swatch = swatchGaps;

  // Fit preferences are labelled in copy.ts under fit.preference.*, alongside
  // the rest of the fit copy, so they are checked there rather than here —
  // looking for them in core's catalogue reported a gap that did not exist.
  return gaps;
}
