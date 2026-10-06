/**
 * Transliteration and search normalisation — spec BUY-002.
 *
 * In Uzbekistan one shopper types "ko‘ylak", another "koylak", a third
 * "кўйлак" and a fourth "shirt". Search has to find the same product for all
 * four, so every indexed string is expanded into a set of normalised forms and
 * the query is expanded the same way.
 */

const RU_TO_LATIN: Array<readonly [string, string]> = [
  ['щ', 'sh'], ['ш', 'sh'], ['ч', 'ch'], ['ж', 'j'], ['ю', 'yu'], ['я', 'ya'],
  ['ё', 'yo'], ['э', 'e'], ['ы', 'i'], ['ъ', ''], ['ь', ''], ['ц', 'ts'],
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'],
  ['з', 'z'], ['и', 'i'], ['й', 'y'], ['к', 'k'], ['л', 'l'], ['м', 'm'],
  ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'], ['с', 's'], ['т', 't'],
  ['у', 'u'], ['ф', 'f'], ['х', 'h'], ['қ', 'q'], ['ғ', 'g'], ['ҳ', 'h'],
  ['ў', 'o'], ['ӯ', 'o'],
];

const LATIN_TO_RU: Array<readonly [string, string]> = [
  ['shch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['yu', 'ю'], ['ya', 'я'], ['yo', 'ё'],
  ['ts', 'ц'], ['kh', 'х'], ['zh', 'ж'], ['ph', 'ф'],
  ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'], ['f', 'ф'],
  ['g', 'г'], ['h', 'х'], ['i', 'и'], ['j', 'ж'], ['k', 'к'], ['l', 'л'],
  ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['q', 'к'], ['r', 'р'],
  ['s', 'с'], ['t', 'т'], ['u', 'у'], ['v', 'в'], ['w', 'в'], ['x', 'х'],
  ['y', 'й'], ['z', 'з'],
];

/** Uzbek Latin digraph and apostrophe variants collapse to one canonical form. */
const UZ_FOLD: Array<readonly [RegExp, string]> = [
  [/[ʻʼ‘’`'´]/g, ''],
  [/o‘/g, 'o'],
  [/g‘/g, 'g'],
  [/sh/g, 's'],
  [/ch/g, 'c'],
  [/ng/g, 'n'],
];

export function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Lower-cased, punctuation-free, apostrophe-folded base form. */
export function normalizeForSearch(value: string): string {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[ʻʼ‘’`'´]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cyrillicToLatin(value: string): string {
  let out = value.toLowerCase();
  for (const [from, to] of RU_TO_LATIN) out = out.split(from).join(to);
  return out;
}

export function latinToCyrillic(value: string): string {
  let out = normalizeForSearch(value);
  for (const [from, to] of LATIN_TO_RU) out = out.split(from).join(to);
  return out;
}

/** Aggressive fold used for fuzzy matching: "ko‘ylak" and "koylak" collapse. */
export function foldLatin(value: string): string {
  let out = normalizeForSearch(value);
  for (const [pattern, replacement] of UZ_FOLD) out = out.replace(pattern, replacement);
  return out.replace(/(.)\1+/g, '$1');
}

/**
 * Every form a string should be findable by. Indexed into the search document
 * and expanded for the query, so matching is symmetric.
 */
export function searchVariants(value: string): string[] {
  const base = normalizeForSearch(value);
  if (!base) return [];
  const variants = new Set<string>([base]);
  const hasCyrillic = /[Ѐ-ӿ]/.test(value);
  if (hasCyrillic) {
    const latin = normalizeForSearch(cyrillicToLatin(value));
    variants.add(latin);
    variants.add(foldLatin(latin));
  } else {
    variants.add(foldLatin(base));
    variants.add(normalizeForSearch(latinToCyrillic(base)));
  }
  return [...variants].filter((variant) => variant.length > 0);
}

/** The text blob stored for full-text search on a product. */
export function buildSearchDocument(parts: Array<string | null | undefined>): string {
  const tokens = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const variant of searchVariants(part)) {
      for (const token of variant.split(' ')) {
        if (token.length >= 2) tokens.add(token);
      }
      tokens.add(variant);
    }
  }
  return [...tokens].join(' ');
}

/** Query terms expanded the same way the document was. */
export function expandQuery(query: string): string[] {
  const variants = searchVariants(query);
  const tokens = new Set<string>();
  for (const variant of variants) {
    tokens.add(variant);
    for (const token of variant.split(' ')) {
      if (token.length >= 2) tokens.add(token);
    }
  }
  return [...tokens];
}

/** Levenshtein distance, capped for speed — used for "did you mean". */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

export function fuzzyMatches(query: string, candidate: string, maxDistance = 2): boolean {
  const a = foldLatin(query);
  const b = foldLatin(candidate);
  if (!a || !b) return false;
  if (b.includes(a)) return true;
  return editDistance(a, b, maxDistance) <= maxDistance;
}
