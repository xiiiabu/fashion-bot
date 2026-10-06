/**
 * Pilot seed — §17 "MVP / Pilot" and §17.1 Definition of Done.
 *
 * It builds a catalogue that actually satisfies the spec's own acceptance
 * criteria rather than a handful of lorem-ipsum rows:
 *  - six Tashkent sellers with contracts, payout accounts, delivery methods
 *    and return policies, so CAT-010 and FUL-001/005 resolve for every product
 *  - real size charts in millimetres, so the fit engine has something to read
 *    (FIT-001) instead of falling back to "chart only"
 *  - products across every outfit slot, priced so that the spec's own example
 *    brief ("old money office look under 4 000 000 UZS") is satisfiable
 *  - RU and UZ copy on everything, because UZ is a required locale (ADM-011)
 *  - admin users for each role, with MFA enrolment left to first login
 *  - the AI evaluation set from §18, so the stylist can be scored offline
 *
 * Run with `pnpm db:seed`. It is idempotent per entity (upsert by a natural
 * key), so re-running updates rather than duplicating — the same CAT-001
 * guarantee the CSV import has.
 */

import { loadEnvFile } from '../src/common/env';

loadEnvFile();

import { join } from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { fromMajor, sizeSortKey, buildSearchDocument } from '@fashion/core';
import {
  BANNER_SIZE,
  type GarmentShape,
  IMAGE_SIZE,
  LOGO_SIZE,
  placeholderColor,
  renderBannerSvg,
  renderBrandLogoSvg,
  renderProductSvg,
  writeSvg,
} from './media-generator';
import { hashPassword } from '../src/common/crypto';

const prisma = new PrismaClient();

const MEDIA_DIR = join(process.cwd(), 'storage', 'media');
const MEDIA_BASE = process.env.STORAGE_PUBLIC_BASE ?? 'http://localhost:4000/media';

/** Prices are written in soum and converted to the minor unit once, here. */
const uzs = (major: number): bigint => BigInt(fromMajor(major, 'UZS').amount);

async function main(): Promise<void> {
  console.log('→ seeding the pilot catalogue');

  const schemas = await seedAttributeSchemas();
  const categories = await seedCategories(schemas);
  const zones = await seedDeliveryZones();
  await seedCommissionRules(categories);
  const sellers = await seedSellers(zones);
  const charts = await seedSizeCharts(sellers, categories);
  const products = await seedProducts(sellers, categories, charts);
  await seedCollectionsAndLooks(products);
  await seedCms(products);
  await seedContentPages();
  await seedPromotions(products);
  await seedAdminUsers();
  await seedAiEvaluation();
  await seedPlatformConfig();

  const counts = await summary();
  console.log('✓ seed complete');
  console.table(counts);
  console.log(`\nAdmin panel sign-in (change these before any shared environment):`);
  console.log('  super admin    super@fashion.uz     / Platform!Admin2026');
  console.log('  catalog        catalog@fashion.uz   / Catalog!Admin2026');
  console.log('  orders         orders@fashion.uz    / Orders!Admin2026');
  console.log('  finance        finance@fashion.uz   / Finance!Admin2026');
  console.log('  finance #2     finance2@fashion.uz  / Finance!Admin2026   (second approver, ADM-005)');
  console.log('  content        content@fashion.uz   / Content!Admin2026');
  console.log('  ai merch       ai@fashion.uz        / AiMerch!Admin2026');
  console.log('  support        support@fashion.uz   / Support!Admin2026');
  console.log('\nSeller cabinet sign-in:');
  console.log('  owner@chorsu.uz / Seller!Owner2026  (Chorsu Atelier)');
  console.log('  owner@atlas.uz  / Seller!Owner2026  (Atlas & Adras)');
  console.log('\nMFA: roles that require it enrol on first login and show a TOTP secret (ADM-002).');
}

// ───────────────────────────────────────────────── attribute schemas (CAT-002)

async function seedAttributeSchemas() {
  const definitions = [
    {
      code: 'apparel-top',
      name: 'Верх (рубашки, футболки, блузы)',
      fields: [
        { key: 'sleeveLength', label: 'Длина рукава', type: 'enum', required: true, options: ['short', 'long', 'three_quarter', 'sleeveless'] },
        { key: 'neckline', label: 'Вырез', type: 'enum', required: false, options: ['crew', 'v', 'collar', 'boat', 'stand'] },
        { key: 'closure', label: 'Застёжка', type: 'enum', required: false, options: ['buttons', 'zip', 'none'] },
        { key: 'pattern', label: 'Рисунок', type: 'enum', required: true, options: ['plain', 'stripe', 'check', 'floral', 'print'] },
      ],
    },
    {
      code: 'apparel-bottom',
      name: 'Низ (брюки, джинсы, юбки)',
      fields: [
        { key: 'rise', label: 'Посадка', type: 'enum', required: true, options: ['low', 'mid', 'high'] },
        { key: 'legOpening', label: 'Низ брючины', type: 'enum', required: false, options: ['slim', 'straight', 'wide', 'flared'] },
        { key: 'pockets', label: 'Карманы', type: 'number', required: false, unit: 'шт' },
        { key: 'pattern', label: 'Рисунок', type: 'enum', required: true, options: ['plain', 'stripe', 'check', 'print'] },
      ],
    },
    {
      code: 'outerwear',
      name: 'Верхняя одежда',
      fields: [
        { key: 'lining', label: 'Подкладка', type: 'enum', required: true, options: ['full', 'half', 'unlined'] },
        { key: 'insulation', label: 'Утеплитель', type: 'enum', required: false, options: ['none', 'wool', 'down', 'synthetic'] },
        { key: 'closure', label: 'Застёжка', type: 'enum', required: true, options: ['buttons', 'zip', 'belt', 'double_breasted'] },
      ],
    },
    {
      code: 'footwear',
      name: 'Обувь',
      fields: [
        { key: 'upperMaterial', label: 'Материал верха', type: 'enum', required: true, options: ['leather', 'suede', 'textile', 'synthetic'] },
        { key: 'soleMaterial', label: 'Материал подошвы', type: 'enum', required: true, options: ['rubber', 'leather', 'eva', 'tpu'] },
        { key: 'heelHeightMm', label: 'Высота каблука', type: 'number', required: false, unit: 'мм' },
        { key: 'closure', label: 'Застёжка', type: 'enum', required: false, options: ['laces', 'slip_on', 'zip', 'buckle'] },
      ],
    },
    {
      code: 'accessory',
      name: 'Аксессуары',
      fields: [
        { key: 'material', label: 'Материал', type: 'enum', required: true, options: ['leather', 'silk', 'wool', 'canvas', 'metal'] },
        { key: 'dimensionsMm', label: 'Габариты', type: 'string', required: false },
      ],
    },
  ];

  const out = new Map<string, string>();
  for (const definition of definitions) {
    const schema = await prisma.attributeSchema.upsert({
      where: { code: definition.code },
      create: {
        code: definition.code,
        name: definition.name,
        fields: definition.fields as unknown as Prisma.InputJsonValue,
      },
      update: { name: definition.name, fields: definition.fields as unknown as Prisma.InputJsonValue },
    });
    out.set(definition.code, schema.id);
  }
  console.log(`  attribute schemas: ${out.size}`);
  return out;
}

// ────────────────────────────────────────────────────────────── categories

interface CategorySeed {
  slug: string;
  ru: string;
  uz: string;
  en: string;
  slot: string | null;
  schema?: string;
  gender?: 'WOMEN' | 'MEN' | 'UNISEX' | null;
  children?: CategorySeed[];
}

const CATEGORY_TREE: CategorySeed[] = [
  {
    slug: 'coats-jackets',
    ru: 'Верхняя одежда',
    uz: 'Ustki kiyim',
    en: 'Coats & jackets',
    slot: 'OUTERWEAR',
    schema: 'outerwear',
    children: [
      { slug: 'coats', ru: 'Пальто', uz: 'Palto', en: 'Coats', slot: 'OUTERWEAR', schema: 'outerwear' },
      { slug: 'blazers', ru: 'Пиджаки', uz: 'Kostyum-jaket', en: 'Blazers', slot: 'OUTERWEAR', schema: 'outerwear' },
      { slug: 'jackets', ru: 'Куртки', uz: 'Kurtkalar', en: 'Jackets', slot: 'OUTERWEAR', schema: 'outerwear' },
    ],
  },
  {
    slug: 'tops',
    ru: 'Верх',
    uz: 'Yuqori qism',
    en: 'Tops',
    slot: 'TOP',
    schema: 'apparel-top',
    children: [
      { slug: 'shirts', ru: 'Рубашки', uz: 'Ko‘ylaklar', en: 'Shirts', slot: 'TOP', schema: 'apparel-top' },
      { slug: 'blouses', ru: 'Блузы', uz: 'Bluzalar', en: 'Blouses', slot: 'TOP', schema: 'apparel-top', gender: 'WOMEN' },
      { slug: 't-shirts', ru: 'Футболки', uz: 'Futbolkalar', en: 'T-shirts', slot: 'TOP', schema: 'apparel-top' },
    ],
  },
  {
    slug: 'knitwear',
    ru: 'Трикотаж',
    uz: 'Trikotaj',
    en: 'Knitwear',
    slot: 'MID_LAYER',
    schema: 'apparel-top',
    children: [
      { slug: 'sweaters', ru: 'Свитеры', uz: 'Svitrlar', en: 'Sweaters', slot: 'MID_LAYER', schema: 'apparel-top' },
      { slug: 'cardigans', ru: 'Кардиганы', uz: 'Kardiganlar', en: 'Cardigans', slot: 'MID_LAYER', schema: 'apparel-top' },
      { slug: 'hoodies', ru: 'Худи и свитшоты', uz: 'Xudi va svitshotlar', en: 'Hoodies', slot: 'MID_LAYER', schema: 'apparel-top' },
    ],
  },
  {
    slug: 'bottoms',
    ru: 'Низ',
    uz: 'Pastki qism',
    en: 'Bottoms',
    slot: 'BOTTOM',
    schema: 'apparel-bottom',
    children: [
      { slug: 'trousers', ru: 'Брюки', uz: 'Shimlar', en: 'Trousers', slot: 'BOTTOM', schema: 'apparel-bottom' },
      { slug: 'jeans', ru: 'Джинсы', uz: 'Jinsi shimlar', en: 'Jeans', slot: 'BOTTOM', schema: 'apparel-bottom' },
      { slug: 'skirts', ru: 'Юбки', uz: 'Yubkalar', en: 'Skirts', slot: 'BOTTOM', schema: 'apparel-bottom', gender: 'WOMEN' },
    ],
  },
  {
    slug: 'dresses',
    ru: 'Платья',
    uz: 'Ko‘ylaklar',
    en: 'Dresses',
    slot: 'FULL_BODY',
    schema: 'apparel-top',
    gender: 'WOMEN',
  },
  {
    slug: 'shoes',
    ru: 'Обувь',
    uz: 'Oyoq kiyim',
    en: 'Shoes',
    slot: 'FOOTWEAR',
    schema: 'footwear',
    children: [
      { slug: 'loafers', ru: 'Лоферы', uz: 'Loferlar', en: 'Loafers', slot: 'FOOTWEAR', schema: 'footwear' },
      { slug: 'sneakers', ru: 'Кроссовки', uz: 'Krossovkalar', en: 'Sneakers', slot: 'FOOTWEAR', schema: 'footwear' },
      { slug: 'boots', ru: 'Ботинки', uz: 'Botinkalar', en: 'Boots', slot: 'FOOTWEAR', schema: 'footwear' },
      { slug: 'heels', ru: 'Туфли на каблуке', uz: 'Poshnali tuflilar', en: 'Heels', slot: 'FOOTWEAR', schema: 'footwear', gender: 'WOMEN' },
    ],
  },
  {
    slug: 'bags',
    ru: 'Сумки',
    uz: 'Sumkalar',
    en: 'Bags',
    slot: 'BAG',
    schema: 'accessory',
  },
  {
    slug: 'accessories',
    ru: 'Аксессуары',
    uz: 'Aksessuarlar',
    en: 'Accessories',
    slot: 'ACCESSORY',
    schema: 'accessory',
    children: [
      { slug: 'belts', ru: 'Ремни', uz: 'Kamarlar', en: 'Belts', slot: 'ACCESSORY', schema: 'accessory' },
      { slug: 'scarves', ru: 'Шарфы и платки', uz: 'Sharflar va ro‘mollar', en: 'Scarves', slot: 'ACCESSORY', schema: 'accessory' },
    ],
  },
];

async function seedCategories(schemas: Map<string, string>) {
  const out = new Map<string, { id: string; slug: string; slot: string | null }>();
  let order = 0;

  const upsert = async (seed: CategorySeed, parentId: string | null) => {
    const category = await prisma.category.upsert({
      where: { slug: seed.slug },
      create: {
        slug: seed.slug,
        nameRu: seed.ru,
        nameUz: seed.uz,
        nameEn: seed.en,
        parentId,
        slot: seed.slot as never,
        gender: (seed.gender ?? null) as never,
        sortOrder: order,
        attributeSchemaId: seed.schema ? (schemas.get(seed.schema) ?? null) : null,
      },
      update: {
        nameRu: seed.ru,
        nameUz: seed.uz,
        nameEn: seed.en,
        parentId,
        slot: seed.slot as never,
        sortOrder: order,
        attributeSchemaId: seed.schema ? (schemas.get(seed.schema) ?? null) : null,
      },
    });
    order += 1;
    out.set(seed.slug, { id: category.id, slug: category.slug, slot: category.slot });
    for (const child of seed.children ?? []) await upsert(child, category.id);
  };

  for (const seed of CATEGORY_TREE) await upsert(seed, null);
  console.log(`  categories: ${out.size}`);
  return out;
}

// ──────────────────────────────────────────────── delivery zones (FUL-001)

async function seedDeliveryZones() {
  const zones = [
    {
      code: 'tas-center',
      ru: 'Ташкент — центр',
      uz: 'Toshkent — markaz',
      en: 'Tashkent — centre',
      city: 'Tashkent',
      districts: ['Yunusabad', 'Mirzo Ulugbek', 'Shaykhantahur', 'Mirabad', 'Yakkasaray'],
    },
    {
      code: 'tas-outer',
      ru: 'Ташкент — окраины',
      uz: 'Toshkent — chekka tumanlar',
      en: 'Tashkent — outer districts',
      city: 'Tashkent',
      districts: ['Chilanzar', 'Sergeli', 'Bektemir', 'Uchtepa', 'Almazar', 'Yashnabad'],
    },
    {
      code: 'tas-region',
      ru: 'Ташкентская область',
      uz: 'Toshkent viloyati',
      en: 'Tashkent region',
      city: 'Tashkent Region',
      districts: [],
    },
  ];

  const out = new Map<string, string>();
  for (const [index, zone] of zones.entries()) {
    const row = await prisma.deliveryZone.upsert({
      where: { code: zone.code },
      create: {
        code: zone.code,
        nameRu: zone.ru,
        nameUz: zone.uz,
        nameEn: zone.en,
        city: zone.city,
        districts: zone.districts,
        sortOrder: index,
      },
      update: { districts: zone.districts, sortOrder: index },
    });
    out.set(zone.code, row.id);
  }
  console.log(`  delivery zones: ${out.size}`);
  return out;
}

// ────────────────────────────────────────── commission rules (PAY-006/007)

async function seedCommissionRules(categories: Map<string, { id: string }>) {
  // The contractual default: 10% of the paid goods value, delivery excluded,
  // seller-funded discounts reduce the base (§8.2).
  await prisma.commissionRule.upsert({
    where: { code_version: { code: 'default-10pct', version: 1 } },
    create: {
      code: 'default-10pct',
      version: 1,
      rateBps: 1000,
      includesDelivery: false,
      sellerDiscountReducesBase: true,
      platformDiscountReducesBase: false,
      rounding: 'HALF_UP',
      isDefault: true,
      note: 'Platform default: 10% of the paid value of each item, excluding delivery (§8.2).',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
    update: { isDefault: true, rateBps: 1000 },
  });

  // A category override, to prove PAY-007's specificity order is exercised.
  const accessories = categories.get('accessories');
  if (accessories) {
    await prisma.commissionRule.upsert({
      where: { code_version: { code: 'accessories-12pct', version: 1 } },
      create: {
        code: 'accessories-12pct',
        version: 1,
        categoryId: accessories.id,
        rateBps: 1200,
        isDefault: false,
        note: 'Negotiated category rate for accessories; overrides the platform default.',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
      update: { rateBps: 1200 },
    });
  }
  console.log('  commission rules: default 10% + one category override');
}

// ──────────────────────────────────────────────────── sellers and brands

interface SellerSeed {
  slug: string;
  legalName: string;
  displayName: string;
  taxId: string;
  signatory: string;
  email: string;
  phone: string;
  description: string;
  handlingDays: number;
  cutoff: string;
  returnReserveBps: number;
  settlementMode: 'NATIVE_SPLIT' | 'PLATFORM_SETTLEMENT';
  brand: { slug: string; name: string; country: string; description: string; colorFamily: string; featured: boolean };
  owner?: { email: string; name: string };
}

const SELLER_SEEDS: SellerSeed[] = [
  {
    slug: 'chorsu-atelier',
    legalName: 'OOO «Chorsu Atelier»',
    displayName: 'Chorsu Atelier',
    taxId: '301234567',
    signatory: 'Rustam Ibragimov',
    email: 'hello@chorsu.uz',
    phone: '+998712001101',
    description:
      'Ателье в Ташкенте: костюмная классика, пальто и рубашки из итальянских и турецких тканей. Собственный пошив, сдержанная палитра.',
    handlingDays: 2,
    cutoff: '15:00',
    returnReserveBps: 500,
    settlementMode: 'PLATFORM_SETTLEMENT',
    brand: {
      slug: 'chorsu-atelier',
      name: 'Chorsu Atelier',
      country: 'UZ',
      description: 'Тихая классика: костюмы, пальто, рубашки. Пошив в Ташкенте.',
      colorFamily: 'navy',
      featured: true,
    },
    owner: { email: 'owner@chorsu.uz', name: 'Rustam Ibragimov' },
  },
  {
    slug: 'atlas-adras',
    legalName: 'OOO «Atlas va Adras»',
    displayName: 'Atlas & Adras',
    taxId: '302345678',
    signatory: 'Dilnoza Karimova',
    email: 'hello@atlas.uz',
    phone: '+998712001102',
    description:
      'Современная интерпретация узбекского текстиля: адрас и атлас в сдержанных силуэтах, ручная работа в Маргилане.',
    handlingDays: 3,
    cutoff: '14:00',
    returnReserveBps: 700,
    settlementMode: 'PLATFORM_SETTLEMENT',
    brand: {
      slug: 'atlas-adras',
      name: 'Atlas & Adras',
      country: 'UZ',
      description: 'Адрас и атлас в современных силуэтах. Маргилан, ручное ткачество.',
      colorFamily: 'burgundy',
      featured: true,
    },
    owner: { email: 'owner@atlas.uz', name: 'Dilnoza Karimova' },
  },
  {
    slug: 'registan-knit',
    legalName: 'OOO «Registan Knitwear»',
    displayName: 'Registan Knitwear',
    taxId: '303456789',
    signatory: 'Aziza Yusupova',
    email: 'hello@registan.uz',
    phone: '+998712001103',
    description: 'Трикотаж из мериноса и кашемира. Минималистичные формы, плотная вязка, спокойные цвета.',
    handlingDays: 1,
    cutoff: '16:00',
    returnReserveBps: 300,
    settlementMode: 'PLATFORM_SETTLEMENT',
    brand: {
      slug: 'registan-knit',
      name: 'Registan Knitwear',
      country: 'UZ',
      description: 'Меринос и кашемир. Минимализм и плотная вязка.',
      colorFamily: 'camel',
      featured: true,
    },
  },
  {
    slug: 'mirzo-denim',
    legalName: 'OOO «Mirzo Denim»',
    displayName: 'Mirzo Denim',
    taxId: '304567890',
    signatory: 'Sardor Mirzaev',
    email: 'hello@mirzodenim.uz',
    phone: '+998712001104',
    description: 'Деним и повседневный гардероб: прямые джинсы, куртки, футболки из плотного хлопка.',
    handlingDays: 1,
    cutoff: '17:00',
    returnReserveBps: 400,
    settlementMode: 'PLATFORM_SETTLEMENT',
    brand: {
      slug: 'mirzo-denim',
      name: 'Mirzo Denim',
      country: 'UZ',
      description: 'Плотный деним и базовый хлопок. Ташкент.',
      colorFamily: 'blue',
      featured: false,
    },
  },
  {
    slug: 'nurafshon-shoes',
    legalName: 'OOO «Nurafshon Shoes»',
    displayName: 'Nurafshon Shoes',
    taxId: '305678901',
    signatory: 'Jahongir Tursunov',
    email: 'hello@nurafshon.uz',
    phone: '+998712001105',
    description: 'Кожаная обувь ручной сборки: лоферы, ботинки, туфли. Полнота и колодки под местную стопу.',
    handlingDays: 2,
    cutoff: '15:00',
    returnReserveBps: 600,
    settlementMode: 'PLATFORM_SETTLEMENT',
    brand: {
      slug: 'nurafshon',
      name: 'Nurafshon',
      country: 'UZ',
      description: 'Кожаная обувь ручной сборки. Лоферы, ботинки, туфли.',
      colorFamily: 'brown',
      featured: true,
    },
  },
  {
    slug: 'yoshlik-sport',
    legalName: 'OOO «Yoshlik Sport»',
    displayName: 'Yoshlik Sport',
    taxId: '306789012',
    signatory: 'Kamola Rasulova',
    email: 'hello@yoshlik.uz',
    phone: '+998712001106',
    description: 'Спорт и athleisure: кроссовки, худи, технические ткани для города и зала.',
    handlingDays: 1,
    cutoff: '18:00',
    returnReserveBps: 300,
    settlementMode: 'PLATFORM_SETTLEMENT',
    brand: {
      slug: 'yoshlik',
      name: 'Yoshlik',
      country: 'UZ',
      description: 'Спорт и athleisure для города и зала.',
      colorFamily: 'grey',
      featured: false,
    },
  },
];

async function seedSellers(zones: Map<string, string>) {
  const out = new Map<string, { sellerId: string; brandId: string; slug: string }>();
  const ownerPasswordHash = await hashPassword('Seller!Owner2026');

  for (const seed of SELLER_SEEDS) {
    const logo = await writeSvg(
      MEDIA_DIR,
      `brand-${seed.brand.slug}.svg`,
      renderBrandLogoSvg(seed.brand.name, seed.brand.colorFamily),
      MEDIA_BASE,
      LOGO_SIZE,
      seed.brand.colorFamily,
    );

    const seller = await prisma.seller.upsert({
      where: { slug: seed.slug },
      create: {
        slug: seed.slug,
        legalName: seed.legalName,
        displayName: seed.displayName,
        taxId: seed.taxId,
        registrationNumber: `UZ-${seed.taxId}`,
        legalAddress: 'Toshkent sh., Amir Temur shoh ko‘chasi',
        signatoryName: seed.signatory,
        contactEmail: seed.email,
        contactPhone: seed.phone,
        onboardingStatus: 'ACTIVE',
        verified: true,
        settlementMode: seed.settlementMode,
        handlingDays: seed.handlingDays,
        cutoffLocalTime: seed.cutoff,
        payoutScheduleDays: 7,
        returnReserveBps: seed.returnReserveBps,
        logoUrl: logo.url,
        description: seed.description,
      },
      update: {
        displayName: seed.displayName,
        onboardingStatus: 'ACTIVE',
        verified: true,
        handlingDays: seed.handlingDays,
        cutoffLocalTime: seed.cutoff,
        returnReserveBps: seed.returnReserveBps,
        logoUrl: logo.url,
        description: seed.description,
      },
    });

    const brand = await prisma.brand.upsert({
      where: { slug: seed.brand.slug },
      create: {
        slug: seed.brand.slug,
        name: seed.brand.name,
        sellerId: seller.id,
        logoUrl: logo.url,
        description: seed.brand.description,
        country: seed.brand.country,
        verified: true,
        featured: seed.brand.featured,
        // Appendix C step 3: rights to the logo and media are on record.
        contentRightsConfirmedAt: new Date('2026-08-01T00:00:00Z'),
      },
      update: {
        name: seed.brand.name,
        sellerId: seller.id,
        logoUrl: logo.url,
        verified: true,
        featured: seed.brand.featured,
        contentRightsConfirmedAt: new Date('2026-08-01T00:00:00Z'),
      },
    });

    // Appendix C step 2: a signed seller agreement with the commission base,
    // the PSP fee bearer and the payout schedule recorded as contract terms.
    await prisma.contract.upsert({
      where: { sellerId_number_version: { sellerId: seller.id, number: `AGR-${seed.taxId}`, version: 1 } },
      create: {
        sellerId: seller.id,
        number: `AGR-${seed.taxId}`,
        version: 1,
        signedAt: new Date('2026-08-15T00:00:00Z'),
        effectiveFrom: new Date('2026-09-01T00:00:00Z'),
        commissionBaseNote:
          'Комиссия 10% от фактически оплаченной стоимости товара после скидки продавца; доставка в базу не входит.',
        pspFeeBearer: 'PLATFORM',
        payoutScheduleNote: 'Выплата каждые 7 дней, резерв под возвраты удерживается до закрытия окна возврата.',
      },
      update: {},
    });

    // Appendix C step 8: finance contacts and a payout account.
    const existingAccount = await prisma.payoutAccount.findFirst({ where: { sellerId: seller.id } });
    if (!existingAccount) {
      await prisma.payoutAccount.create({
        data: {
          sellerId: seller.id,
          bankName: 'JSCB «Asaka Bank»',
          accountName: seed.legalName,
          accountNumberMasked: `•••• ${seed.taxId.slice(-4)}`,
          mfo: '00419',
          inn: seed.taxId,
          isDefault: true,
          verifiedAt: new Date('2026-08-20T00:00:00Z'),
        },
      });
    }

    // FUL-001: courier per zone plus a store pickup.
    const methods = [
      {
        code: 'courier-std',
        zone: 'tas-center',
        kind: 'COURIER' as const,
        ru: 'Курьер по Ташкенту',
        uz: 'Toshkent bo‘ylab kuryer',
        en: 'Tashkent courier',
        price: 25_000,
        freeOver: 1_500_000,
        min: 1,
        max: 2,
      },
      {
        code: 'courier-std',
        zone: 'tas-outer',
        kind: 'COURIER' as const,
        ru: 'Курьер по Ташкенту',
        uz: 'Toshkent bo‘ylab kuryer',
        en: 'Tashkent courier',
        price: 35_000,
        freeOver: 2_000_000,
        min: 1,
        max: 3,
      },
      {
        code: 'courier-region',
        zone: 'tas-region',
        kind: 'COURIER' as const,
        ru: 'Доставка по области',
        uz: 'Viloyat bo‘ylab yetkazish',
        en: 'Regional delivery',
        price: 55_000,
        freeOver: null,
        min: 2,
        max: 5,
      },
      {
        code: 'pickup-store',
        zone: null,
        kind: 'STORE_PICKUP' as const,
        ru: 'Самовывоз из шоурума',
        uz: 'Shoudan olib ketish',
        en: 'Showroom pickup',
        price: 0,
        freeOver: null,
        min: 0,
        max: 1,
      },
    ];

    for (const method of methods) {
      const zoneId = method.zone ? (zones.get(method.zone) ?? null) : null;
      const existing = await prisma.sellerDeliveryMethod.findFirst({
        where: { sellerId: seller.id, code: method.code, zoneId },
      });
      const data = {
        kind: method.kind,
        nameRu: method.ru,
        nameUz: method.uz,
        nameEn: method.en,
        priceMinor: uzs(method.price),
        freeOverMinor: method.freeOver ? uzs(method.freeOver) : null,
        minDays: method.min,
        maxDays: method.max,
        isActive: true,
        pickupAddress: method.kind === 'STORE_PICKUP' ? 'Toshkent, Amir Temur 108, showroom' : null,
      };
      if (existing) {
        await prisma.sellerDeliveryMethod.update({ where: { id: existing.id }, data });
      } else {
        await prisma.sellerDeliveryMethod.create({
          data: { sellerId: seller.id, code: method.code, zoneId, ...data },
        });
      }
    }

    // FUL-005: the policy shown before payment and snapshotted on the order.
    await prisma.returnPolicy.upsert({
      where: { code: `${seed.slug}-standard` },
      create: {
        code: `${seed.slug}-standard`,
        sellerId: seller.id,
        windowDays: 14,
        conditionsRu:
          'Возврат в течение 14 дней с момента доставки. Товар — без следов носки, с бирками и в оригинальной упаковке. Обратную доставку оплачивает покупатель, кроме брака и ошибки продавца.',
        conditionsUz:
          'Yetkazilgandan keyin 14 kun ichida qaytarish mumkin. Mahsulot kiyilmagan, yorliqlari va asl qadog‘i bilan bo‘lishi kerak. Qaytarish yetkazishini xaridor to‘laydi, nuqson yoki sotuvchi xatosi bundan mustasno.',
        conditionsEn:
          'Returns within 14 days of delivery. Unworn, with tags and original packaging. Return shipping is paid by the buyer except for defects or a seller error.',
        whoPaysReturn: 'BUYER',
        nonReturnableReasons: ['hygiene_seal_broken', 'custom_made'],
        isDefault: seed.slug === 'chorsu-atelier',
      },
      update: { windowDays: 14 },
    });

    if (seed.owner) {
      await prisma.sellerUser.upsert({
        where: { email: seed.owner.email },
        create: {
          sellerId: seller.id,
          email: seed.owner.email,
          name: seed.owner.name,
          passwordHash: ownerPasswordHash,
          role: 'SELLER_OWNER',
        },
        update: { sellerId: seller.id, role: 'SELLER_OWNER' },
      });
    }

    out.set(seed.slug, { sellerId: seller.id, brandId: brand.id, slug: seed.slug });
  }

  console.log(`  sellers: ${out.size} (active, with contracts, delivery and return policies)`);
  return out;
}

// ─────────────────────────────────────────────────── size charts (CAT-003)

interface ChartRow {
  sizeLabel: string;
  order: number;
  body: Record<string, number>;
  garment?: Record<string, number>;
}

async function seedSizeCharts(
  sellers: Map<string, { sellerId: string; brandId: string }>,
  categories: Map<string, { id: string }>,
) {
  const out = new Map<string, string>();

  /** Men's tops: letter sizing with chest/shoulder/sleeve, body + garment. */
  const menTops: ChartRow[] = [
    { sizeLabel: 'XS', order: 0, body: { chest: 860, waist: 740, shoulder: 420, sleeve: 600 }, garment: { chest: 980, shoulder: 430, sleeve: 610, length: 680 } },
    { sizeLabel: 'S', order: 1, body: { chest: 900, waist: 780, shoulder: 435, sleeve: 615 }, garment: { chest: 1020, shoulder: 445, sleeve: 625, length: 695 } },
    { sizeLabel: 'M', order: 2, body: { chest: 960, waist: 830, shoulder: 450, sleeve: 630 }, garment: { chest: 1080, shoulder: 460, sleeve: 640, length: 710 } },
    { sizeLabel: 'L', order: 3, body: { chest: 1020, waist: 890, shoulder: 465, sleeve: 645 }, garment: { chest: 1140, shoulder: 475, sleeve: 655, length: 725 } },
    { sizeLabel: 'XL', order: 4, body: { chest: 1080, waist: 950, shoulder: 480, sleeve: 660 }, garment: { chest: 1200, shoulder: 490, sleeve: 670, length: 740 } },
    { sizeLabel: 'XXL', order: 5, body: { chest: 1140, waist: 1010, shoulder: 495, sleeve: 675 }, garment: { chest: 1260, shoulder: 505, sleeve: 685, length: 755 } },
  ];

  const womenTops: ChartRow[] = [
    { sizeLabel: 'XS', order: 0, body: { chest: 800, waist: 630, hips: 870, shoulder: 370, sleeve: 575 }, garment: { chest: 880, shoulder: 378, sleeve: 582, length: 610 } },
    { sizeLabel: 'S', order: 1, body: { chest: 840, waist: 670, hips: 910, shoulder: 380, sleeve: 585 }, garment: { chest: 920, shoulder: 388, sleeve: 592, length: 620 } },
    { sizeLabel: 'M', order: 2, body: { chest: 880, waist: 710, hips: 950, shoulder: 390, sleeve: 595 }, garment: { chest: 965, shoulder: 398, sleeve: 602, length: 632 } },
    { sizeLabel: 'L', order: 3, body: { chest: 930, waist: 760, hips: 1000, shoulder: 402, sleeve: 605 }, garment: { chest: 1020, shoulder: 410, sleeve: 612, length: 645 } },
    { sizeLabel: 'XL', order: 4, body: { chest: 990, waist: 820, hips: 1060, shoulder: 415, sleeve: 615 }, garment: { chest: 1085, shoulder: 423, sleeve: 622, length: 658 } },
  ];

  const menTrousers: ChartRow[] = [
    { sizeLabel: '46', order: 0, body: { waist: 760, hips: 900, inseam: 820, thigh: 540 }, garment: { waist: 790, hips: 950, inseam: 820 } },
    { sizeLabel: '48', order: 1, body: { waist: 800, hips: 940, inseam: 820, thigh: 560 }, garment: { waist: 830, hips: 990, inseam: 820 } },
    { sizeLabel: '50', order: 2, body: { waist: 840, hips: 980, inseam: 825, thigh: 580 }, garment: { waist: 870, hips: 1030, inseam: 825 } },
    { sizeLabel: '52', order: 3, body: { waist: 880, hips: 1020, inseam: 830, thigh: 600 }, garment: { waist: 910, hips: 1070, inseam: 830 } },
    { sizeLabel: '54', order: 4, body: { waist: 920, hips: 1060, inseam: 835, thigh: 620 }, garment: { waist: 950, hips: 1110, inseam: 835 } },
    { sizeLabel: '56', order: 5, body: { waist: 960, hips: 1100, inseam: 840, thigh: 640 }, garment: { waist: 990, hips: 1150, inseam: 840 } },
  ];

  const womenBottoms: ChartRow[] = [
    { sizeLabel: 'XS', order: 0, body: { waist: 640, hips: 880, inseam: 770, thigh: 520 }, garment: { waist: 660, hips: 920, inseam: 770 } },
    { sizeLabel: 'S', order: 1, body: { waist: 670, hips: 910, inseam: 775, thigh: 535 }, garment: { waist: 690, hips: 950, inseam: 775 } },
    { sizeLabel: 'M', order: 2, body: { waist: 700, hips: 950, inseam: 780, thigh: 550 }, garment: { waist: 725, hips: 990, inseam: 780 } },
    { sizeLabel: 'L', order: 3, body: { waist: 740, hips: 990, inseam: 785, thigh: 570 }, garment: { waist: 768, hips: 1035, inseam: 785 } },
    { sizeLabel: 'XL', order: 4, body: { waist: 790, hips: 1040, inseam: 790, thigh: 595 }, garment: { waist: 820, hips: 1085, inseam: 790 } },
  ];

  const shoes: ChartRow[] = [
    { sizeLabel: '38', order: 0, body: { footLength: 240 } },
    { sizeLabel: '39', order: 1, body: { footLength: 247 } },
    { sizeLabel: '40', order: 2, body: { footLength: 253 } },
    { sizeLabel: '41', order: 3, body: { footLength: 260 } },
    { sizeLabel: '42', order: 4, body: { footLength: 267 } },
    { sizeLabel: '43', order: 5, body: { footLength: 273 } },
    { sizeLabel: '44', order: 6, body: { footLength: 280 } },
    { sizeLabel: '45', order: 7, body: { footLength: 287 } },
  ];

  const definitions: Array<{
    code: string;
    brandSlug?: string;
    categorySlug?: string;
    system: string;
    gender?: 'WOMEN' | 'MEN' | 'UNISEX';
    rows: ChartRow[];
    noteRu: string;
    noteUz: string;
    noteEn: string;
  }> = [
    {
      code: 'tops-men-letter',
      categorySlug: 'tops',
      system: 'letter',
      gender: 'MEN',
      rows: menTops,
      noteRu: 'Мерки указаны по телу в миллиметрах. Обхват груди измеряется по самой широкой точке.',
      noteUz: 'O‘lchamlar tana bo‘yicha millimetrda. Ko‘krak aylanasi eng keng joydan o‘lchanadi.',
      noteEn: 'Body measurements in millimetres. Chest is measured at its widest point.',
    },
    {
      code: 'tops-women-letter',
      categorySlug: 'blouses',
      system: 'letter',
      gender: 'WOMEN',
      rows: womenTops,
      noteRu: 'Мерки по телу в миллиметрах. Для свободного кроя берите свой размер.',
      noteUz: 'Tana o‘lchamlari millimetrda. Erkin biqim uchun o‘z o‘lchamingizni oling.',
      noteEn: 'Body measurements in millimetres. For a relaxed cut, take your usual size.',
    },
    {
      code: 'knitwear-letter',
      categorySlug: 'knitwear',
      system: 'letter',
      rows: menTops,
      noteRu: 'Трикотаж тянется: при промежуточных мерках берите меньший размер.',
      noteUz: 'Trikotaj cho‘ziladi: o‘rtadagi o‘lchamlarda kichikrog‘ini oling.',
      noteEn: 'Knitwear stretches: between sizes, take the smaller one.',
    },
    {
      code: 'outerwear-letter',
      categorySlug: 'coats-jackets',
      system: 'letter',
      rows: menTops.map((row) => ({
        ...row,
        garment: {
          ...(row.garment ?? {}),
          // Outerwear is cut over a layer, so the garment chest is wider.
          chest: (row.garment?.chest ?? row.body.chest) + 80,
          length: (row.garment?.length ?? 700) + 180,
        },
      })),
      noteRu: 'Пальто и пиджаки рассчитаны на слой под низом: мерки даны по телу.',
      noteUz: 'Palto va jaketlar ostiga qatlam kiyish uchun mo‘ljallangan: o‘lchamlar tana bo‘yicha.',
      noteEn: 'Coats and blazers are cut over a layer; the figures are body measurements.',
    },
    {
      code: 'trousers-men-numeric',
      categorySlug: 'trousers',
      system: 'numeric',
      gender: 'MEN',
      rows: menTrousers,
      noteRu: 'Размер по обхвату пояса. Длина по внутреннему шву указана для роста 176–182 см.',
      noteUz: 'O‘lcham kamar aylanasi bo‘yicha. Ichki tikuv uzunligi 176–182 sm bo‘y uchun.',
      noteEn: 'Sized by waist. The inseam is given for a height of 176–182 cm.',
    },
    {
      code: 'bottoms-women-letter',
      categorySlug: 'skirts',
      system: 'letter',
      gender: 'WOMEN',
      rows: womenBottoms,
      noteRu: 'Мерки по телу. Для юбок ориентируйтесь на обхват бёдер.',
      noteUz: 'Tana o‘lchamlari. Yubkalar uchun son aylanasiga qarang.',
      noteEn: 'Body measurements. For skirts, go by the hip measurement.',
    },
    {
      code: 'dresses-women-letter',
      categorySlug: 'dresses',
      system: 'letter',
      gender: 'WOMEN',
      rows: womenTops,
      noteRu: 'Для платьев учитывайте обхват груди и бёдер; длина указана в описании модели.',
      noteUz: 'Ko‘ylaklar uchun ko‘krak va son aylanasiga qarang; uzunlik model tavsifida.',
      noteEn: 'For dresses, use the chest and hip figures; the length is in the product description.',
    },
    {
      code: 'shoes-eu',
      categorySlug: 'shoes',
      system: 'eu-shoe',
      rows: shoes,
      noteRu: 'Измерьте длину стопы в миллиметрах и выберите ближайшее значение. Колодка — средняя полнота.',
      noteUz: 'Oyoq uzunligini millimetrda o‘lchab, eng yaqin qiymatni tanlang. Qolip — o‘rta to‘liqlik.',
      noteEn: 'Measure your foot length in millimetres and pick the nearest value. Standard width last.',
    },
    {
      // A brand-specific override: Mirzo Denim runs small, so the chart differs
      // from the category default. This is exactly what CAT-003 asks for.
      code: 'mirzo-denim-jeans',
      brandSlug: 'mirzo-denim',
      categorySlug: 'jeans',
      system: 'numeric',
      rows: menTrousers.map((row) => ({
        ...row,
        garment: {
          ...(row.garment ?? {}),
          waist: (row.garment?.waist ?? row.body.waist) - 20,
        },
      })),
      noteRu: 'Деним Mirzo садится плотнее: при промежуточных мерках берите размер больше.',
      noteUz: 'Mirzo denimi zichroq o‘tiradi: o‘rtadagi o‘lchamlarda kattaroq o‘lchamni oling.',
      noteEn: 'Mirzo denim runs snug: between sizes, take the larger one.',
    },
  ];

  for (const definition of definitions) {
    const brandId = definition.brandSlug ? (sellers.get(definition.brandSlug)?.brandId ?? null) : null;
    const categoryId = definition.categorySlug
      ? (categories.get(definition.categorySlug)?.id ?? null)
      : null;

    const chart = await prisma.sizeChart.upsert({
      where: { code: definition.code },
      create: {
        code: definition.code,
        brandId,
        categoryId,
        system: definition.system,
        gender: (definition.gender ?? null) as never,
        rows: definition.rows as unknown as Prisma.InputJsonValue,
        noteRu: definition.noteRu,
        noteUz: definition.noteUz,
        noteEn: definition.noteEn,
      },
      update: {
        brandId,
        categoryId,
        rows: definition.rows as unknown as Prisma.InputJsonValue,
        noteRu: definition.noteRu,
        noteUz: definition.noteUz,
        noteEn: definition.noteEn,
      },
    });
    out.set(definition.code, chart.id);
  }

  console.log(`  size charts: ${out.size} (letter, numeric, EU shoe, one brand override)`);
  return out;
}

// ────────────────────────────────────────────────────────────── products

interface ProductSeed {
  externalId: string;
  seller: string;
  category: string;
  shape: GarmentShape;
  titleRu: string;
  titleUz: string;
  titleEn: string;
  descRu: string;
  descUz: string;
  colorName: string;
  colorFamily: string;
  gender: 'WOMEN' | 'MEN' | 'UNISEX';
  compositionRu: string;
  compositionUz: string;
  careRu: string;
  careUz: string;
  materials: string[];
  styleTags: string[];
  occasions: string[];
  season: string;
  silhouette: string;
  formality: number;
  warmth: number;
  fitNotes?: string;
  chart: string;
  sizes: string[];
  priceMajor: number;
  compareAtMajor?: number;
  stock: number[];
  attributes: Record<string, unknown>;
  authenticity?: string;
  incompatibleStyles?: string[];
}

const SIZES_LETTER = ['XS', 'S', 'M', 'L', 'XL'];
const SIZES_LETTER_FULL = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SIZES_TROUSERS = ['46', '48', '50', '52', '54'];
const SIZES_SHOES = ['39', '40', '41', '42', '43', '44'];
const SIZES_SHOES_W = ['36', '37', '38', '39', '40'];
const ONE_SIZE = ['ONE'];

const PRODUCTS: ProductSeed[] = [
  // ───────────────────────────── Chorsu Atelier — tailoring (old money)
  {
    externalId: 'CH-BLZ-001',
    seller: 'chorsu-atelier',
    category: 'blazers',
    shape: 'blazer',
    titleRu: 'Однобортный пиджак из шерсти, тёмно-синий',
    titleUz: 'Jundan bir qatorli jaket, to‘q ko‘k',
    titleEn: 'Single-breasted wool blazer, navy',
    descRu:
      'Полуприлегающий пиджак из итальянской шерсти Super 110s. Неподкладной рукав, мягкий плечевой пояс, два боковых кармана с клапанами. Держит форму и не выглядит формально до неприличия.',
    descUz:
      'Italiya juni Super 110s dan yarim bichilgan jaket. Yumshoq yelka, qopqoqli ikki yon kissa. Shaklini saqlaydi va ortiqcha rasmiy ko‘rinmaydi.',
    colorName: 'Тёмно-синий',
    colorFamily: 'navy',
    gender: 'MEN',
    compositionRu: '100% шерсть (Super 110s), подкладка 100% вискоза',
    compositionUz: '100% jun (Super 110s), astar 100% viskoza',
    careRu: 'Только сухая чистка. Хранить на плечиках.',
    careUz: 'Faqat quruq tozalash. Yelkachada saqlang.',
    materials: ['wool', 'viscose'],
    styleTags: ['old_money', 'business_casual', 'quiet_luxury', 'minimal'],
    occasions: ['office', 'business_meeting', 'interview'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 4,
    warmth: 3,
    fitNotes: 'Полуприлегающий крой. Если между размерами — берите меньший, пиджак сидит мягко.',
    chart: 'outerwear-letter',
    sizes: SIZES_LETTER,
    priceMajor: 1_650_000,
    stock: [2, 4, 6, 5, 2],
    attributes: { lining: 'half', insulation: 'none', closure: 'buttons' },
    authenticity: 'Пошив в собственном ателье в Ташкенте. Гарантия на пошив 12 месяцев.',
  },
  {
    externalId: 'CH-BLZ-002',
    seller: 'chorsu-atelier',
    category: 'blazers',
    shape: 'blazer',
    titleRu: 'Пиджак из шерсти и льна, бежевый',
    titleUz: 'Jun va zig‘irdan jaket, bej',
    titleEn: 'Wool-linen blazer, beige',
    descRu:
      'Лёгкий пиджак для тёплого сезона: смесь шерсти и льна, неподкладной корпус, естественная сминаемость. Подходит для офиса в +28 и для вечера на террасе.',
    descUz:
      'Issiq mavsum uchun yengil jaket: jun va zig‘ir aralashmasi, astarsiz korpus. +28 da ofis uchun ham, terrasadagi kech uchun ham mos.',
    colorName: 'Бежевый',
    colorFamily: 'beige',
    gender: 'MEN',
    compositionRu: '55% шерсть, 45% лён',
    compositionUz: '55% jun, 45% zig‘ir',
    careRu: 'Сухая чистка. Лёгкая сминаемость — характеристика льна.',
    careUz: 'Quruq tozalash. Yengil g‘ijimlanish — zig‘irning xususiyati.',
    materials: ['wool', 'linen'],
    styleTags: ['old_money', 'quiet_luxury', 'smart_casual', 'resort'],
    occasions: ['office', 'business_meeting', 'date', 'travel'],
    season: 'SS',
    silhouette: 'straight',
    formality: 4,
    warmth: 2,
    chart: 'outerwear-letter',
    sizes: SIZES_LETTER,
    priceMajor: 1_280_000,
    compareAtMajor: 1_590_000,
    stock: [3, 5, 4, 3, 1],
    attributes: { lining: 'unlined', insulation: 'none', closure: 'buttons' },
  },
  {
    externalId: 'CH-COAT-001',
    seller: 'chorsu-atelier',
    category: 'coats',
    shape: 'coat',
    titleRu: 'Пальто-халат из шерсти и кашемира, кэмел',
    titleUz: 'Jun va kashmirdan xalat-palto, tuyarang',
    titleEn: 'Wool-cashmere wrap coat, camel',
    descRu:
      'Пальто прямого силуэта с поясом, без застёжки. Шерсть с кашемиром держит тепло при −5 и не выглядит громоздко. Длина до середины голени.',
    descUz:
      'Kamarli, tugmasiz to‘g‘ri siluetli palto. Kashmirli jun −5 da issiq saqlaydi va bejirim ko‘rinadi. Uzunligi boldirning o‘rtasiga qadar.',
    colorName: 'Кэмел',
    colorFamily: 'camel',
    gender: 'UNISEX',
    compositionRu: '80% шерсть, 20% кашемир, подкладка 100% вискоза',
    compositionUz: '80% jun, 20% kashmir, astar 100% viskoza',
    careRu: 'Сухая чистка. Не отжимать, не сушить на радиаторе.',
    careUz: 'Quruq tozalash. Siqmang, radiatorda quritmang.',
    materials: ['wool', 'cashmere', 'viscose'],
    styleTags: ['old_money', 'quiet_luxury', 'minimal'],
    occasions: ['office', 'everyday', 'evening_out', 'business_meeting'],
    season: 'FW',
    silhouette: 'straight',
    formality: 4,
    warmth: 5,
    fitNotes: 'Оверсайз-посадка за счёт прямого кроя. Берите свой обычный размер.',
    chart: 'outerwear-letter',
    sizes: SIZES_LETTER,
    priceMajor: 3_450_000,
    stock: [1, 3, 4, 3, 1],
    attributes: { lining: 'full', insulation: 'wool', closure: 'belt' },
    authenticity: 'Ткань — итальянская мельница, сертификат происхождения по запросу.',
  },
  {
    externalId: 'CH-SHRT-001',
    seller: 'chorsu-atelier',
    category: 'shirts',
    shape: 'shirt',
    titleRu: 'Рубашка из египетского хлопка, белая',
    titleUz: 'Misr paxtasidan ko‘ylak, oq',
    titleEn: 'Egyptian cotton shirt, white',
    descRu:
      'Классическая рубашка из хлопка попл��н 120s. Воротник средней высоты на съёмных косточках, одна строчка по кокетке. Белый, который не просвечивает.',
    descUz:
      'Poplin 120s paxtadan klassik ko‘ylak. O‘rta balandlikdagi yoqa, yechiladigan suyakchalar bilan. Shaffof bo‘lmaydigan oq.',
    colorName: 'Белый',
    colorFamily: 'white',
    gender: 'MEN',
    compositionRu: '100% египетский хлопок (поплин 120s)',
    compositionUz: '100% Misr paxtasi (poplin 120s)',
    careRu: 'Машинная стирка 40°. Глажка при 150°.',
    careUz: '40° da mashinada yuvish. 150° da dazmollash.',
    materials: ['cotton'],
    styleTags: ['old_money', 'business_formal', 'business_casual', 'minimal'],
    occasions: ['office', 'business_meeting', 'interview', 'celebration'],
    season: 'ALL_SEASON',
    silhouette: 'slim',
    formality: 4,
    warmth: 2,
    chart: 'tops-men-letter',
    sizes: SIZES_LETTER_FULL,
    priceMajor: 520_000,
    stock: [4, 8, 12, 9, 5, 2],
    attributes: { sleeveLength: 'long', neckline: 'collar', closure: 'buttons', pattern: 'plain' },
  },
  {
    externalId: 'CH-SHRT-002',
    seller: 'chorsu-atelier',
    category: 'shirts',
    shape: 'shirt',
    titleRu: 'Рубашка из хлопка оксфорд, голубая',
    titleUz: 'Oksford paxtadan ko‘ylak, moviy',
    titleEn: 'Oxford cotton shirt, light blue',
    descRu:
      'Оксфорд средней плотности, воротник button-down. Рубашка, которая одинаково работает под пиджак и с джинсами.',
    descUz:
      'O‘rta zichlikdagi oksford, button-down yoqa. Jaket ostiga ham, jinsi bilan ham mos keladigan ko‘ylak.',
    colorName: 'Голубой',
    colorFamily: 'blue',
    gender: 'MEN',
    compositionRu: '100% хлопок (оксфорд)',
    compositionUz: '100% paxta (oksford)',
    careRu: 'Машинная стирка 40°.',
    careUz: '40° da mashinada yuvish.',
    materials: ['cotton'],
    styleTags: ['preppy', 'business_casual', 'smart_casual', 'old_money'],
    occasions: ['office', 'everyday', 'university', 'date'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 3,
    warmth: 2,
    chart: 'tops-men-letter',
    sizes: SIZES_LETTER_FULL,
    priceMajor: 460_000,
    stock: [3, 7, 10, 8, 4, 2],
    attributes: { sleeveLength: 'long', neckline: 'collar', closure: 'buttons', pattern: 'plain' },
  },
  {
    externalId: 'CH-TRS-001',
    seller: 'chorsu-atelier',
    category: 'trousers',
    shape: 'trousers',
    titleRu: 'Брюки из шерсти со складкой, серые',
    titleUz: 'Jundan burmali shim, kulrang',
    titleEn: 'Pleated wool trousers, grey',
    descRu:
      'Брюки с одной складкой и высокой посадкой. Прямая штанина с небольшим сужением к низу, без манжета. Шерсть средней плотности — носятся круглый год.',
    descUz:
      'Bitta burma va baland posadkali shim. To‘g‘ri, pastga qarab ozgina toraygan. O‘rta zichlikdagi jun — yil bo‘yi kiyiladi.',
    colorName: 'Серый',
    colorFamily: 'grey',
    gender: 'MEN',
    compositionRu: '96% шерсть, 4% эластан',
    compositionUz: '96% jun, 4% elastan',
    careRu: 'Сухая чистка. Глажка через проутюжильник.',
    careUz: 'Quruq tozalash. Mato orqali dazmollash.',
    materials: ['wool'],
    styleTags: ['old_money', 'business_casual', 'business_formal', 'minimal'],
    occasions: ['office', 'business_meeting', 'interview'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 4,
    warmth: 3,
    fitNotes: 'Высокая посадка. Длина рассчитана на рост 176–182 см.',
    chart: 'trousers-men-numeric',
    sizes: SIZES_TROUSERS,
    priceMajor: 890_000,
    stock: [3, 6, 8, 5, 2],
    attributes: { rise: 'high', legOpening: 'straight', pockets: 4, pattern: 'plain' },
  },
  {
    externalId: 'CH-TRS-002',
    seller: 'chorsu-atelier',
    category: 'trousers',
    shape: 'trousers',
    titleRu: 'Брюки чинос из хлопка, тёмно-синие',
    titleUz: 'Paxtadan chinos shim, to‘q ko‘k',
    titleEn: 'Cotton chinos, navy',
    descRu: 'Чинос из плотного хлопка с небольшим содержанием эластана. Прямой крой, пять карманов, без складок.',
    descUz: 'Zich paxtadan, ozgina elastanli chinos. To‘g‘ri bichim, besh kissa, burmasiz.',
    colorName: 'Тёмно-синий',
    colorFamily: 'navy',
    gender: 'MEN',
    compositionRu: '97% хлопок, 3% эластан',
    compositionUz: '97% paxta, 3% elastan',
    careRu: 'Машинная стирка 30°.',
    careUz: '30° da mashinada yuvish.',
    materials: ['cotton'],
    styleTags: ['smart_casual', 'business_casual', 'preppy', 'minimal'],
    occasions: ['office', 'everyday', 'travel', 'university'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 3,
    warmth: 2,
    chart: 'trousers-men-numeric',
    sizes: SIZES_TROUSERS,
    priceMajor: 680_000,
    stock: [4, 7, 9, 6, 3],
    attributes: { rise: 'mid', legOpening: 'straight', pockets: 5, pattern: 'plain' },
  },

  // ───────────────────────────────────── Atlas & Adras — national modern
  {
    externalId: 'AA-DRS-001',
    seller: 'atlas-adras',
    category: 'dresses',
    shape: 'dress',
    titleRu: 'Платье из адраса, бордовый узор',
    titleUz: 'Adrasdan ko‘ylak, bordo naqsh',
    titleEn: 'Adras dress, burgundy pattern',
    descRu:
      'Платье прямого силуэта из маргиланского адраса. Ткань ткут вручную, поэтому рисунок каждого отреза уникален. Длина миди, рукав 3/4, пояс в комплекте.',
    descUz:
      'Marg‘ilon adrasidan to‘g‘ri siluetli ko‘ylak. Mato qo‘lda to‘qiladi, shuning uchun har bir bo‘lakning naqshi betakror. Uzunligi midi, yeng 3/4, kamar bilan.',
    colorName: 'Бордовый узор',
    colorFamily: 'burgundy',
    gender: 'WOMEN',
    compositionRu: '50% шёлк, 50% хлопок (адрас, ручное ткачество)',
    compositionUz: '50% ipak, 50% paxta (adras, qo‘lda to‘qilgan)',
    careRu: 'Ручная стирка 30° или сухая чистка. Не выкручивать.',
    careUz: 'Qo‘lda 30° da yuvish yoki quruq tozalash. Siqib burmang.',
    materials: ['silk', 'cotton'],
    styleTags: ['national_modern', 'romantic', 'evening'],
    occasions: ['celebration', 'wedding_guest', 'evening_out', 'date'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 4,
    warmth: 2,
    fitNotes: 'Свободный силуэт, подчёркивается поясом. Между размерами — берите меньший.',
    chart: 'dresses-women-letter',
    sizes: SIZES_LETTER,
    priceMajor: 1_890_000,
    stock: [2, 4, 5, 3, 2],
    attributes: { sleeveLength: 'three_quarter', neckline: 'stand', closure: 'buttons', pattern: 'print' },
    authenticity: 'Маргиланский адрас, ручное ткачество. Сертификат ремесленной мастерской.',
    incompatibleStyles: ['sporty', 'athleisure'],
  },
  {
    externalId: 'AA-DRS-002',
    seller: 'atlas-adras',
    category: 'dresses',
    shape: 'dress',
    titleRu: 'Платье-рубашка из шёлка, кремовое',
    titleUz: 'Ipakdan ko‘ylak-ko‘ylak, krem',
    titleEn: 'Silk shirt dress, cream',
    descRu:
      'Платье-рубашка из плотного шёлка. Отложной воротник, потайная застёжка, пояс из той же ткани. Держит форму, не прилипает.',
    descUz:
      'Zich ipakdan ko‘ylak-ko‘ylak. Qaytarma yoqa, yashirin tugmalar, shu matodan kamar. Shaklini saqlaydi, yopishmaydi.',
    colorName: 'Кремовый',
    colorFamily: 'cream',
    gender: 'WOMEN',
    compositionRu: '100% шёлк (твил)',
    compositionUz: '100% ipak (tvil)',
    careRu: 'Сухая чистка. Глажка при 120° с изнаночной стороны.',
    careUz: 'Quruq tozalash. Ichkari tomondan 120° da dazmollash.',
    materials: ['silk'],
    styleTags: ['quiet_luxury', 'minimal', 'old_money', 'romantic'],
    occasions: ['office', 'date', 'celebration', 'business_meeting'],
    season: 'SS',
    silhouette: 'straight',
    formality: 4,
    warmth: 1,
    chart: 'dresses-women-letter',
    sizes: SIZES_LETTER,
    priceMajor: 1_420_000,
    compareAtMajor: 1_780_000,
    stock: [2, 3, 4, 3, 1],
    attributes: { sleeveLength: 'long', neckline: 'collar', closure: 'buttons', pattern: 'plain' },
  },
  {
    externalId: 'AA-BLS-001',
    seller: 'atlas-adras',
    category: 'blouses',
    shape: 'blouse',
    titleRu: 'Блуза из шёлка с объёмным рукавом, белая',
    titleUz: 'Hajmli yengli ipak bluza, oq',
    titleEn: 'Silk blouse with volume sleeve, white',
    descRu: 'Блуза из шёлкового крепа. Объёмный рукав со сборкой у манжеты, прямой силуэт корпуса.',
    descUz: 'Ipak krepdan bluza. Yeng uchida burmalangan hajmli yeng, to‘g‘ri korpus.',
    colorName: 'Белый',
    colorFamily: 'white',
    gender: 'WOMEN',
    compositionRu: '100% шёлк (креп)',
    compositionUz: '100% ipak (krep)',
    careRu: 'Ручная стирка 30° или сухая чистка.',
    careUz: 'Qo‘lda 30° da yuvish yoki quruq tozalash.',
    materials: ['silk'],
    styleTags: ['romantic', 'quiet_luxury', 'minimal', 'evening'],
    occasions: ['office', 'date', 'evening_out', 'celebration'],
    season: 'ALL_SEASON',
    silhouette: 'relaxed',
    formality: 4,
    warmth: 1,
    chart: 'tops-women-letter',
    sizes: SIZES_LETTER,
    priceMajor: 780_000,
    stock: [3, 5, 6, 4, 2],
    attributes: { sleeveLength: 'long', neckline: 'v', closure: 'buttons', pattern: 'plain' },
  },
  {
    externalId: 'AA-SKT-001',
    seller: 'atlas-adras',
    category: 'skirts',
    shape: 'skirt',
    titleRu: 'Юбка-миди из адраса, зелёный узор',
    titleUz: 'Adrasdan midi yubka, yashil naqsh',
    titleEn: 'Adras midi skirt, green pattern',
    descRu: 'Юбка на кокетке с мягкими складками. Адрас средней плотности, подкладка из хлопка.',
    descUz: 'Yumshoq burmali yubka. O‘rta zichlikdagi adras, paxta astar.',
    colorName: 'Зелёный узор',
    colorFamily: 'green',
    gender: 'WOMEN',
    compositionRu: '50% шёлк, 50% хлопок, подкладка 100% хлопок',
    compositionUz: '50% ipak, 50% paxta, astar 100% paxta',
    careRu: 'Сухая чистка.',
    careUz: 'Quruq tozalash.',
    materials: ['silk', 'cotton'],
    styleTags: ['national_modern', 'romantic', 'smart_casual'],
    occasions: ['office', 'celebration', 'everyday', 'date'],
    season: 'ALL_SEASON',
    silhouette: 'a_line',
    formality: 3,
    warmth: 2,
    chart: 'bottoms-women-letter',
    sizes: SIZES_LETTER,
    priceMajor: 820_000,
    stock: [2, 4, 5, 3, 1],
    attributes: { rise: 'high', pattern: 'print' },
  },
  {
    externalId: 'AA-SCF-001',
    seller: 'atlas-adras',
    category: 'scarves',
    shape: 'scarf',
    titleRu: 'Платок из шёлка-атласа, многоцветный',
    titleUz: 'Atlas ipakdan ro‘mol, rang-barang',
    titleEn: 'Atlas silk scarf, multicolour',
    descRu: 'Платок 90×90 см из атласного шёлка, ручная обработка края. Традиционный рисунок в современной палитре.',
    descUz: '90×90 sm atlas ipakdan ro‘mol, cheti qo‘lda ishlangan. An’anaviy naqsh zamonaviy ranglarda.',
    colorName: 'Многоцветный',
    colorFamily: 'multicolor',
    gender: 'UNISEX',
    compositionRu: '100% шёлк (атлас)',
    compositionUz: '100% ipak (atlas)',
    careRu: 'Сухая чистка.',
    careUz: 'Quruq tozalash.',
    materials: ['silk'],
    styleTags: ['national_modern', 'romantic', 'quiet_luxury'],
    occasions: ['everyday', 'celebration', 'travel', 'office'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 3,
    warmth: 2,
    chart: 'shoes-eu',
    sizes: ONE_SIZE,
    priceMajor: 420_000,
    stock: [14],
    attributes: { material: 'silk', dimensionsMm: '900x900' },
  },

  // ─────────────────────────────── Registan Knitwear — merino, cashmere
  {
    externalId: 'RG-KNT-001',
    seller: 'registan-knit',
    category: 'sweaters',
    shape: 'sweater',
    titleRu: 'Свитер из мериноса с круглым вырезом, кэмел',
    titleUz: 'Merinosdan yumaloq yoqali svitr, tuyarang',
    titleEn: 'Merino crew-neck sweater, camel',
    descRu:
      'Свитер из мериноса 19,5 микрон. Плотная вязка, не колется, держит форму после стирки. Круглый вырез — работает под пиджак.',
    descUz:
      '19,5 mikron merinosdan svitr. Zich to‘qilgan, qichishmaydi, yuvishdan keyin shaklini saqlaydi. Yumaloq yoqa — jaket ostiga mos.',
    colorName: 'Кэмел',
    colorFamily: 'camel',
    gender: 'UNISEX',
    compositionRu: '100% шерсть мериноса (19,5 мкм)',
    compositionUz: '100% merinos juni (19,5 mkm)',
    careRu: 'Ручная стирка 30° или деликатный режим для шерсти. Сушить горизонтально.',
    careUz: 'Qo‘lda 30° da yoki jun uchun nozik rejimda yuvish. Yotqizib quritish.',
    materials: ['wool', 'knit'],
    styleTags: ['old_money', 'quiet_luxury', 'minimal', 'preppy'],
    occasions: ['office', 'everyday', 'business_meeting', 'travel'],
    season: 'FW',
    silhouette: 'straight',
    formality: 3,
    warmth: 4,
    fitNotes: 'Трикотаж тянется: при промежуточных мерках берите меньший размер.',
    chart: 'knitwear-letter',
    sizes: SIZES_LETTER_FULL,
    priceMajor: 740_000,
    stock: [3, 6, 9, 7, 4, 2],
    attributes: { sleeveLength: 'long', neckline: 'crew', closure: 'none', pattern: 'plain' },
  },
  {
    externalId: 'RG-KNT-002',
    seller: 'registan-knit',
    category: 'sweaters',
    shape: 'sweater',
    titleRu: 'Свитер из кашемира, тёмно-серый',
    titleUz: 'Kashmirdan svitr, to‘q kulrang',
    titleEn: 'Cashmere sweater, charcoal',
    descRu: 'Двухслойный кашемир, вязка 12 класса. Мягкий, тёплый и достаточно плотный, чтобы носить без рубашки.',
    descUz: 'Ikki qatlamli kashmir, 12-sinf to‘qima. Yumshoq, issiq va ko‘ylaksiz kiyish uchun yetarlicha zich.',
    colorName: 'Тёмно-серый',
    colorFamily: 'grey',
    gender: 'UNISEX',
    compositionRu: '100% кашемир',
    compositionUz: '100% kashmir',
    careRu: 'Ручная стирка 30°. Хранить сложенным.',
    careUz: 'Qo‘lda 30° da yuvish. Buklab saqlang.',
    materials: ['cashmere', 'knit'],
    styleTags: ['quiet_luxury', 'old_money', 'minimal'],
    occasions: ['office', 'everyday', 'date', 'business_meeting'],
    season: 'FW',
    silhouette: 'straight',
    formality: 4,
    warmth: 4,
    chart: 'knitwear-letter',
    sizes: SIZES_LETTER,
    priceMajor: 1_480_000,
    stock: [2, 4, 5, 4, 2],
    attributes: { sleeveLength: 'long', neckline: 'crew', closure: 'none', pattern: 'plain' },
    authenticity: 'Кашемир внутренней Монголии, сертификат поставщика.',
  },
  {
    externalId: 'RG-KNT-003',
    seller: 'registan-knit',
    category: 'cardigans',
    shape: 'cardigan',
    titleRu: 'Кардиган из мериноса на пуговицах, кремовый',
    titleUz: 'Merinosdan tugmali kardigan, krem',
    titleEn: 'Merino button cardigan, cream',
    descRu: 'Кардиган прямого силуэта с перламутровыми пуговицами. Удлинённый, с боковыми карманами.',
    descUz: 'To‘g‘ri siluetli, sadaf tugmali kardigan. Uzunroq, yon kissalari bilan.',
    colorName: 'Кремовый',
    colorFamily: 'cream',
    gender: 'WOMEN',
    compositionRu: '100% шерсть мериноса',
    compositionUz: '100% merinos juni',
    careRu: 'Ручная стирка 30°.',
    careUz: 'Qo‘lda 30° da yuvish.',
    materials: ['wool', 'knit'],
    styleTags: ['quiet_luxury', 'minimal', 'preppy', 'romantic'],
    occasions: ['office', 'everyday', 'university'],
    season: 'TRANSITIONAL',
    silhouette: 'longline',
    formality: 3,
    warmth: 3,
    chart: 'knitwear-letter',
    sizes: SIZES_LETTER,
    priceMajor: 890_000,
    stock: [3, 5, 6, 4, 2],
    attributes: { sleeveLength: 'long', neckline: 'v', closure: 'buttons', pattern: 'plain' },
  },
  {
    externalId: 'RG-TSH-001',
    seller: 'registan-knit',
    category: 't-shirts',
    shape: 'tshirt',
    titleRu: 'Футболка из мерсеризованного хлопка, белая',
    titleUz: 'Merserlangan paxtadan futbolka, oq',
    titleEn: 'Mercerised cotton T-shirt, white',
    descRu: 'Футболка из мерсеризованного хлопка 220 г/м². Плотная, с лёгким блеском, не просвечивает.',
    descUz: '220 g/m² merserlangan paxtadan futbolka. Zich, yengil yaltiroq, shaffof emas.',
    colorName: 'Белый',
    colorFamily: 'white',
    gender: 'UNISEX',
    compositionRu: '100% хлопок (мерсеризованный)',
    compositionUz: '100% paxta (merserlangan)',
    careRu: 'Машинная стирка 30°.',
    careUz: '30° da mashinada yuvish.',
    materials: ['cotton'],
    styleTags: ['minimal', 'smart_casual', 'quiet_luxury'],
    occasions: ['everyday', 'travel', 'university', 'home'],
    season: 'SS',
    silhouette: 'straight',
    formality: 2,
    warmth: 1,
    chart: 'tops-men-letter',
    sizes: SIZES_LETTER_FULL,
    priceMajor: 290_000,
    stock: [6, 12, 18, 14, 8, 4],
    attributes: { sleeveLength: 'short', neckline: 'crew', closure: 'none', pattern: 'plain' },
  },

  // ─────────────────────────────────────── Mirzo Denim — denim and basics
  {
    externalId: 'MD-JNS-001',
    seller: 'mirzo-denim',
    category: 'jeans',
    shape: 'jeans',
    titleRu: 'Джинсы прямого кроя, индиго',
    titleUz: 'To‘g‘ri bichimli jinsi shim, indigo',
    titleEn: 'Straight-leg jeans, indigo',
    descRu:
      'Деним 13,5 oz, селвидж по внутреннему шву. Прямая штанина, средняя посадка, пять карманов. Разносятся по фигуре за несколько носок.',
    descUz:
      '13,5 oz denim, ichki tikuvda selvij. To‘g‘ri shtanina, o‘rta posadka, besh kissa. Bir necha kiyishdan keyin figuraga moslashadi.',
    colorName: 'Индиго',
    colorFamily: 'blue',
    gender: 'MEN',
    compositionRu: '100% хлопок (деним 13,5 oz)',
    compositionUz: '100% paxta (13,5 oz denim)',
    careRu: 'Стирка наизнанку 30°, без отбеливателя.',
    careUz: 'Ichkariga aylantirib 30° da yuvish, oqartirgichsiz.',
    materials: ['denim', 'cotton'],
    styleTags: ['streetwear', 'smart_casual', 'workwear', 'minimal'],
    occasions: ['everyday', 'university', 'travel', 'date'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 2,
    warmth: 3,
    fitNotes: 'Mirzo садится плотнее: при промежуточных мерках берите размер больше.',
    chart: 'mirzo-denim-jeans',
    sizes: SIZES_TROUSERS,
    priceMajor: 620_000,
    stock: [5, 9, 12, 8, 4],
    attributes: { rise: 'mid', legOpening: 'straight', pockets: 5, pattern: 'plain' },
  },
  {
    externalId: 'MD-JNS-002',
    seller: 'mirzo-denim',
    category: 'jeans',
    shape: 'jeans',
    titleRu: 'Джинсы свободного кроя, чёрные',
    titleUz: 'Erkin bichimli jinsi shim, qora',
    titleEn: 'Relaxed-fit jeans, black',
    descRu: 'Свободный крой с широкой штаниной, высокая посадка. Плотный чёрный деним без стрейча.',
    descUz: 'Keng shtaninali erkin bichim, baland posadka. Cho‘zilmaydigan zich qora denim.',
    colorName: 'Чёрный',
    colorFamily: 'black',
    gender: 'UNISEX',
    compositionRu: '100% хлопок (деним 12 oz)',
    compositionUz: '100% paxta (12 oz denim)',
    careRu: 'Стирка наизнанку 30°.',
    careUz: 'Ichkariga aylantirib 30° da yuvish.',
    materials: ['denim', 'cotton'],
    styleTags: ['streetwear', 'minimal', 'y2k'],
    occasions: ['everyday', 'university', 'evening_out'],
    season: 'ALL_SEASON',
    silhouette: 'wide_leg',
    formality: 2,
    warmth: 3,
    chart: 'mirzo-denim-jeans',
    sizes: SIZES_TROUSERS,
    priceMajor: 580_000,
    compareAtMajor: 720_000,
    stock: [4, 7, 9, 6, 3],
    attributes: { rise: 'high', legOpening: 'wide', pockets: 5, pattern: 'plain' },
  },
  {
    externalId: 'MD-JKT-001',
    seller: 'mirzo-denim',
    category: 'jackets',
    shape: 'blazer',
    titleRu: 'Джинсовая куртка, выбеленный индиго',
    titleUz: 'Jinsi kurtka, oqartirilgan indigo',
    titleEn: 'Denim jacket, washed indigo',
    descRu: 'Классическая джинсовая куртка с кокеткой и накладными карманами. Деним 11 oz, лёгкая стирка.',
    descUz: 'Klassik jinsi kurtka, ustiga qo‘yma kissalar bilan. 11 oz denim, yengil yuvilgan.',
    colorName: 'Выбеленный индиго',
    colorFamily: 'blue',
    gender: 'UNISEX',
    compositionRu: '100% хлопок (деним 11 oz)',
    compositionUz: '100% paxta (11 oz denim)',
    careRu: 'Машинная стирка 30°.',
    careUz: '30° da mashinada yuvish.',
    materials: ['denim', 'cotton'],
    styleTags: ['streetwear', 'smart_casual', 'workwear'],
    occasions: ['everyday', 'university', 'travel'],
    season: 'TRANSITIONAL',
    silhouette: 'cropped',
    formality: 2,
    warmth: 3,
    chart: 'outerwear-letter',
    sizes: SIZES_LETTER,
    priceMajor: 780_000,
    stock: [3, 6, 8, 5, 2],
    attributes: { lining: 'unlined', insulation: 'none', closure: 'buttons' },
    incompatibleStyles: ['business_formal', 'evening'],
  },
  {
    externalId: 'MD-TSH-001',
    seller: 'mirzo-denim',
    category: 't-shirts',
    shape: 'tshirt',
    titleRu: 'Футболка оверсайз из плотного хлопка, чёрная',
    titleUz: 'Zich paxtadan oversayz futbolka, qora',
    titleEn: 'Oversized heavyweight T-shirt, black',
    descRu: 'Футболка 240 г/м² свободного кроя с опущенным плечом. Не теряет форму после стирок.',
    descUz: '240 g/m², tushgan yelkali erkin bichimli futbolka. Yuvishdan keyin shaklini yo‘qotmaydi.',
    colorName: 'Чёрный',
    colorFamily: 'black',
    gender: 'UNISEX',
    compositionRu: '100% хлопок',
    compositionUz: '100% paxta',
    careRu: 'Машинная стирка 30°.',
    careUz: '30° da mashinada yuvish.',
    materials: ['cotton'],
    styleTags: ['streetwear', 'minimal', 'athleisure'],
    occasions: ['everyday', 'university', 'home', 'sport'],
    season: 'SS',
    silhouette: 'oversized',
    formality: 1,
    warmth: 1,
    chart: 'tops-men-letter',
    sizes: SIZES_LETTER_FULL,
    priceMajor: 240_000,
    stock: [8, 14, 20, 16, 10, 5],
    attributes: { sleeveLength: 'short', neckline: 'crew', closure: 'none', pattern: 'plain' },
  },

  // ─────────────────────────────────────────── Nurafshon Shoes — footwear
  {
    externalId: 'NF-LOF-001',
    seller: 'nurafshon-shoes',
    category: 'loafers',
    shape: 'loafer',
    titleRu: 'Лоферы из телячьей кожи, коричневые',
    titleUz: 'Buzoq terisidan loferlar, jigarrang',
    titleEn: 'Calf leather loafers, brown',
    descRu:
      'Лоферы-пенни на кожаной подошве, рантовая сборка. Кожа полного дубления — садится по стопе за неделю. Колодка средней полноты.',
    descUz:
      'Teri tagchali, rantli yig‘ilgan penni-loferlar. To‘liq oshlangan teri — bir hafta ichida oyoqqa moslashadi. O‘rta to‘liqlikdagi qolip.',
    colorName: 'Коричневый',
    colorFamily: 'brown',
    gender: 'MEN',
    compositionRu: 'Верх: телячья кожа. Подошва: кожа. Подкладка: кожа.',
    compositionUz: 'Ustki qism: buzoq terisi. Taglik: teri. Astar: teri.',
    careRu: 'Крем для кожи раз в месяц. Использовать колодки для хранения.',
    careUz: 'Oyda bir marta teri kremi. Saqlash uchun qolip ishlatilsin.',
    materials: ['leather'],
    styleTags: ['old_money', 'quiet_luxury', 'business_casual', 'preppy'],
    occasions: ['office', 'business_meeting', 'date', 'celebration'],
    season: 'ALL_SEASON',
    silhouette: 'fitted',
    formality: 4,
    warmth: 2,
    fitNotes: 'Кожаная подошва и полное дубление: первые дни садятся плотно, затем разносятся.',
    chart: 'shoes-eu',
    sizes: SIZES_SHOES,
    priceMajor: 1_180_000,
    stock: [3, 5, 7, 6, 4, 2],
    attributes: { upperMaterial: 'leather', soleMaterial: 'leather', closure: 'slip_on', heelHeightMm: 20 },
    authenticity: 'Ручная сборка, Ташкент. Гарантия на сборку 6 месяцев.',
  },
  {
    externalId: 'NF-LOF-002',
    seller: 'nurafshon-shoes',
    category: 'loafers',
    shape: 'loafer',
    titleRu: 'Лоферы из замши, тёмно-синие',
    titleUz: 'Zamshadan loferlar, to‘q ko‘k',
    titleEn: 'Suede loafers, navy',
    descRu: 'Замшевые лоферы на резиновой подошве. Мягкая конструкция без подноска, можно носить без носков.',
    descUz: 'Rezina tagchali zamsha loferlar. Yumshoq konstruksiya, paypoqsiz kiyish mumkin.',
    colorName: 'Тёмно-синий',
    colorFamily: 'navy',
    gender: 'MEN',
    compositionRu: 'Верх: замша. Подошва: резина. Подкладка: кожа.',
    compositionUz: 'Ustki qism: zamsha. Taglik: rezina. Astar: teri.',
    careRu: 'Щётка для замши, водоотталкивающая пропитка.',
    careUz: 'Zamsha uchun cho‘tka, suv qaytaruvchi vosita.',
    materials: ['suede'],
    styleTags: ['smart_casual', 'old_money', 'resort', 'business_casual'],
    occasions: ['office', 'everyday', 'travel', 'date'],
    season: 'SS',
    silhouette: 'fitted',
    formality: 3,
    warmth: 2,
    chart: 'shoes-eu',
    sizes: SIZES_SHOES,
    priceMajor: 940_000,
    stock: [2, 4, 6, 5, 3, 1],
    attributes: { upperMaterial: 'suede', soleMaterial: 'rubber', closure: 'slip_on', heelHeightMm: 18 },
  },
  {
    externalId: 'NF-BOT-001',
    seller: 'nurafshon-shoes',
    category: 'boots',
    shape: 'boot',
    titleRu: 'Ботинки челси из кожи, чёрные',
    titleUz: 'Teridan chelsi botinkalar, qora',
    titleEn: 'Leather Chelsea boots, black',
    descRu: 'Челси с эластичными вставками на протекторной подошве. Кожа с лёгким вощением, выдерживает слякоть.',
    descUz: 'Elastik qistirmali chelsi, protektorli taglik. Yengil mumlangan teri, loyqa havoga chidamli.',
    colorName: 'Чёрный',
    colorFamily: 'black',
    gender: 'UNISEX',
    compositionRu: 'Верх: кожа. Подошва: резина (протектор). Подкладка: кожа.',
    compositionUz: 'Ustki qism: teri. Taglik: rezina (protektor). Astar: teri.',
    careRu: 'Воск для кожи, сушить вдали от тепла.',
    careUz: 'Teri uchun mum, issiqdan uzoqda quritish.',
    materials: ['leather'],
    styleTags: ['minimal', 'workwear', 'smart_casual', 'old_money'],
    occasions: ['everyday', 'office', 'travel'],
    season: 'FW',
    silhouette: 'fitted',
    formality: 3,
    warmth: 4,
    chart: 'shoes-eu',
    sizes: SIZES_SHOES,
    priceMajor: 1_490_000,
    stock: [2, 4, 6, 5, 3, 2],
    attributes: { upperMaterial: 'leather', soleMaterial: 'rubber', closure: 'slip_on', heelHeightMm: 28 },
  },
  {
    externalId: 'NF-HEL-001',
    seller: 'nurafshon-shoes',
    category: 'heels',
    shape: 'heel',
    titleRu: 'Туфли-лодочки из кожи, бордовые',
    titleUz: 'Teridan tuflilar, bordo',
    titleEn: 'Leather pumps, burgundy',
    descRu: 'Лодочки на устойчивом каблуке 55 мм. Кожаная стелька, миндальный носок.',
    descUz: '55 mm barqaror poshnali tuflilar. Teri ichki taglik, bodomsimon uchi.',
    colorName: 'Бордовый',
    colorFamily: 'burgundy',
    gender: 'WOMEN',
    compositionRu: 'Верх: кожа. Подошва: кожа с резиновой набойкой.',
    compositionUz: 'Ustki qism: teri. Taglik: teri, rezina qoplama bilan.',
    careRu: 'Крем для кожи, набойки менять по износу.',
    careUz: 'Teri kremi, qoplamani yemirilishiga qarab almashtirish.',
    materials: ['leather'],
    styleTags: ['evening', 'quiet_luxury', 'business_formal', 'romantic'],
    occasions: ['evening_out', 'celebration', 'wedding_guest', 'business_meeting'],
    season: 'ALL_SEASON',
    silhouette: 'fitted',
    formality: 5,
    warmth: 1,
    chart: 'shoes-eu',
    sizes: SIZES_SHOES_W,
    priceMajor: 1_120_000,
    stock: [3, 5, 6, 4, 2],
    attributes: { upperMaterial: 'leather', soleMaterial: 'leather', closure: 'slip_on', heelHeightMm: 55 },
    incompatibleStyles: ['sporty', 'athleisure'],
  },
  {
    externalId: 'NF-BAG-001',
    seller: 'nurafshon-shoes',
    category: 'bags',
    shape: 'bag',
    titleRu: 'Сумка-тоут из кожи, кэмел',
    titleUz: 'Teridan tout sumka, tuyarang',
    titleEn: 'Leather tote bag, camel',
    descRu: 'Тоут на двух ручках, вмещает ноутбук 14". Кожа растительного дубления, со временем темнеет.',
    descUz: 'Ikki tutqichli tout, 14" noutbuk sig‘adi. O‘simlik oshlanmasi, vaqt o‘tishi bilan to‘qlashadi.',
    colorName: 'Кэмел',
    colorFamily: 'camel',
    gender: 'UNISEX',
    compositionRu: '100% кожа растительного дубления, подкладка — хлопковый канвас',
    compositionUz: '100% o‘simlik oshlanmali teri, astar — paxta kanvas',
    careRu: 'Крем для кожи раз в 2 месяца.',
    careUz: '2 oyda bir marta teri kremi.',
    materials: ['leather'],
    styleTags: ['old_money', 'quiet_luxury', 'minimal', 'business_casual'],
    occasions: ['office', 'everyday', 'travel', 'business_meeting'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 3,
    warmth: 1,
    chart: 'shoes-eu',
    sizes: ONE_SIZE,
    priceMajor: 1_680_000,
    stock: [6],
    attributes: { material: 'leather', dimensionsMm: '380x300x120' },
  },
  {
    externalId: 'NF-BLT-001',
    seller: 'nurafshon-shoes',
    category: 'belts',
    shape: 'belt',
    titleRu: 'Ремень из кожи с латунной пряжкой, коричневый',
    titleUz: 'Jez to‘qali teri kamar, jigarrang',
    titleEn: 'Leather belt with brass buckle, brown',
    descRu: 'Ремень 35 мм из цельного куска кожи, пряжка из латуни. Под брюки и джинсы.',
    descUz: 'Yaxlit teridan 35 mm kamar, jez to‘qa. Shim va jinsi uchun.',
    colorName: 'Коричневый',
    colorFamily: 'brown',
    gender: 'MEN',
    compositionRu: '100% кожа, пряжка — латунь',
    compositionUz: '100% teri, to‘qa — jez',
    careRu: 'Крем для кожи, не перегибать.',
    careUz: 'Teri kremi, keskin bukmang.',
    materials: ['leather'],
    styleTags: ['old_money', 'minimal', 'business_casual', 'workwear'],
    occasions: ['office', 'everyday', 'business_meeting'],
    season: 'ALL_SEASON',
    silhouette: 'straight',
    formality: 3,
    warmth: 1,
    chart: 'shoes-eu',
    sizes: ['85', '90', '95', '100', '105'],
    priceMajor: 320_000,
    stock: [4, 7, 8, 5, 3],
    attributes: { material: 'leather', dimensionsMm: '35' },
  },

  // ───────────────────────────────────────── Yoshlik Sport — athleisure
  {
    externalId: 'YS-SNK-001',
    seller: 'yoshlik-sport',
    category: 'sneakers',
    shape: 'sneaker',
    titleRu: 'Кроссовки из кожи, белые',
    titleUz: 'Teridan krossovkalar, oq',
    titleEn: 'Leather sneakers, white',
    descRu: 'Минималистичные кроссовки на вулканизированной подошве. Кожаный верх, перфорация по бокам.',
    descUz: 'Vulkanlangan tagchali minimalistik krossovkalar. Teri ustki qism, yon tomonlarda perforatsiya.',
    colorName: 'Белый',
    colorFamily: 'white',
    gender: 'UNISEX',
    compositionRu: 'Верх: кожа. Подошва: резина. Стелька: съёмная, EVA.',
    compositionUz: 'Ustki qism: teri. Taglik: rezina. Ichki taglik: yechiladigan, EVA.',
    careRu: 'Влажная салфетка, не стирать в машине.',
    careUz: 'Nam salfetka, mashinada yuvmang.',
    materials: ['leather'],
    styleTags: ['minimal', 'smart_casual', 'athleisure', 'streetwear'],
    occasions: ['everyday', 'university', 'travel', 'sport'],
    season: 'ALL_SEASON',
    silhouette: 'fitted',
    formality: 2,
    warmth: 2,
    chart: 'shoes-eu',
    sizes: SIZES_SHOES,
    priceMajor: 820_000,
    stock: [4, 8, 11, 9, 6, 3],
    attributes: { upperMaterial: 'leather', soleMaterial: 'rubber', closure: 'laces', heelHeightMm: 25 },
  },
  {
    externalId: 'YS-SNK-002',
    seller: 'yoshlik-sport',
    category: 'sneakers',
    shape: 'sneaker',
    titleRu: 'Кроссовки для бега, серо-синие',
    titleUz: 'Yugurish uchun krossovkalar, kulrang-ko‘k',
    titleEn: 'Running sneakers, grey-blue',
    descRu: 'Беговые кроссовки с амортизирующей пеной и сетчатым верхом. Вес 265 г (размер 42).',
    descUz: 'Amortizatsiyali ko‘pik va to‘rli ustki qismli yugurish krossovkalari. Vazni 265 g (42-o‘lcham).',
    colorName: 'Серо-синий',
    colorFamily: 'grey',
    gender: 'UNISEX',
    compositionRu: 'Верх: сетка (полиэстер). Подошва: EVA + резина.',
    compositionUz: 'Ustki qism: to‘r (poliester). Taglik: EVA + rezina.',
    careRu: 'Ручная чистка, сушить при комнатной температуре.',
    careUz: 'Qo‘lda tozalash, xona haroratida quritish.',
    materials: ['polyester', 'nylon'],
    styleTags: ['sporty', 'athleisure'],
    occasions: ['sport', 'everyday', 'travel'],
    season: 'ALL_SEASON',
    silhouette: 'fitted',
    formality: 1,
    warmth: 2,
    chart: 'shoes-eu',
    sizes: SIZES_SHOES,
    priceMajor: 690_000,
    compareAtMajor: 890_000,
    stock: [3, 6, 9, 7, 5, 2],
    attributes: { upperMaterial: 'textile', soleMaterial: 'eva', closure: 'laces', heelHeightMm: 30 },
    incompatibleStyles: ['business_formal', 'evening', 'old_money'],
  },
  {
    externalId: 'YS-HOD-001',
    seller: 'yoshlik-sport',
    category: 'hoodies',
    shape: 'hoodie',
    titleRu: 'Худи из петлевого хлопка, серое',
    titleUz: 'Halqali paxtadan xudi, kulrang',
    titleEn: 'Loopback cotton hoodie, grey',
    descRu: 'Худи 400 г/м² из петлевого хлопка. Двойной капюшон, плотные манжеты, карман-кенгуру.',
    descUz: '400 g/m² halqali paxtadan xudi. Ikki qatlamli kapyushon, zich manjetlar, kenguru kissa.',
    colorName: 'Серый',
    colorFamily: 'grey',
    gender: 'UNISEX',
    compositionRu: '80% хлопок, 20% полиэстер',
    compositionUz: '80% paxta, 20% poliester',
    careRu: 'Машинная стирка 30°, не сушить в машине.',
    careUz: '30° da mashinada yuvish, mashinada quritmang.',
    materials: ['cotton', 'polyester'],
    styleTags: ['athleisure', 'streetwear', 'sporty'],
    occasions: ['everyday', 'sport', 'home', 'university'],
    season: 'TRANSITIONAL',
    silhouette: 'relaxed',
    formality: 1,
    warmth: 3,
    chart: 'knitwear-letter',
    sizes: SIZES_LETTER_FULL,
    priceMajor: 420_000,
    stock: [5, 10, 14, 11, 7, 3],
    attributes: { sleeveLength: 'long', neckline: 'crew', closure: 'none', pattern: 'plain' },
    incompatibleStyles: ['business_formal', 'evening'],
  },
  {
    externalId: 'YS-TRS-001',
    seller: 'yoshlik-sport',
    category: 'trousers',
    shape: 'trousers',
    titleRu: 'Брюки из технической ткани, чёрные',
    titleUz: 'Texnik matodan shim, qora',
    titleEn: 'Technical trousers, black',
    descRu: 'Брюки из быстросохнущей ткани с эластаном. Прямой крой, карманы на молнии, пояс на резинке.',
    descUz: 'Elastanli, tez quriydigan matodan shim. To‘g‘ri bichim, zamokli kissalar, rezinkali kamar.',
    colorName: 'Чёрный',
    colorFamily: 'black',
    gender: 'UNISEX',
    compositionRu: '88% полиэстер, 12% эластан',
    compositionUz: '88% poliester, 12% elastan',
    careRu: 'Машинная стирка 30°, без кондиционера.',
    careUz: '30° da mashinada yuvish, kondisionersiz.',
    materials: ['polyester'],
    styleTags: ['sporty', 'athleisure', 'minimal'],
    occasions: ['sport', 'everyday', 'travel'],
    season: 'ALL_SEASON',
    silhouette: 'tapered',
    formality: 1,
    warmth: 2,
    chart: 'trousers-men-numeric',
    sizes: SIZES_TROUSERS,
    priceMajor: 510_000,
    stock: [4, 8, 10, 7, 4],
    attributes: { rise: 'mid', legOpening: 'slim', pockets: 4, pattern: 'plain' },
    incompatibleStyles: ['business_formal', 'evening', 'old_money'],
  },
  {
    externalId: 'YS-CAP-001',
    seller: 'yoshlik-sport',
    category: 'accessories',
    shape: 'cap',
    titleRu: 'Кепка из хлопка, тёмно-синяя',
    titleUz: 'Paxtadan kepka, to‘q ko‘k',
    titleEn: 'Cotton cap, navy',
    descRu: 'Шестипанельная кепка из саржи, регулируемый ремешок.',
    descUz: 'Sarja matodan olti panelli kepka, sozlanadigan tasma.',
    colorName: 'Тёмно-синий',
    colorFamily: 'navy',
    gender: 'UNISEX',
    compositionRu: '100% хлопок (саржа)',
    compositionUz: '100% paxta (sarja)',
    careRu: 'Ручная стирка 30°.',
    careUz: 'Qo‘lda 30° da yuvish.',
    materials: ['cotton'],
    styleTags: ['sporty', 'streetwear', 'athleisure'],
    occasions: ['everyday', 'sport', 'travel'],
    season: 'SS',
    silhouette: 'fitted',
    formality: 1,
    warmth: 1,
    chart: 'shoes-eu',
    sizes: ONE_SIZE,
    priceMajor: 180_000,
    stock: [18],
    attributes: { material: 'canvas' },
    incompatibleStyles: ['business_formal', 'evening'],
  },
];

async function seedProducts(
  sellers: Map<string, { sellerId: string; brandId: string }>,
  categories: Map<string, { id: string }>,
  charts: Map<string, string>,
) {
  const out: Array<{ id: string; slug: string; externalId: string; categorySlug: string; slot: string | null }> = [];

  for (const seed of PRODUCTS) {
    const seller = sellers.get(seed.seller);
    const category = categories.get(seed.category);
    if (!seller || !category) {
      console.warn(`  ! skipping ${seed.externalId}: unknown seller or category`);
      continue;
    }

    const policy = await prisma.returnPolicy.findUnique({ where: { code: `${seed.seller}-standard` } });
    const slug = slugify(`${seed.titleEn}-${seed.colorFamily}`);

    const existing = await prisma.product.findFirst({
      where: { sellerId: seller.sellerId, externalId: seed.externalId },
      select: { id: true },
    });

    const data = {
      titleRu: seed.titleRu,
      titleUz: seed.titleUz,
      titleEn: seed.titleEn,
      descriptionRu: seed.descRu,
      descriptionUz: seed.descUz,
      descriptionEn: null,
      gender: seed.gender as never,
      compositionRu: seed.compositionRu,
      compositionUz: seed.compositionUz,
      careRu: seed.careRu,
      careUz: seed.careUz,
      countryOfOrigin: 'UZ',
      materials: seed.materials,
      colorName: seed.colorName,
      colorFamily: seed.colorFamily,
      styleTags: seed.styleTags,
      occasions: seed.occasions,
      season: seed.season,
      silhouette: seed.silhouette,
      formality: seed.formality,
      warmth: seed.warmth,
      fitNotes: seed.fitNotes ?? null,
      sizeChartId: charts.get(seed.chart) ?? null,
      returnPolicyId: policy?.id ?? null,
      authenticityNote: seed.authenticity ?? null,
      incompatibleStyles: seed.incompatibleStyles ?? [],
      attributes: seed.attributes as Prisma.InputJsonValue,
      categoryId: category.id,
      brandId: seller.brandId,
      lifecycle: 'PUBLISHED' as const,
      publishedAt: new Date(),
      // Popularity gives the retrieval and home rails a deterministic order.
      popularityScore: 10 + (seed.externalId.charCodeAt(4) % 40),
    };

    const product = existing
      ? await prisma.product.update({ where: { id: existing.id }, data })
      : await prisma.product.create({
          data: { ...data, slug, externalId: seed.externalId, sellerId: seller.sellerId },
        });

    // ── media (CAT-004): a main, a back and a detail shot, with alt text in
    // both required locales and content rights recorded.
    const variants: Array<{ role: 'MAIN' | 'BACK' | 'DETAIL'; variant: 'main' | 'back' | 'detail' }> = [
      { role: 'MAIN', variant: 'main' },
      { role: 'BACK', variant: 'back' },
      { role: 'DETAIL', variant: 'detail' },
    ];

    for (const [index, entry] of variants.entries()) {
      const fileName = `product-${seed.externalId.toLowerCase()}-${entry.variant}.svg`;
      const media = await writeSvg(
        MEDIA_DIR,
        fileName,
        renderProductSvg({
          fileName,
          shape: seed.shape,
          colorFamily: seed.colorFamily,
          brandName: seed.seller.replace(/-/g, ' '),
          label: seed.titleRu,
          variant: entry.variant,
        }),
        MEDIA_BASE,
        IMAGE_SIZE,
        seed.colorFamily,
      );

      const existingMedia = await prisma.media.findFirst({
        where: { productId: product.id, role: entry.role },
      });
      const mediaData = {
        url: media.url,
        kind: 'IMAGE' as const,
        role: entry.role as never,
        altRu: `${seed.titleRu} — ${entry.variant === 'main' ? 'основное фото' : entry.variant === 'back' ? 'вид сзади' : 'деталь'}`,
        altUz: `${seed.titleUz} — ${entry.variant === 'main' ? 'asosiy surat' : entry.variant === 'back' ? 'orqa ko‘rinish' : 'detal'}`,
        altEn: `${seed.titleEn} — ${entry.variant}`,
        width: media.width,
        height: media.height,
        placeholder: media.placeholder,
        sortOrder: index,
        rightsConfirmedAt: new Date(),
        qualityIssues: [],
      };
      if (existingMedia) {
        await prisma.media.update({ where: { id: existingMedia.id }, data: mediaData });
      } else {
        await prisma.media.create({ data: { productId: product.id, ...mediaData } });
      }
    }

    // ── SKUs and stock (CAT-005, CAT-007)
    const chartRows = await loadChartRows(charts.get(seed.chart));
    for (const [index, sizeLabel] of seed.sizes.entries()) {
      const measurements = chartRows.get(sizeLabel)?.garment ?? {};
      const sku = await prisma.sku.upsert({
        where: {
          productId_sizeLabel_colorName: { productId: product.id, sizeLabel, colorName: '' },
        },
        create: {
          productId: product.id,
          sizeLabel,
          sizeOrder: Math.round(sizeSortKey(sizeLabel)),
          sellerSku: `${seed.externalId}-${sizeLabel}`,
          barcode: `478${String(Math.abs(hashCode(`${seed.externalId}${sizeLabel}`))).padStart(10, '0').slice(0, 10)}`,
          priceMinor: uzs(seed.priceMajor),
          compareAtMinor: seed.compareAtMajor ? uzs(seed.compareAtMajor) : null,
          measurements: measurements as Prisma.InputJsonValue,
          weightGrams: estimateWeight(seed.shape),
          isActive: true,
        },
        update: {
          priceMinor: uzs(seed.priceMajor),
          compareAtMinor: seed.compareAtMajor ? uzs(seed.compareAtMajor) : null,
          measurements: measurements as Prisma.InputJsonValue,
          isActive: true,
        },
      });

      const onHand = seed.stock[index] ?? 0;
      await prisma.inventory.upsert({
        where: { skuId: sku.id },
        create: {
          skuId: sku.id,
          onHand,
          safetyStock: onHand > 6 ? 1 : 0,
          lowStockThreshold: 2,
          location: 'TAS-WH-1',
          lastFeedAt: new Date(),
        },
        update: { onHand, lastFeedAt: new Date() },
      });
    }

    // BUY-002: the transliterated search blob.
    const full = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      include: {
        brand: { select: { name: true, slug: true } },
        category: { select: { nameRu: true, nameUz: true, nameEn: true, slug: true } },
        skus: { select: { sizeLabel: true, sellerSku: true, barcode: true } },
      },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: {
        searchDocument: buildSearchDocument([
          full.titleRu,
          full.titleUz,
          full.titleEn,
          full.brand.name,
          full.brand.slug,
          full.category.nameRu,
          full.category.nameUz,
          full.category.nameEn,
          full.category.slug,
          full.colorName,
          full.colorFamily,
          ...full.materials,
          ...full.styleTags,
          ...full.occasions,
          full.season,
          full.silhouette,
          ...full.skus.map((sku) => sku.sizeLabel),
          ...full.skus.map((sku) => sku.sellerSku),
          ...full.skus.map((sku) => sku.barcode),
        ]),
      },
    });

    out.push({
      id: product.id,
      slug: product.slug,
      externalId: seed.externalId,
      categorySlug: seed.category,
      slot: null,
    });
  }

  console.log(`  products: ${out.length} published, with media, SKUs and stock`);
  return out;
}

async function loadChartRows(chartId: string | undefined): Promise<Map<string, ChartRow>> {
  if (!chartId) return new Map();
  const chart = await prisma.sizeChart.findUnique({ where: { id: chartId } });
  const rows = (chart?.rows as unknown as ChartRow[]) ?? [];
  return new Map(rows.map((row) => [row.sizeLabel, row]));
}

// ────────────────────────────────── collections and curated looks (AI-010)

async function seedCollectionsAndLooks(
  products: Array<{ id: string; externalId: string }>,
) {
  const byExternal = new Map(products.map((product) => [product.externalId, product.id]));
  const pick = (ids: string[]) => ids.map((id) => byExternal.get(id)).filter(Boolean) as string[];

  const collections = [
    {
      slug: 'office-essentials',
      titleRu: 'База для офиса',
      titleUz: 'Ofis uchun asos',
      titleEn: 'Office essentials',
      subtitleRu: 'Костюмная классика, рубашки и обувь, которые работают вместе',
      subtitleUz: 'Birga ishlaydigan kostyum klassikasi, ko‘ylaklar va oyoq kiyim',
      colorFamily: 'navy',
      shapes: ['blazer', 'shirt', 'loafer'] as GarmentShape[],
      items: ['CH-BLZ-001', 'CH-SHRT-001', 'CH-TRS-001', 'NF-LOF-001', 'RG-KNT-001', 'NF-BLT-001'],
    },
    {
      slug: 'uzbek-craft',
      titleRu: 'Узбекское ремесло',
      titleUz: 'O‘zbek hunarmandchiligi',
      titleEn: 'Uzbek craft',
      subtitleRu: 'Адрас и атлас в современных силуэтах',
      subtitleUz: 'Adras va atlas zamonaviy siluetlarda',
      colorFamily: 'burgundy',
      shapes: ['dress', 'skirt', 'scarf'] as GarmentShape[],
      items: ['AA-DRS-001', 'AA-SKT-001', 'AA-SCF-001', 'AA-BLS-001', 'NF-HEL-001'],
    },
    {
      slug: 'winter-layers',
      titleRu: 'Зимние слои',
      titleUz: 'Qishki qatlamlar',
      titleEn: 'Winter layers',
      subtitleRu: 'Пальто, трикотаж и обувь для −5',
      subtitleUz: '−5 uchun palto, trikotaj va oyoq kiyim',
      colorFamily: 'camel',
      shapes: ['coat', 'sweater', 'boot'] as GarmentShape[],
      items: ['CH-COAT-001', 'RG-KNT-002', 'RG-KNT-001', 'NF-BOT-001', 'CH-TRS-001'],
    },
    {
      slug: 'everyday-denim',
      titleRu: 'Повседневный деним',
      titleUz: 'Kundalik denim',
      titleEn: 'Everyday denim',
      subtitleRu: 'Джинсы, футболки и кроссовки',
      subtitleUz: 'Jinsi, futbolka va krossovka',
      colorFamily: 'blue',
      shapes: ['jeans', 'tshirt', 'sneaker'] as GarmentShape[],
      items: ['MD-JNS-001', 'MD-JNS-002', 'MD-TSH-001', 'RG-TSH-001', 'YS-SNK-001', 'MD-JKT-001'],
    },
  ];

  for (const [index, collection] of collections.entries()) {
    const cover = await writeSvg(
      MEDIA_DIR,
      `collection-${collection.slug}.svg`,
      renderBannerSvg({
        title: collection.titleRu,
        subtitle: collection.subtitleRu,
        colorFamily: collection.colorFamily,
        shapes: collection.shapes,
      }),
      MEDIA_BASE,
      BANNER_SIZE,
      collection.colorFamily,
    );

    const row = await prisma.collection.upsert({
      where: { slug: collection.slug },
      create: {
        slug: collection.slug,
        titleRu: collection.titleRu,
        titleUz: collection.titleUz,
        titleEn: collection.titleEn,
        subtitleRu: collection.subtitleRu,
        subtitleUz: collection.subtitleUz,
        coverUrl: cover.url,
        isActive: true,
        sortOrder: index,
      },
      update: { coverUrl: cover.url, isActive: true, sortOrder: index },
    });

    for (const [itemIndex, productId] of pick(collection.items).entries()) {
      await prisma.collectionItem.upsert({
        where: { collectionId_productId: { collectionId: row.id, productId } },
        create: { collectionId: row.id, productId, sortOrder: itemIndex },
        update: { sortOrder: itemIndex },
      });
    }
  }

  // AI-010: curated looks act as a prior for the stylist and as ground truth
  // for its evaluation set.
  const looks = [
    {
      slug: 'old-money-office',
      titleRu: 'Old money для офиса',
      titleUz: 'Ofis uchun old money',
      titleEn: 'Old money office',
      descRu: 'Тёмно-синий пиджак, белая рубашка, серые брюки со складкой и коричневые лоферы.',
      descUz: 'To‘q ko‘k jaket, oq ko‘ylak, burmali kulrang shim va jigarrang loferlar.',
      colorFamily: 'navy',
      styleTags: ['old_money', 'business_casual', 'quiet_luxury'],
      occasions: ['office', 'business_meeting'],
      season: 'ALL_SEASON',
      items: [
        { externalId: 'CH-BLZ-001', slot: 'OUTERWEAR' },
        { externalId: 'CH-SHRT-001', slot: 'TOP' },
        { externalId: 'CH-TRS-001', slot: 'BOTTOM' },
        { externalId: 'NF-LOF-001', slot: 'FOOTWEAR' },
        { externalId: 'NF-BLT-001', slot: 'ACCESSORY' },
      ],
    },
    {
      slug: 'winter-camel',
      titleRu: 'Зимний кэмел',
      titleUz: 'Qishki tuyarang',
      titleEn: 'Winter camel',
      descRu: 'Пальто цвета кэмел, кашемировый свитер, серые брюки, чёрные челси.',
      descUz: 'Tuyarang palto, kashmir svitr, kulrang shim, qora chelsi.',
      colorFamily: 'camel',
      styleTags: ['old_money', 'quiet_luxury', 'minimal'],
      occasions: ['office', 'everyday'],
      season: 'FW',
      items: [
        { externalId: 'CH-COAT-001', slot: 'OUTERWEAR' },
        { externalId: 'RG-KNT-002', slot: 'MID_LAYER' },
        { externalId: 'CH-TRS-001', slot: 'BOTTOM' },
        { externalId: 'NF-BOT-001', slot: 'FOOTWEAR' },
      ],
    },
    {
      slug: 'adras-evening',
      titleRu: 'Вечер в адрасе',
      titleUz: 'Adrasdagi kecha',
      titleEn: 'Adras evening',
      descRu: 'Платье из адраса, бордовые лодочки и шёлковый платок.',
      descUz: 'Adras ko‘ylak, bordo tuflilar va ipak ro‘mol.',
      colorFamily: 'burgundy',
      styleTags: ['national_modern', 'evening', 'romantic'],
      occasions: ['celebration', 'wedding_guest', 'evening_out'],
      season: 'ALL_SEASON',
      items: [
        { externalId: 'AA-DRS-001', slot: 'FULL_BODY' },
        { externalId: 'NF-HEL-001', slot: 'FOOTWEAR' },
        { externalId: 'AA-SCF-001', slot: 'ACCESSORY' },
      ],
    },
    {
      slug: 'weekend-denim',
      titleRu: 'Деним на выходные',
      titleUz: 'Dam olish kuni denimi',
      titleEn: 'Weekend denim',
      descRu: 'Прямые джинсы, белая футболка, кожаные кроссовки и джинсовая куртка.',
      descUz: 'To‘g‘ri jinsi, oq futbolka, teri krossovka va jinsi kurtka.',
      colorFamily: 'blue',
      styleTags: ['smart_casual', 'minimal', 'streetwear'],
      occasions: ['everyday', 'university', 'travel'],
      season: 'TRANSITIONAL',
      items: [
        { externalId: 'MD-JKT-001', slot: 'OUTERWEAR' },
        { externalId: 'RG-TSH-001', slot: 'TOP' },
        { externalId: 'MD-JNS-001', slot: 'BOTTOM' },
        { externalId: 'YS-SNK-001', slot: 'FOOTWEAR' },
      ],
    },
  ];

  for (const [index, look] of looks.entries()) {
    const cover = await writeSvg(
      MEDIA_DIR,
      `look-${look.slug}.svg`,
      renderBannerSvg({
        title: look.titleRu,
        subtitle: look.descRu,
        colorFamily: look.colorFamily,
        shapes: ['blazer', 'trousers', 'loafer'],
      }),
      MEDIA_BASE,
      BANNER_SIZE,
      look.colorFamily,
    );

    const row = await prisma.curatedOutfit.upsert({
      where: { slug: look.slug },
      create: {
        slug: look.slug,
        titleRu: look.titleRu,
        titleUz: look.titleUz,
        titleEn: look.titleEn,
        descriptionRu: look.descRu,
        descriptionUz: look.descUz,
        coverUrl: cover.url,
        styleTags: look.styleTags,
        occasions: look.occasions,
        season: look.season,
        isActive: true,
        sortOrder: index,
      },
      update: { coverUrl: cover.url, isActive: true, sortOrder: index },
    });

    for (const [itemIndex, item] of look.items.entries()) {
      const productId = byExternal.get(item.externalId);
      if (!productId) continue;
      await prisma.curatedOutfitItem.upsert({
        where: { outfitId_productId: { outfitId: row.id, productId } },
        create: { outfitId: row.id, productId, slot: item.slot as never, sortOrder: itemIndex },
        update: { slot: item.slot as never, sortOrder: itemIndex },
      });
    }
  }

  console.log(`  collections: ${collections.length}, curated looks: ${looks.length}`);
}

// ───────────────────────────────────────────────────────── CMS (BUY-001)

async function seedCms(products: Array<{ externalId: string; id: string }>) {
  void products;
  const hero = await writeSvg(
    MEDIA_DIR,
    'cms-hero-autumn.svg',
    renderBannerSvg({
      title: 'Осень в Ташкенте',
      subtitle: 'Слои, шерсть и спокойная палитра',
      colorFamily: 'camel',
      shapes: ['coat', 'sweater', 'boot'],
    }),
    MEDIA_BASE,
    BANNER_SIZE,
    'camel',
  );

  const blocks = [
    {
      key: 'home-hero',
      kind: 'HERO' as const,
      titleRu: 'Осень в Ташкенте',
      titleUz: 'Toshkentda kuz',
      titleEn: 'Autumn in Tashkent',
      subtitleRu: 'Слои, шерсть и спокойная палитра от локальных брендов',
      subtitleUz: 'Mahalliy brendlardan qatlamlar, jun va xotirjam ranglar',
      ctaLabelRu: 'Смотреть коллекцию',
      ctaLabelUz: 'To‘plamni ko‘rish',
      ctaHref: '/collection/winter-layers',
      imageUrl: hero.url,
      config: {},
      sortOrder: 0,
    },
    {
      key: 'home-ai',
      kind: 'AI_PROMPT' as const,
      titleRu: 'AI‑стилист соберёт образ',
      titleUz: 'AI stilist uslub yig‘ib beradi',
      titleEn: 'The AI stylist builds a look',
      subtitleRu: 'Опишите повод и бюджет — подберём вещи из наличия у разных брендов',
      subtitleUz: 'Tadbir va byudjetni yozing — turli brendlardan mavjud buyumlarni tanlaymiz',
      ctaLabelRu: 'Собрать образ',
      ctaLabelUz: 'Uslub yig‘ish',
      ctaHref: '/stylist',
      config: {},
      sortOrder: 1,
    },
    {
      key: 'home-categories',
      kind: 'CATEGORY_GRID' as const,
      titleRu: 'Категории',
      titleUz: 'Kategoriyalar',
      titleEn: 'Categories',
      config: {},
      sortOrder: 2,
    },
    {
      key: 'home-office',
      kind: 'PRODUCT_RAIL' as const,
      titleRu: 'База для офиса',
      titleUz: 'Ofis uchun asos',
      titleEn: 'Office essentials',
      subtitleRu: 'Костюмная классика, которая сочетается между собой',
      subtitleUz: 'Bir-biriga mos keladigan kostyum klassikasi',
      ctaLabelRu: 'Вся коллекция',
      ctaLabelUz: 'Butun to‘plam',
      ctaHref: '/collection/office-essentials',
      config: { collectionSlug: 'office-essentials', limit: 12 },
      sortOrder: 3,
    },
    {
      key: 'home-looks',
      kind: 'LOOK_RAIL' as const,
      titleRu: 'Готовые образы',
      titleUz: 'Tayyor uslublar',
      titleEn: 'Styled looks',
      subtitleRu: 'Собрано стилистами — можно добавить целиком',
      subtitleUz: 'Stilistlar yig‘gan — to‘liq qo‘shish mumkin',
      config: { limit: 8 },
      sortOrder: 4,
    },
    {
      key: 'home-craft',
      kind: 'PRODUCT_RAIL' as const,
      titleRu: 'Узбекское ремесло',
      titleUz: 'O‘zbek hunarmandchiligi',
      titleEn: 'Uzbek craft',
      subtitleRu: 'Адрас и атлас ручного ткачества',
      subtitleUz: 'Qo‘lda to‘qilgan adras va atlas',
      ctaHref: '/collection/uzbek-craft',
      config: { collectionSlug: 'uzbek-craft', limit: 10 },
      sortOrder: 5,
    },
    {
      key: 'home-brands',
      kind: 'BRAND_RAIL' as const,
      titleRu: 'Бренды Ташкента',
      titleUz: 'Toshkent brendlari',
      titleEn: 'Tashkent brands',
      config: { limit: 12 },
      sortOrder: 6,
    },
    {
      key: 'home-sale',
      kind: 'SALE_RAIL' as const,
      titleRu: 'Со скидкой',
      titleUz: 'Chegirmada',
      titleEn: 'On sale',
      config: { limit: 10 },
      sortOrder: 7,
    },
    {
      key: 'home-denim',
      kind: 'PRODUCT_RAIL' as const,
      titleRu: 'Повседневный деним',
      titleUz: 'Kundalik denim',
      titleEn: 'Everyday denim',
      ctaHref: '/collection/everyday-denim',
      config: { collectionSlug: 'everyday-denim', limit: 10 },
      sortOrder: 8,
    },
  ];

  for (const block of blocks) {
    await prisma.cmsBlock.upsert({
      where: { key: block.key },
      create: {
        key: block.key,
        kind: block.kind,
        titleRu: block.titleRu ?? null,
        titleUz: block.titleUz ?? null,
        titleEn: block.titleEn ?? null,
        subtitleRu: block.subtitleRu ?? null,
        subtitleUz: block.subtitleUz ?? null,
        ctaLabelRu: block.ctaLabelRu ?? null,
        ctaLabelUz: block.ctaLabelUz ?? null,
        ctaHref: block.ctaHref ?? null,
        imageUrl: block.imageUrl ?? null,
        config: block.config as Prisma.InputJsonValue,
        sortOrder: block.sortOrder,
        isActive: true,
        locales: ['ru', 'uz', 'en'],
      },
      update: {
        titleRu: block.titleRu ?? null,
        titleUz: block.titleUz ?? null,
        subtitleRu: block.subtitleRu ?? null,
        subtitleUz: block.subtitleUz ?? null,
        ctaHref: block.ctaHref ?? null,
        imageUrl: block.imageUrl ?? null,
        config: block.config as Prisma.InputJsonValue,
        sortOrder: block.sortOrder,
        isActive: true,
        locales: ['ru', 'uz', 'en'],
      },
    });
  }
  console.log(`  CMS blocks: ${blocks.length}`);
}

// ──────────────────────────────────────── legal and FAQ pages (§15.1)

async function seedContentPages() {
  const pages: Array<{ slug: string; locale: 'ru' | 'uz' | 'en'; title: string; kind: string; body: string }> = [
    {
      slug: 'terms',
      locale: 'ru',
      title: 'Условия использования',
      kind: 'LEGAL',
      body: [
        '# Условия использования',
        '',
        '_Версия 2026-09-01. Документ подлежит проверке локальным юристом до коммерческого запуска (§15.1)._',
        '',
        '## 1. Роль платформы',
        'Платформа является оператором электронной торговой площадки и организует взаимодействие покупателя и продавца. Продавцом товара является организация, указанная в карточке товара и в заказе.',
        '',
        '## 2. Заказ и оплата',
        'Итоговая сумма, состав заказа, продавцы, условия доставки и возврата отображаются до подтверждения оплаты. Сумма рассчитывается на стороне платформы и фиксируется в заказе.',
        '',
        '## 3. Комиссия платформы',
        'Платформа получает вознаграждение от продавца в размере 10% от фактически оплаченной стоимости товара. На цену для покупателя это не влияет.',
        '',
        '## 4. Доставка',
        'Срок доставки указывается диапазоном и складывается из времени сборки продавцом и времени доставки по вашей зоне.',
        '',
        '## 5. Возврат',
        'Условия и срок возврата отображаются до оплаты и сохраняются в заказе. Возврат средств выполняется тем же способом, которым была произведена оплата.',
        '',
        '## 6. Рекомендации размера и AI',
        'Рекомендация размера и подбор образа являются информационным сервисом и не являются гарантией посадки.',
      ].join('\n'),
    },
    {
      slug: 'terms',
      locale: 'uz',
      title: 'Foydalanish shartlari',
      kind: 'LEGAL',
      body: [
        '# Foydalanish shartlari',
        '',
        '_2026-09-01 versiyasi. Tijoriy ishga tushirishdan oldin mahalliy yurist tekshirishi shart (§15.1)._',
        '',
        '## 1. Platformaning roli',
        'Platforma elektron savdo maydonchasi operatori bo‘lib, xaridor va sotuvchi o‘rtasidagi munosabatni tashkil qiladi. Mahsulot sotuvchisi mahsulot kartasida va buyurtmada ko‘rsatilgan tashkilotdir.',
        '',
        '## 2. Buyurtma va to‘lov',
        'Yakuniy summa, buyurtma tarkibi, sotuvchilar, yetkazish va qaytarish shartlari to‘lovni tasdiqlashdan oldin ko‘rsatiladi.',
        '',
        '## 3. Platforma komissiyasi',
        'Platforma sotuvchidan mahsulotning haqiqatda to‘langan qiymatining 10% miqdorida mukofot oladi. Bu xaridor uchun narxga ta’sir qilmaydi.',
        '',
        '## 4. Yetkazib berish',
        'Yetkazish muddati oraliq bilan ko‘rsatiladi: sotuvchining yig‘ish vaqti va zonangiz bo‘yicha yetkazish vaqti.',
        '',
        '## 5. Qaytarish',
        'Qaytarish shartlari va muddati to‘lovdan oldin ko‘rsatiladi va buyurtmada saqlanadi. Pul to‘lov qilingan usulda qaytariladi.',
        '',
        '## 6. O‘lcham tavsiyasi va AI',
        'O‘lcham tavsiyasi va uslub tanlash informatsion xizmat bo‘lib, o‘tirish kafolati emas.',
      ].join('\n'),
    },
    {
      slug: 'privacy',
      locale: 'ru',
      title: 'Политика конфиденциальности',
      kind: 'LEGAL',
      body: [
        '# Политика конфиденциальности',
        '',
        '_Версия 2026-09-01. Обработка персональных данных регулируется Законом O‘RQ‑547; документ требует проверки юристом (§15.2)._',
        '',
        '## Какие данные мы обрабатываем',
        '- Идентификатор Telegram, имя и язык интерфейса — для входа и локализации.',
        '- Телефон и адрес — только для доставки заказа.',
        '- Параметры фигуры и привычные размеры — добровольно, только для рекомендации размера.',
        '- История заказов — для исполнения заказа, возвратов и обязательного хранения.',
        '',
        '## Чего мы не делаем',
        '- Не храним данные банковской карты.',
        '- Не используем фотографии лица для идентификации, оценки эмоций или этничности.',
        '- Не передаём телефон и адрес в аналитические системы.',
        '',
        '## Ваши права',
        'В разделе «Приватность» можно выключить персонализацию, удалить профиль фигуры, скачать копию данных и удалить аккаунт. Заказы и бухгалтерские записи сохраняются в объёме обязательного хранения.',
      ].join('\n'),
    },
    {
      slug: 'privacy',
      locale: 'uz',
      title: 'Maxfiylik siyosati',
      kind: 'LEGAL',
      body: [
        '# Maxfiylik siyosati',
        '',
        '_2026-09-01 versiyasi. Shaxsiy ma’lumotlarni qayta ishlash O‘RQ‑547 qonuni bilan tartibga solinadi; hujjat yurist tekshiruvini talab qiladi (§15.2)._',
        '',
        '## Qanday ma’lumotlarni qayta ishlaymiz',
        '- Telegram identifikatori, ism va interfeys tili — kirish va lokalizatsiya uchun.',
        '- Telefon va manzil — faqat buyurtmani yetkazish uchun.',
        '- Tana parametrlari va odatdagi o‘lchamlar — ixtiyoriy, faqat o‘lcham tavsiyasi uchun.',
        '- Buyurtmalar tarixi — buyurtmani bajarish, qaytarish va majburiy saqlash uchun.',
        '',
        '## Nima qilmaymiz',
        '- Bank kartasi ma’lumotlarini saqlamaymiz.',
        '- Yuz suratlarini identifikatsiya, hissiyot yoki etnik baholash uchun ishlatmaymiz.',
        '- Telefon va manzilni analitika tizimlariga uzatmaymiz.',
        '',
        '## Sizning huquqlaringiz',
        '«Maxfiylik» bo‘limida personalizatsiyani o‘chirish, tana profilini o‘chirish, ma’lumot nusxasini yuklab olish va akkauntni o‘chirish mumkin.',
      ].join('\n'),
    },
    {
      slug: 'delivery',
      locale: 'ru',
      title: 'Доставка и оплата',
      kind: 'PAGE',
      body: [
        '# Доставка и оплата',
        '',
        '## Сроки',
        'Срок доставки = время сборки продавцом + доставка курьером по вашей зоне. Мы показываем диапазон, а не одну дату: так честнее.',
        '',
        '## Зоны и стоимость',
        '- Ташкент, центр — 25 000 сум, 1–2 дня. Бесплатно от 1 500 000 сум.',
        '- Ташкент, окраины — 35 000 сум, 1–3 дня. Бесплатно от 2 000 000 сум.',
        '- Ташкентская область — 55 000 сум, 2–5 дней.',
        '- Самовывоз из шоурума — бесплатно.',
        '',
        '## Несколько посылок',
        'Если в корзине вещи разных брендов, оплата одна, но каждый продавец отправляет свою часть отдельно. В заказе видно, какие позиции в какой посылке.',
        '',
        '## Оплата',
        'Платёжные провайдеры подключаются поэтапно. В текущей версии оплата работает в тестовом режиме: карта не списывается, а заказ, доставка и возврат проходят полностью.',
      ].join('\n'),
    },
    {
      slug: 'delivery',
      locale: 'uz',
      title: 'Yetkazib berish va to‘lov',
      kind: 'PAGE',
      body: [
        '# Yetkazib berish va to‘lov',
        '',
        '## Muddatlar',
        'Yetkazish muddati = sotuvchining yig‘ish vaqti + zonangiz bo‘yicha kuryer yetkazishi. Biz bitta sana emas, oraliq ko‘rsatamiz.',
        '',
        '## Zonalar va narx',
        '- Toshkent, markaz — 25 000 so‘m, 1–2 kun. 1 500 000 so‘mdan yuqori — bepul.',
        '- Toshkent, chekka tumanlar — 35 000 so‘m, 1–3 kun. 2 000 000 so‘mdan yuqori — bepul.',
        '- Toshkent viloyati — 55 000 so‘m, 2–5 kun.',
        '- Shoudan olib ketish — bepul.',
        '',
        '## Bir necha paket',
        'Savatda turli brendlar bo‘lsa, to‘lov bitta, lekin har bir sotuvchi o‘z qismini alohida yuboradi.',
        '',
        '## To‘lov',
        'To‘lov provayderlari bosqichma-bosqich ulanadi. Hozirgi versiyada to‘lov sinov rejimida: kartadan pul olinmaydi.',
      ].join('\n'),
    },
    {
      slug: 'returns',
      locale: 'ru',
      title: 'Возврат',
      kind: 'PAGE',
      body: [
        '# Возврат',
        '',
        '## Срок',
        '14 дней с момента доставки, если в карточке товара не указано иное. Условия, действовавшие на момент покупки, сохраняются в заказе.',
        '',
        '## Как оформить',
        '1. Откройте заказ и нажмите «Возврат».',
        '2. Отметьте позиции, количество и причину.',
        '3. Мы покажем сумму возврата до подтверждения.',
        '4. Передайте товар курьеру или в шоурум.',
        '',
        '## Деньги',
        'После проверки продавцом средства возвращаются тем же способом, которым была произведена оплата.',
        '',
        '## Что нельзя вернуть',
        'Товары с нарушенной гигиенической упаковкой и изделия, изготовленные по индивидуальным меркам.',
      ].join('\n'),
    },
    {
      slug: 'returns',
      locale: 'uz',
      title: 'Qaytarish',
      kind: 'PAGE',
      body: [
        '# Qaytarish',
        '',
        '## Muddat',
        'Yetkazilgandan keyin 14 kun, agar mahsulot kartasida boshqacha ko‘rsatilmagan bo‘lsa.',
        '',
        '## Qanday rasmiylashtirish',
        '1. Buyurtmani ochib «Qaytarish»ni bosing.',
        '2. Buyumlar, miqdor va sababni belgilang.',
        '3. Tasdiqlashdan oldin qaytarish summasini ko‘rsatamiz.',
        '4. Mahsulotni kuryerga yoki shouga topshiring.',
        '',
        '## Pul',
        'Sotuvchi tekshirgandan so‘ng pul to‘lov qilingan usulda qaytariladi.',
      ].join('\n'),
    },
  ];

  for (const page of pages) {
    await prisma.contentPage.upsert({
      where: { slug_locale: { slug: page.slug, locale: page.locale } },
      create: { ...page, locale: page.locale as never, isPublished: true, publishedAt: new Date() },
      update: { title: page.title, body: page.body, isPublished: true },
    });
  }
  console.log(`  content pages: ${pages.length}`);
}

// ─────────────────────────────────────────── promotions (ORD-008/PAY-015)

async function seedPromotions(products: Array<{ id: string; externalId: string }>) {
  const byExternal = new Map(products.map((product) => [product.externalId, product.id]));

  // A seller-funded discount: it lowers the commission base (UAT-12).
  const sellerFunded = await prisma.promotion.upsert({
    where: { code: 'AUTUMN10' },
    create: {
      code: 'AUTUMN10',
      nameRu: 'Осенняя скидка 10% от продавца',
      nameUz: 'Sotuvchidan 10% kuzgi chegirma',
      kind: 'PERCENT',
      valueBps: 1000,
      funding: 'SELLER',
      sellerSharePercent: 100,
      minOrderMinor: uzs(500_000),
      maxDiscountMinor: uzs(400_000),
      startsAt: new Date('2026-09-01T00:00:00Z'),
      endsAt: new Date('2026-12-31T23:59:59Z'),
      requiresCode: true,
      usageLimit: 2000,
      isActive: true,
    },
    update: { isActive: true },
  });

  // A platform-funded discount: it is a subsidy and is recorded separately,
  // so the effective take rate is explainable (UAT-13).
  const platformFunded = await prisma.promotion.upsert({
    where: { code: 'WELCOME50K' },
    create: {
      code: 'WELCOME50K',
      nameRu: 'Приветственная скидка платформы 50 000 сум',
      nameUz: 'Platformadan 50 000 so‘m xush kelibsiz chegirmasi',
      kind: 'FIXED',
      valueMinor: uzs(50_000),
      funding: 'PLATFORM',
      sellerSharePercent: 0,
      minOrderMinor: uzs(700_000),
      startsAt: new Date('2026-09-01T00:00:00Z'),
      endsAt: new Date('2026-12-31T23:59:59Z'),
      requiresCode: true,
      perUserLimit: 1,
      isActive: true,
    },
    update: { isActive: true },
  });

  // An automatic markdown on two SKUs, so the sale rail has real content.
  const autoDiscount = await prisma.promotion.upsert({
    where: { code: 'MARKDOWN-FW26' },
    create: {
      code: 'MARKDOWN-FW26',
      nameRu: 'Сезонная уценка FW26',
      nameUz: 'FW26 mavsumiy chegirma',
      kind: 'PERCENT',
      valueBps: 1500,
      funding: 'SELLER',
      sellerSharePercent: 100,
      startsAt: new Date('2026-09-01T00:00:00Z'),
      endsAt: new Date('2026-12-31T23:59:59Z'),
      requiresCode: false,
      isActive: true,
    },
    update: { isActive: true },
  });

  for (const externalId of ['CH-BLZ-002', 'YS-SNK-002', 'MD-JNS-002']) {
    const productId = byExternal.get(externalId);
    if (!productId) continue;
    const skus = await prisma.sku.findMany({ where: { productId }, select: { id: true } });
    for (const sku of skus) {
      await prisma.promotionSku.upsert({
        where: { promotionId_skuId: { promotionId: autoDiscount.id, skuId: sku.id } },
        create: { promotionId: autoDiscount.id, skuId: sku.id },
        update: {},
      });
    }
  }

  console.log(
    `  promotions: ${[sellerFunded.code, platformFunded.code, autoDiscount.code].join(', ')} (seller-funded, platform-funded, automatic)`,
  );
}

// ──────────────────────────────────── admin users and roles (ADM-001/002)

async function seedAdminUsers() {
  const users: Array<{ email: string; name: string; password: string; roles: string[] }> = [
    { email: 'super@fashion.uz', name: 'Platform Owner', password: 'Platform!Admin2026', roles: ['SUPER_ADMIN'] },
    { email: 'catalog@fashion.uz', name: 'Catalog Manager', password: 'Catalog!Admin2026', roles: ['CATALOG_MANAGER'] },
    { email: 'orders@fashion.uz', name: 'Order Manager', password: 'Orders!Admin2026', roles: ['ORDER_MANAGER'] },
    { email: 'finance@fashion.uz', name: 'Finance Operator', password: 'Finance!Admin2026', roles: ['FINANCE_OPERATOR'] },
    {
      // ADM-005 needs two finance operators: the maker may not be the checker.
      email: 'finance2@fashion.uz',
      name: 'Finance Approver',
      password: 'Finance!Admin2026',
      roles: ['FINANCE_OPERATOR'],
    },
    { email: 'content@fashion.uz', name: 'Content Manager', password: 'Content!Admin2026', roles: ['CONTENT_MANAGER'] },
    { email: 'ai@fashion.uz', name: 'AI Merchandiser', password: 'AiMerch!Admin2026', roles: ['AI_MERCHANDISER'] },
    { email: 'support@fashion.uz', name: 'Support Agent', password: 'Support!Admin2026', roles: ['SUPPORT_AGENT'] },
  ];

  for (const user of users) {
    await prisma.adminUser.upsert({
      where: { email: user.email },
      create: {
        email: user.email,
        name: user.name,
        passwordHash: await hashPassword(user.password),
        roles: user.roles as never,
      },
      update: { roles: user.roles as never, name: user.name },
    });
  }
  console.log(`  admin users: ${users.length} (MFA enrols on first login for the roles that require it)`);
}

// ──────────────────────────────────── AI evaluation set (§6.3, §18.1)

async function seedAiEvaluation() {
  const cases = [
    {
      code: 'UAT-04-old-money-office',
      query: 'Собери old money образ для офиса до 4 000 000 сум',
      locale: 'ru' as const,
      expectation: {
        styles: ['old_money'],
        occasions: ['office'],
        budgetMajor: 4_000_000,
        requiredSlots: ['TOP', 'BOTTOM', 'FOOTWEAR'],
        mustBeWithinBudget: true,
        mustBeInStock: true,
        note: 'The spec\'s own example brief (§01 key idea, UAT-04).',
      },
    },
    {
      code: 'UAT-05-replace-shoes',
      query: 'Замени обувь в образе на что-то более повседневное',
      locale: 'ru' as const,
      expectation: {
        action: 'replace',
        slot: 'FOOTWEAR',
        preserveStyles: true,
        preserveBudget: true,
        note: 'UAT-05: replacing shoes keeps the style and budget or warns explicitly.',
      },
    },
    {
      code: 'uz-winter-no-red',
      query: 'Qish uchun issiq to‘plam, qizil rang bo‘lmasin',
      locale: 'uz' as const,
      expectation: {
        season: 'WINTER',
        avoidColors: ['red'],
        minWarmth: 3,
        note: 'Uzbek-language brief with a negated colour constraint.',
      },
    },
    {
      code: 'evening-wedding-budget',
      query: 'Вечерний образ на свадьбу до 6 млн',
      locale: 'ru' as const,
      expectation: {
        occasions: ['wedding_guest', 'evening_out'],
        budgetMajor: 6_000_000,
        minFormality: 4,
        note: 'Formality floor: no sportswear may appear in an evening look (AI-004 hard rule).',
      },
    },
    {
      code: 'budget-too-low',
      query: 'Полный образ до 200 000 сум',
      locale: 'ru' as const,
      expectation: {
        expectFailure: true,
        failureCode: 'BUDGET_TOO_LOW',
        note: 'AI-002: refusing honestly beats inventing or offering out-of-stock items.',
      },
    },
    {
      code: 'sport-gym',
      query: 'Спортивный комплект для зала',
      locale: 'ru' as const,
      expectation: {
        styles: ['sporty', 'athleisure'],
        occasions: ['sport'],
        maxFormality: 2,
        note: 'The opposite end of the formality scale from the office brief.',
      },
    },
    {
      code: 'minimal-beige-everyday',
      query: 'Повседневный минимализм на каждый день, бежевая гамма',
      locale: 'ru' as const,
      expectation: {
        styles: ['minimal'],
        preferredColors: ['beige', 'cream', 'camel'],
        note: 'Colour-led brief: the palette should dominate the selection.',
      },
    },
    {
      code: 'uz-office-budget',
      query: 'Ofis uchun old money uslubida kiyim, 4 mln so‘mgacha',
      locale: 'uz' as const,
      expectation: {
        styles: ['old_money'],
        occasions: ['office'],
        budgetMajor: 4_000_000,
        mustBeWithinBudget: true,
        note: 'The same brief as UAT-04 in Uzbek: the parser must reach the same intent.',
      },
    },
  ];

  for (const entry of cases) {
    await prisma.aiEvaluationCase.upsert({
      where: { code: entry.code },
      create: {
        code: entry.code,
        query: entry.query,
        locale: entry.locale,
        expectation: entry.expectation as Prisma.InputJsonValue,
        notes: entry.expectation.note,
        isActive: true,
      },
      update: { query: entry.query, expectation: entry.expectation as Prisma.InputJsonValue },
    });
  }
  console.log(`  AI evaluation cases: ${cases.length}`);
}

// ──────────────────────────── feature flags, settings and the decision log

async function seedPlatformConfig() {
  const flags = [
    { key: 'ai_stylist', enabled: true, rolloutPercent: 100, description: 'AI stylist in the Mini App' },
    { key: 'ai_llm_narrative', enabled: true, rolloutPercent: 100, description: 'LLM-worded explanation (falls back to rules)' },
    { key: 'reviews', enabled: true, rolloutPercent: 100, description: 'Product reviews with moderation' },
    { key: 'photo_body_measurement', enabled: false, rolloutPercent: 0, description: 'FIT-007 / D-10: blocked until DPIA and legal review' },
    { key: 'marketing_push', enabled: false, rolloutPercent: 0, description: 'NTF-002: off until the consent flow is signed off' },
    { key: 'seller_cabinet', enabled: true, rolloutPercent: 100, description: 'Seller cabinet (§11)' },
  ];

  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      create: flag,
      update: { enabled: flag.enabled, rolloutPercent: flag.rolloutPercent, description: flag.description },
    });
  }

  /**
   * §19.2 Decision Log. These are the decisions the spec requires before build
   * freeze; storing them as settings means the admin panel can show what is
   * still open rather than leaving it in a document nobody opens.
   */
  const decisions: Array<{ key: string; value: unknown; description: string }> = [
    { key: 'decision.D-01.legal_role', value: { status: 'OPEN', note: 'Merchant of record and legal qualification of the platform' }, description: 'D-01 — before payment design freeze' },
    { key: 'decision.D-02.fiscal_issuer', value: { status: 'OPEN', note: 'Seller on the receipt and fiscal issuer' }, description: 'D-02 — before PSP onboarding' },
    { key: 'decision.D-03.commission_base', value: { status: 'DECIDED', note: '10% of paid goods value after seller-funded discount, delivery excluded; PSP fee borne by the platform' }, description: 'D-03 — before ledger implementation' },
    { key: 'decision.D-04.settlement_mode', value: { status: 'OPEN', note: 'Native split vs platform settlement per PSP; CLICK Split Shop availability unconfirmed' }, description: 'D-04 — before contracts' },
    { key: 'decision.D-05.payout_schedule', value: { status: 'DECIDED', note: 'Weekly payout, per-seller return reserve in basis points' }, description: 'D-05 — before seller contract' },
    { key: 'decision.D-06.fulfillment', value: { status: 'DECIDED', note: 'Seller-fulfilled with one buyer-facing order' }, description: 'D-06 — before seller onboarding' },
    { key: 'decision.D-07.return_window', value: { status: 'DECIDED', note: '14 days from delivery; buyer pays return shipping except for defects' }, description: 'D-07 — before the public offer' },
    { key: 'decision.D-08.pilot_brands', value: { status: 'DECIDED', note: 'Six Tashkent sellers across tailoring, craft, knitwear, denim, footwear and sport' }, description: 'D-08 — before migration' },
    { key: 'decision.D-09.locales', value: { status: 'DECIDED', note: 'RU and UZ Latin required; EN ships once content is complete' }, description: 'D-09 — before content production' },
    { key: 'decision.D-10.photo_measurement', value: { status: 'OPEN', note: 'Out of scope until a DPIA and legal classification exist' }, description: 'D-10 — before privacy architecture' },
    { key: 'decision.D-11.minors', value: { status: 'OPEN', note: 'Age model and parental consent' }, description: 'D-11 — before onboarding copy' },
    { key: 'decision.D-12.delivery_partner', value: { status: 'DECIDED', note: 'Seller courier with platform zones and SLA; third-party carrier in Phase 2' }, description: 'D-12 — before UAT' },
    { key: 'decision.D-13.kpi_targets', value: { status: 'OPEN', note: 'Targets set after the pilot baseline; the spec deliberately fixes none' }, description: 'D-13 — before performance testing' },
    { key: 'decision.D-14.product_identity', value: { status: 'OPEN', note: 'Product name, domain and bot username' }, description: 'D-14 — before public beta' },
  ];

  for (const decision of decisions) {
    await prisma.platformSetting.upsert({
      where: { key: decision.key },
      create: { key: decision.key, value: decision.value as Prisma.InputJsonValue, description: decision.description },
      update: { value: decision.value as Prisma.InputJsonValue, description: decision.description },
    });
  }

  await prisma.platformSetting.upsert({
    where: { key: 'payments.live' },
    create: {
      key: 'payments.live',
      value: {
        live: false,
        reason:
          'No PSP contract or certification yet, and decisions D-01, D-02 and D-04 are open. The sandbox provider exercises commission, ledger, refunds and payouts end to end.',
      } as Prisma.InputJsonValue,
      description: '§8.4 release gate for real payments',
    },
    update: {},
  });

  // ANL-003: one experiment, defined but not started, to show the shape.
  await prisma.experiment.upsert({
    where: { key: 'stylist-entry-point' },
    create: {
      key: 'stylist-entry-point',
      name: 'Stylist entry point on home',
      hypothesis:
        'Putting the stylist prompt above the category grid increases AI sessions per visitor without reducing catalogue browsing.',
      variants: [
        { key: 'control', description: 'Prompt below the category grid' },
        { key: 'treatment', description: 'Prompt directly under the hero' },
      ] as Prisma.InputJsonValue,
      metrics: {
        primary: 'ai_session_started per visitor',
        secondary: ['product_view per visitor', 'add_to_cart rate'],
      } as Prisma.InputJsonValue,
      guardrails: { minProductViewsPerVisitor: 2.0, maxCheckoutDropPercent: 2 } as Prisma.InputJsonValue,
      stopCriteria: 'Stop if the guardrail on product views per visitor is breached for three consecutive days.',
      status: 'DRAFT',
    },
    update: {},
  });

  console.log(`  feature flags: ${flags.length}, decision log: ${decisions.length}, experiments: 1`);
}

// ──────────────────────────────────────────────────────────────── helpers

async function summary() {
  const [
    sellers,
    brands,
    categories,
    products,
    skus,
    stock,
    charts,
    media,
    collections,
    looks,
    cms,
    pages,
    admins,
    flags,
    evalCases,
  ] = await Promise.all([
    prisma.seller.count(),
    prisma.brand.count(),
    prisma.category.count(),
    prisma.product.count({ where: { lifecycle: 'PUBLISHED' } }),
    prisma.sku.count(),
    prisma.inventory.aggregate({ _sum: { onHand: true } }),
    prisma.sizeChart.count(),
    prisma.media.count(),
    prisma.collection.count(),
    prisma.curatedOutfit.count(),
    prisma.cmsBlock.count(),
    prisma.contentPage.count(),
    prisma.adminUser.count(),
    prisma.featureFlag.count(),
    prisma.aiEvaluationCase.count(),
  ]);

  return [
    { entity: 'sellers', count: sellers },
    { entity: 'brands', count: brands },
    { entity: 'categories', count: categories },
    { entity: 'published products', count: products },
    { entity: 'SKUs', count: skus },
    { entity: 'units in stock', count: stock._sum.onHand ?? 0 },
    { entity: 'size charts', count: charts },
    { entity: 'media files', count: media },
    { entity: 'collections', count: collections },
    { entity: 'curated looks', count: looks },
    { entity: 'CMS blocks', count: cms },
    { entity: 'content pages', count: pages },
    { entity: 'admin users', count: admins },
    { entity: 'feature flags', count: flags },
    { entity: 'AI eval cases', count: evalCases },
  ];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function hashCode(value: string): number {
  let out = 0;
  for (const char of value) out = (out * 31 + char.charCodeAt(0)) | 0;
  return out;
}

function estimateWeight(shape: GarmentShape): number {
  switch (shape) {
    case 'coat':
      return 1800;
    case 'blazer':
    case 'suit':
      return 1100;
    case 'boot':
      return 1400;
    case 'sneaker':
    case 'loafer':
    case 'heel':
      return 900;
    case 'bag':
      return 950;
    case 'sweater':
    case 'cardigan':
    case 'hoodie':
      return 650;
    case 'jeans':
    case 'trousers':
      return 700;
    case 'dress':
      return 520;
    case 'shirt':
    case 'blouse':
      return 280;
    case 'tshirt':
      return 220;
    case 'belt':
    case 'scarf':
    case 'cap':
      return 180;
    default:
      return 400;
  }
}

main()
  .catch((error) => {
    console.error('✗ seed failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
