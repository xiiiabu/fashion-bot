/**
 * Controlled fashion taxonomy — spec §5.1 ("AI metadata"), AI-001, AI-003,
 * AI-004 and §6.3 ("Intent: LLM/intent parser + controlled taxonomy").
 *
 * The LLM is never allowed to invent values here. It may only map a shopper's
 * sentence onto these enums; everything downstream (retrieval, compatibility,
 * ranking) works on the enums, which is what keeps the stylist honest.
 */

export const OUTFIT_SLOTS = [
  'HEADWEAR',
  'OUTERWEAR',
  'TOP',
  'MID_LAYER',
  'BOTTOM',
  'FULL_BODY',
  'FOOTWEAR',
  'BAG',
  'ACCESSORY',
] as const;

export type OutfitSlot = (typeof OUTFIT_SLOTS)[number];

export const STYLE_TAGS = [
  'old_money',
  'quiet_luxury',
  'business_formal',
  'business_casual',
  'smart_casual',
  'minimal',
  'streetwear',
  'sporty',
  'athleisure',
  'bohemian',
  'romantic',
  'evening',
  'resort',
  'y2k',
  'preppy',
  'workwear',
  'national_modern',
  'avant_garde',
] as const;

export type StyleTag = (typeof STYLE_TAGS)[number];

export const OCCASIONS = [
  'office',
  'business_meeting',
  'everyday',
  'date',
  'wedding_guest',
  'celebration',
  'evening_out',
  'travel',
  'sport',
  'home',
  'university',
  'interview',
] as const;

export type Occasion = (typeof OCCASIONS)[number];

export const SEASONS = ['SS', 'FW', 'ALL_SEASON', 'SUMMER', 'WINTER', 'TRANSITIONAL'] as const;
export type Season = (typeof SEASONS)[number];

export const COLOR_FAMILIES = [
  'black',
  'white',
  'grey',
  'beige',
  'brown',
  'navy',
  'blue',
  'green',
  'olive',
  'red',
  'burgundy',
  'pink',
  'purple',
  'yellow',
  'orange',
  'cream',
  'camel',
  'silver',
  'gold',
  'multicolor',
  'print',
] as const;

export type ColorFamily = (typeof COLOR_FAMILIES)[number];

export const SILHOUETTES = [
  'fitted',
  'straight',
  'slim',
  'relaxed',
  'oversized',
  'a_line',
  'wide_leg',
  'tapered',
  'cropped',
  'longline',
  'flared',
] as const;

export type Silhouette = (typeof SILHOUETTES)[number];

export const FIT_PREFERENCES = ['slim', 'regular', 'relaxed', 'oversized'] as const;
export type FitPreference = (typeof FIT_PREFERENCES)[number];

/** 1 = beachwear, 5 = black tie. Used by the formality coherence rule (AI-004). */
export type FormalityLevel = 1 | 2 | 3 | 4 | 5;

/** 1 = hot weather, 5 = deep winter. Used by the season coherence rule. */
export type WarmthLevel = 1 | 2 | 3 | 4 | 5;

export const MATERIALS = [
  'cotton',
  'linen',
  'wool',
  'cashmere',
  'silk',
  'viscose',
  'polyester',
  'denim',
  'leather',
  'suede',
  'nylon',
  'blend',
  'knit',
  'tencel',
] as const;

export type Material = (typeof MATERIALS)[number];

export const CATEGORY_SLOT: Record<string, OutfitSlot> = {
  'coats-jackets': 'OUTERWEAR',
  coats: 'OUTERWEAR',
  jackets: 'OUTERWEAR',
  blazers: 'OUTERWEAR',
  trenchcoats: 'OUTERWEAR',
  shirts: 'TOP',
  blouses: 'TOP',
  't-shirts': 'TOP',
  tops: 'TOP',
  polos: 'TOP',
  knitwear: 'MID_LAYER',
  sweaters: 'MID_LAYER',
  cardigans: 'MID_LAYER',
  hoodies: 'MID_LAYER',
  vests: 'MID_LAYER',
  trousers: 'BOTTOM',
  jeans: 'BOTTOM',
  skirts: 'BOTTOM',
  shorts: 'BOTTOM',
  dresses: 'FULL_BODY',
  suits: 'FULL_BODY',
  jumpsuits: 'FULL_BODY',
  shoes: 'FOOTWEAR',
  sneakers: 'FOOTWEAR',
  boots: 'FOOTWEAR',
  loafers: 'FOOTWEAR',
  heels: 'FOOTWEAR',
  bags: 'BAG',
  belts: 'ACCESSORY',
  scarves: 'ACCESSORY',
  jewellery: 'ACCESSORY',
  hats: 'HEADWEAR',
  caps: 'HEADWEAR',
};

/**
 * AI-003: outfit templates are configurable data, so merchandising can change
 * them without a release. These ship as the defaults and are seeded into the DB.
 */
export interface OutfitTemplate {
  readonly key: string;
  readonly title: Record<'ru' | 'uz' | 'en', string>;
  readonly slots: Array<{
    readonly slot: OutfitSlot;
    readonly required: boolean;
    /** Budget weight: how much of the total budget this slot may consume. */
    readonly budgetWeight: number;
  }>;
  readonly styleAffinity: StyleTag[];
  readonly occasions: Occasion[];
}

export const DEFAULT_OUTFIT_TEMPLATES: OutfitTemplate[] = [
  {
    key: 'office-layered',
    title: {
      ru: 'Офисный образ со слоями',
      uz: 'Ofis uchun qatlamli uslub',
      en: 'Layered office look',
    },
    slots: [
      { slot: 'OUTERWEAR', required: false, budgetWeight: 0.32 },
      { slot: 'TOP', required: true, budgetWeight: 0.16 },
      { slot: 'BOTTOM', required: true, budgetWeight: 0.24 },
      { slot: 'FOOTWEAR', required: true, budgetWeight: 0.22 },
      { slot: 'ACCESSORY', required: false, budgetWeight: 0.06 },
    ],
    styleAffinity: ['old_money', 'quiet_luxury', 'business_casual', 'business_formal', 'minimal'],
    occasions: ['office', 'business_meeting', 'interview'],
  },
  {
    key: 'everyday-casual',
    title: { ru: 'Повседневный образ', uz: 'Kundalik uslub', en: 'Everyday casual' },
    slots: [
      { slot: 'TOP', required: true, budgetWeight: 0.24 },
      { slot: 'BOTTOM', required: true, budgetWeight: 0.3 },
      { slot: 'FOOTWEAR', required: true, budgetWeight: 0.32 },
      { slot: 'MID_LAYER', required: false, budgetWeight: 0.14 },
    ],
    styleAffinity: ['smart_casual', 'minimal', 'streetwear', 'athleisure', 'preppy'],
    occasions: ['everyday', 'university', 'travel', 'home'],
  },
  {
    key: 'evening',
    title: { ru: 'Вечерний образ', uz: 'Kechki uslub', en: 'Evening look' },
    slots: [
      { slot: 'FULL_BODY', required: false, budgetWeight: 0.45 },
      { slot: 'TOP', required: false, budgetWeight: 0.22 },
      { slot: 'BOTTOM', required: false, budgetWeight: 0.24 },
      { slot: 'FOOTWEAR', required: true, budgetWeight: 0.3 },
      { slot: 'BAG', required: false, budgetWeight: 0.14 },
      { slot: 'ACCESSORY', required: false, budgetWeight: 0.08 },
    ],
    styleAffinity: ['evening', 'romantic', 'quiet_luxury', 'avant_garde'],
    occasions: ['evening_out', 'date', 'celebration', 'wedding_guest'],
  },
  {
    key: 'winter-layered',
    title: { ru: 'Зимний образ', uz: 'Qishki uslub', en: 'Winter layers' },
    slots: [
      { slot: 'OUTERWEAR', required: true, budgetWeight: 0.4 },
      { slot: 'MID_LAYER', required: true, budgetWeight: 0.18 },
      { slot: 'TOP', required: false, budgetWeight: 0.1 },
      { slot: 'BOTTOM', required: true, budgetWeight: 0.16 },
      { slot: 'FOOTWEAR', required: true, budgetWeight: 0.2 },
      { slot: 'ACCESSORY', required: false, budgetWeight: 0.06 },
    ],
    styleAffinity: ['old_money', 'minimal', 'workwear', 'quiet_luxury'],
    occasions: ['everyday', 'office', 'travel'],
  },
  {
    key: 'sport-active',
    title: { ru: 'Спортивный образ', uz: 'Sport uslubi', en: 'Active look' },
    slots: [
      { slot: 'TOP', required: true, budgetWeight: 0.26 },
      { slot: 'BOTTOM', required: true, budgetWeight: 0.28 },
      { slot: 'FOOTWEAR', required: true, budgetWeight: 0.36 },
      { slot: 'MID_LAYER', required: false, budgetWeight: 0.1 },
    ],
    styleAffinity: ['sporty', 'athleisure', 'streetwear'],
    occasions: ['sport', 'everyday', 'travel'],
  },
];

/** Formality that a style tag implies, used to score coherence. */
export const STYLE_FORMALITY: Record<StyleTag, FormalityLevel> = {
  old_money: 4,
  quiet_luxury: 4,
  business_formal: 5,
  business_casual: 4,
  smart_casual: 3,
  minimal: 3,
  streetwear: 2,
  sporty: 1,
  athleisure: 2,
  bohemian: 2,
  romantic: 3,
  evening: 5,
  resort: 2,
  y2k: 2,
  preppy: 3,
  workwear: 2,
  national_modern: 3,
  avant_garde: 4,
};

/** Style tags that clash hard enough to be a blocking rule rather than a score. */
export const STYLE_CONFLICTS: ReadonlyArray<readonly [StyleTag, StyleTag]> = [
  ['business_formal', 'sporty'],
  ['business_formal', 'streetwear'],
  ['business_formal', 'athleisure'],
  ['evening', 'sporty'],
  ['evening', 'athleisure'],
  ['old_money', 'y2k'],
  ['quiet_luxury', 'y2k'],
];

/** Neutrals combine with anything; this drives the colour harmony score. */
export const NEUTRAL_COLORS: readonly ColorFamily[] = [
  'black',
  'white',
  'grey',
  'beige',
  'cream',
  'navy',
  'camel',
  'brown',
];

/** Pairs that read as a deliberate combination rather than an accident. */
export const COLOR_AFFINITY: ReadonlyArray<readonly [ColorFamily, ColorFamily]> = [
  ['navy', 'camel'],
  ['navy', 'white'],
  ['navy', 'grey'],
  ['black', 'grey'],
  ['black', 'white'],
  ['beige', 'brown'],
  ['beige', 'olive'],
  ['cream', 'camel'],
  ['burgundy', 'navy'],
  ['burgundy', 'cream'],
  ['olive', 'brown'],
  ['grey', 'burgundy'],
  ['white', 'blue'],
  ['brown', 'cream'],
];

/** Pairs to avoid putting in one look unless the shopper asked for it. */
export const COLOR_CLASHES: ReadonlyArray<readonly [ColorFamily, ColorFamily]> = [
  ['red', 'orange'],
  ['red', 'pink'],
  ['orange', 'pink'],
  ['purple', 'orange'],
  ['green', 'red'],
  ['yellow', 'pink'],
];

export const SEASON_WARMTH: Record<Season, { min: WarmthLevel; max: WarmthLevel }> = {
  SUMMER: { min: 1, max: 2 },
  SS: { min: 1, max: 3 },
  TRANSITIONAL: { min: 2, max: 4 },
  FW: { min: 3, max: 5 },
  WINTER: { min: 4, max: 5 },
  ALL_SEASON: { min: 1, max: 5 },
};

export function slotForCategory(categorySlug: string): OutfitSlot | null {
  return CATEGORY_SLOT[categorySlug] ?? null;
}

export function isNeutral(color: ColorFamily): boolean {
  return NEUTRAL_COLORS.includes(color);
}

export function colorsAffine(a: ColorFamily, b: ColorFamily): boolean {
  return COLOR_AFFINITY.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function colorsClash(a: ColorFamily, b: ColorFamily): boolean {
  return COLOR_CLASHES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function stylesConflict(a: StyleTag, b: StyleTag): boolean {
  return STYLE_CONFLICTS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function templateForIntent(
  styles: StyleTag[],
  occasions: Occasion[],
  season?: Season | null,
): OutfitTemplate {
  if (season === 'WINTER' || season === 'FW') {
    const winter = DEFAULT_OUTFIT_TEMPLATES.find((t) => t.key === 'winter-layered');
    if (winter && !occasions.includes('sport')) return winter;
  }
  let best = DEFAULT_OUTFIT_TEMPLATES[0]!;
  let bestScore = -1;
  for (const template of DEFAULT_OUTFIT_TEMPLATES) {
    const styleScore = styles.filter((s) => template.styleAffinity.includes(s)).length * 2;
    const occasionScore = occasions.filter((o) => template.occasions.includes(o)).length * 3;
    const score = styleScore + occasionScore;
    if (score > bestScore) {
      bestScore = score;
      best = template;
    }
  }
  return bestScore <= 0
    ? DEFAULT_OUTFIT_TEMPLATES.find((t) => t.key === 'everyday-casual')!
    : best;
}
