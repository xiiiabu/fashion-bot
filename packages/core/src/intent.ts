/**
 * Natural-language style intent parser — spec AI-001.
 *
 * "Собери old money образ для офиса до 4 000 000 UZS" must become a stored,
 * structured intent. This parser is deterministic and offline: it is the
 * source of truth for constraints even when an LLM is configured, because
 * budget, brand exclusions and season decide which SKUs are retrievable and
 * those decisions must be reproducible for audit (AI-009).
 *
 * The lexicons cover Russian, Uzbek (Latin) and English, which is the language
 * matrix the spec requires (USR-001).
 */

import { type CurrencyCode, type Money, fromMajor } from './money.js';
import {
  type ColorFamily,
  type Occasion,
  type OutfitSlot,
  type Season,
  type StyleTag,
} from './taxonomy.js';
import type { StyleIntent } from './outfit.js';

type Lexicon<T extends string> = Array<readonly [T, readonly string[]]>;

const STYLE_LEXICON: Lexicon<StyleTag> = [
  ['old_money', ['old money', 'олд мани', 'олдмани', 'old-money', 'тихая роскошь', 'аристократ']],
  ['quiet_luxury', ['quiet luxury', 'куайт лакшери', 'тихая роскошь', 'sokin hashamat', 'лакшери']],
  ['business_formal', ['деловой', 'формальный', 'костюм', 'офисный строгий', 'business formal', 'rasmiy', 'ishbilarmon']],
  ['business_casual', ['business casual', 'бизнес кэжуал', 'бизнес-кэжуал', 'полуформальный']],
  ['smart_casual', ['smart casual', 'смарт кэжуал', 'смарт-кэжуал', 'повседневный элегантный']],
  ['minimal', ['минимализм', 'минималистичный', 'минимал', 'minimal', 'sodda', 'лаконичный']],
  ['streetwear', ['стритвир', 'street', 'уличный', 'streetwear', 'кэжуал уличный']],
  ['sporty', ['спортивный', 'sport', 'sportiv', 'для спорта', 'тренировка', 'mashg‘ulot', 'mashgulot']],
  ['athleisure', ['athleisure', 'спорт-шик', 'спортшик', 'casual sport']],
  ['bohemian', ['бохо', 'boho', 'bohemian', 'этно']],
  ['romantic', ['романтичный', 'романтический', 'romantik', 'женственный', 'нежный']],
  ['evening', ['вечерний', 'вечерн', 'evening', 'kechki', 'коктейльный', 'выход', 'торжеств']],
  ['resort', ['курортный', 'resort', 'отпуск', 'пляж', 'ta‘til', 'tatil']],
  ['y2k', ['y2k', 'нулевые', '2000-е']],
  ['preppy', ['preppy', 'преппи', 'студенческий классический']],
  ['workwear', ['workwear', 'ворквир', 'рабочий', 'утилитарный', 'utility']],
  ['national_modern', ['национальный', 'milliy', 'этнический узбекский', 'адрас', 'atlas', 'адрасовый']],
  ['avant_garde', ['авангард', 'avant', 'концептуальный']],
];

const OCCASION_LEXICON: Lexicon<Occasion> = [
  ['office', ['офис', 'на работу', 'для работы', 'ofis', 'ish uchun', 'office', 'в офис']],
  ['business_meeting', ['встреча', 'переговоры', 'презентац', 'uchrashuv', 'meeting', 'клиент']],
  ['interview', ['собеседование', 'интервью', 'suhbat', 'interview']],
  ['everyday', ['каждый день', 'повседнев', 'на каждый', 'kundalik', 'everyday', 'прогулк', 'daily']],
  ['date', ['свидание', 'uchrashuvga', 'date', 'на свидание']],
  ['wedding_guest', ['свадьб', 'to‘y', 'toy ', 'wedding', 'на свадьбу']],
  ['celebration', ['праздник', 'день рожден', 'bayram', 'юбилей', 'celebration', 'туган кун']],
  ['evening_out', ['вечеринк', 'ресторан', 'бар', 'вечером', 'kechqurun', 'night out', 'клуб']],
  ['travel', ['путешеств', 'поездк', 'в дорогу', 'sayohat', 'travel', 'аэропорт', 'отпуск']],
  ['sport', ['спортзал', 'зал', 'бег', 'фитнес', 'yoga', 'йога', 'sport', 'тренировк']],
  ['home', ['дома', 'домашн', 'uy uchun', 'home', 'лофт']],
  ['university', ['универ', 'учёб', 'учеб', 'институт', 'universitet', 'study', 'студент']],
];

const COLOR_LEXICON: Lexicon<ColorFamily> = [
  ['black', ['чёрн', 'черн', 'qora', 'black']],
  ['white', ['бел', 'oq ', 'white', 'белый']],
  ['grey', ['сер', 'kulrang', 'grey', 'gray', 'графит']],
  ['beige', ['беж', 'bej', 'beige']],
  ['cream', ['крем', 'молочн', 'cream', 'экрю', 'ecru']],
  ['brown', ['коричнев', 'шоколад', 'jigarrang', 'brown']],
  ['camel', ['кэмел', 'camel', 'верблюж']],
  ['navy', ['тёмно-син', 'темно-син', 'navy', 'индиго', 'тёмно син']],
  ['blue', ['син', 'голуб', 'ko‘k', 'kok ', 'blue']],
  ['green', ['зелён', 'зелен', 'yashil', 'green']],
  ['olive', ['олив', 'хаки', 'khaki', 'olive']],
  ['red', ['красн', 'qizil', 'red']],
  ['burgundy', ['бордов', 'марсал', 'burgundy', 'вишнёв', 'вишнев']],
  ['pink', ['розов', 'pushti', 'pink']],
  ['purple', ['фиолет', 'сирен', 'лиловый', 'purple', 'violet']],
  ['yellow', ['жёлт', 'желт', 'sariq', 'yellow', 'горчичн']],
  ['orange', ['оранж', 'терракот', 'orange']],
  ['silver', ['серебр', 'silver']],
  ['gold', ['золот', 'oltin', 'gold']],
  ['print', ['принт', 'узор', 'цветочн', 'print', 'pattern', 'в полоск', 'клетк']],
  ['multicolor', ['разноцвет', 'мультиколор', 'multicolor']],
];

const SEASON_LEXICON: Lexicon<Season> = [
  ['WINTER', ['зим', 'qish', 'winter', 'мороз', 'холодн']],
  ['SUMMER', ['лет', 'yoz', 'summer', 'жар', 'жарк']],
  ['TRANSITIONAL', ['осен', 'весн', 'kuz', 'bahor', 'autumn', 'spring', 'демисезон', 'межсезон']],
  ['FW', ['fw', 'осень-зима', 'fall winter']],
  ['SS', ['ss', 'весна-лето', 'spring summer']],
];

const SLOT_LEXICON: Lexicon<OutfitSlot> = [
  ['OUTERWEAR', ['пальто', 'куртк', 'пиджак', 'блейзер', 'плащ', 'тренч', 'palto', 'kurtka', 'coat', 'jacket', 'blazer', 'шуб', 'пуховик']],
  ['TOP', ['рубашк', 'футболк', 'блуз', 'топ', 'ko‘ylak', 'koylak', 'shirt', 'tshirt', 't-shirt', 'поло', 'лонгслив']],
  ['MID_LAYER', ['свитер', 'джемпер', 'кардиган', 'худи', 'свитшот', 'вязан', 'sviter', 'sweater', 'hoodie', 'кофт', 'жилет']],
  ['BOTTOM', ['брюк', 'джинс', 'юбк', 'шорт', 'штан', 'shim', 'jins', 'trousers', 'jeans', 'skirt', 'чинос']],
  ['FULL_BODY', ['платье', 'костюм', 'комбинезон', 'ko‘ylak liboS', 'dress', 'suit', 'сарафан']],
  ['FOOTWEAR', ['обув', 'кроссовк', 'туфл', 'ботин', 'лоферы', 'сапог', 'oyoq kiyim', 'poyabzal', 'shoes', 'sneakers', 'boots', 'кеды', 'мокасин']],
  ['BAG', ['сумк', 'рюкзак', 'клатч', 'sumka', 'bag', 'backpack']],
  ['ACCESSORY', ['ремен', 'пояс', 'шарф', 'платок', 'украшен', 'аксессуар', 'kamar', 'belt', 'scarf', 'очки']],
  ['HEADWEAR', ['шапк', 'кепк', 'панам', 'шляп', 'bosh kiyim', 'hat', 'cap']],
];

const GENDER_LEXICON: Lexicon<'women' | 'men' | 'unisex'> = [
  ['women', ['женск', 'для женщин', 'девушк', 'ayollar', 'women', 'female', 'для неё', 'для нее']],
  ['men', ['мужск', 'для мужчин', 'парн', 'erkaklar', 'men', 'male', 'для него']],
  ['unisex', ['унисекс', 'unisex']],
];

const NEGATION_MARKERS = [
  'без',
  'не ',
  'кроме',
  'исключ',
  'не хочу',
  'не нужно',
  'avoid',
  'without',
  'no ',
  'yo‘q',
  'yoq ',
  'emas',
  'tashqari',
];

export interface ParsedIntent extends StyleIntent {
  /** Normalised copy of what the shopper typed, for the audit trail (AI-009). */
  readonly rawQuery: string;
  readonly language: 'ru' | 'uz' | 'en';
  /** 0..1 — how much of the query the parser actually understood. */
  readonly parseConfidence: number;
  /** Tokens the parser could not map; surfaced so merch can grow the lexicon. */
  readonly unmatchedTerms: string[];
  /** Free-text search terms to pass to the catalogue search. */
  readonly searchTerms: string[];
}

export interface ParseOptions {
  readonly currency?: CurrencyCode;
  /** Structured constraints from UI chips always win over parsed text. */
  readonly overrides?: Partial<StyleIntent>;
  readonly defaultLanguage?: 'ru' | 'uz' | 'en';
}

export function parseStyleIntent(query: string, options: ParseOptions = {}): ParsedIntent {
  const currency = options.currency ?? 'UZS';
  const raw = query ?? '';
  const normalized = normalize(raw);
  const language = detectLanguage(raw, options.defaultLanguage);

  let matchedChars = 0;
  const matchedTerms = new Set<string>();

  const collect = <T extends string>(lexicon: Lexicon<T>): { positive: T[]; negative: T[] } => {
    const positive: T[] = [];
    const negative: T[] = [];
    for (const [value, needles] of lexicon) {
      for (const needle of needles) {
        const index = normalized.indexOf(normalize(needle));
        if (index === -1) continue;
        matchedChars += needle.length;
        matchedTerms.add(normalize(needle));
        if (isNegated(normalized, index)) {
          if (!negative.includes(value)) negative.push(value);
        } else if (!positive.includes(value)) {
          positive.push(value);
        }
        break;
      }
    }
    return { positive, negative };
  };

  const styles = collect(STYLE_LEXICON);
  const occasions = collect(OCCASION_LEXICON);
  const colors = collect(COLOR_LEXICON);
  const seasons = collect(SEASON_LEXICON);
  const slots = collect(SLOT_LEXICON);
  const genders = collect(GENDER_LEXICON);

  const budget = parseBudget(normalized, currency);
  if (budget) matchedChars += 8;

  const unmatchedTerms = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4)
    .filter((token) => ![...matchedTerms].some((term) => term.includes(token) || token.includes(term)))
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 12);

  const parseConfidence = raw.trim().length === 0
    ? 0
    : Math.max(0, Math.min(1, matchedChars / Math.max(normalized.length, 1) + (budget ? 0.15 : 0)));

  const intent: ParsedIntent = {
    rawQuery: raw.trim(),
    language,
    styles: styles.positive,
    occasions: occasions.positive,
    season: seasons.positive[0] ?? null,
    budget,
    preferredColors: colors.positive,
    avoidColors: colors.negative,
    preferredBrandIds: [],
    excludedBrandIds: [],
    requiredSlots: slots.positive,
    excludedSlots: slots.negative,
    gender: genders.positive[0] ?? null,
    freeText: raw.trim(),
    parseConfidence: Number(parseConfidence.toFixed(3)),
    unmatchedTerms,
    searchTerms: unmatchedTerms.slice(0, 6),
    ...stripUndefined(options.overrides ?? {}),
  };

  return intent;
}

/**
 * Budget phrases in all three languages:
 *   "до 4 000 000", "до 4 млн", "4 млн сум", "under 4m", "4 mln so'mga"
 */
function parseBudget(normalized: string, currency: CurrencyCode): Money | null {
  const patterns: Array<{ re: RegExp; multiplier: number }> = [
    { re: /(?:до|dan|under|max|maksimum|budjet|бюджет|не больше|не более)\D{0,12}(\d[\d\s.,]*)\s*(?:млн|mln|million|миллион|м\b|m\b)/u, multiplier: 1_000_000 },
    { re: /(?:до|dan|under|max|maksimum|budjet|бюджет|не больше|не более)\D{0,12}(\d[\d\s.,]*)\s*(?:тыс|ming|k\b|тысяч)/u, multiplier: 1_000 },
    { re: /(?:до|dan|under|max|maksimum|budjet|бюджет|не больше|не более)\D{0,12}(\d[\d\s.,]{2,})/u, multiplier: 1 },
    { re: /(\d[\d\s.,]*)\s*(?:млн|mln|million|миллион)\D{0,10}(?:сум|som|so‘m|som|uzs|сўм)?/u, multiplier: 1_000_000 },
    { re: /(\d[\d\s.,]*)\s*(?:тыс|ming|тысяч)\D{0,10}(?:сум|som|so‘m|uzs|сўм)?/u, multiplier: 1_000 },
    { re: /(\d[\d\s.,]{5,})\s*(?:сум|som|so‘m|uzs|сўм)/u, multiplier: 1 },
  ];

  for (const { re, multiplier } of patterns) {
    const match = normalized.match(re);
    if (!match?.[1]) continue;
    const digits = match[1].replace(/[\s.]/g, '').replace(',', '.');
    const value = Number.parseFloat(digits);
    if (!Number.isFinite(value) || value <= 0) continue;
    const major = Math.round(value * multiplier);
    // Guard against absurd parses ("до 2 вещей" is not a budget).
    if (major < 10_000 || major > 2_000_000_000) continue;
    return fromMajor(major, currency);
  }
  return null;
}

function isNegated(text: string, matchIndex: number): boolean {
  const window = text.slice(Math.max(0, matchIndex - 24), matchIndex);
  return NEGATION_MARKERS.some((marker) => window.includes(normalize(marker)));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ʻʼ‘’`']/g, '‘')
    .replace(/ /g, ' ')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

const CYRILLIC = /[Ѐ-ӿ]/;
const UZBEK_MARKERS = [
  'uchun',
  'kerak',
  'kiyim',
  'yoz',
  'qish',
  'ko‘ylak',
  'koylak',
  'shim',
  'ayollar',
  'erkaklar',
  'so‘m',
  'som',
  'menga',
  'bo‘lsin',
  'topib',
  'tanla',
];

function detectLanguage(raw: string, fallback: 'ru' | 'uz' | 'en' = 'ru'): 'ru' | 'uz' | 'en' {
  const text = normalize(raw);
  if (!text) return fallback;
  if (CYRILLIC.test(text)) return 'ru';
  if (UZBEK_MARKERS.some((marker) => text.includes(normalize(marker)))) return 'uz';
  if (/[a-z]/.test(text)) return 'en';
  return fallback;
}

const STOPWORDS = new Set([
  'собери',
  'подбери',
  'нужен',
  'нужна',
  'нужно',
  'хочу',
  'образ',
  'лук',
  'комплект',
  'одежда',
  'что-то',
  'пожалуйста',
  'можно',
  'найди',
  'покажи',
  'какой',
  'уchun',
  'uchun',
  'kerak',
  'menga',
  'tanla',
  'topib',
  'bering',
  'kiyim',
  'liboS',
  'libos',
  'uslub',
  'please',
  'need',
  'want',
  'something',
  'outfit',
  'look',
  'find',
  'show',
  'make',
  'build',
]);

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (out as Record<string, unknown>)[key] = entry;
  }
  return out;
}

/** Suggestion chips for an empty stylist screen, in the shopper's language. */
export const INTENT_EXAMPLES: Record<'ru' | 'uz' | 'en', string[]> = {
  ru: [
    'Собери old money образ для офиса до 4 000 000 сум',
    'Повседневный минимализм на каждый день, бежевая гамма',
    'Вечерний образ на свадьбу до 6 млн',
    'Тёплый зимний комплект, без красного',
    'Смарт-кэжуал для встречи с клиентом до 3 млн',
  ],
  uz: [
    'Ofis uchun old money uslubida kiyim, 4 mln so‘mgacha',
    'Kundalik minimalistik uslub, bej ranglar',
    'To‘y uchun kechki libos, 6 mln so‘mgacha',
    'Qish uchun issiq to‘plam, qizil rang bo‘lmasin',
    'Uchrashuv uchun smart casual, 3 mln so‘mgacha',
  ],
  en: [
    'Build an old money office look under 4,000,000 UZS',
    'Everyday minimal outfit in a beige palette',
    'Evening look for a wedding under 6M',
    'Warm winter set, no red',
    'Smart casual for a client meeting under 3M',
  ],
};
