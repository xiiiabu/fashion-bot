/**
 * Bot copy — spec USR-001 (RU / UZ-Latin MUST, EN SHOULD) and §7.2.
 *
 * Order statuses, fit and notification text come from @fashion/core, so the
 * message the bot sends and the screen the shopper then opens say the same
 * thing. Only the bot's own conversational copy lives here.
 *
 * Telegram's HTML parse mode is used, so anything interpolated from data has
 * to go through `escapeHtml` — a product title containing `<` would otherwise
 * break the message or, worse, be interpreted.
 */

import type { Locale } from '@fashion/core';

type Dict = Record<string, string>;

const ru: Dict = {
  'start.greeting': '<b>Atlas</b> — бренды Ташкента в одном месте.',
  'start.lead':
    'Один каталог, один заказ на все бренды и AI-стилист, который собирает образ только из того, что есть в наличии.',
  'start.openApp': 'Открыть магазин',
  'start.pickLanguage': 'Выберите язык / Tilni tanlang / Choose a language',
  'start.welcomeBack': 'С возвращением, {name}.',

  'menu.catalog': 'Каталог',
  'menu.stylist': 'AI-стилист',
  'menu.orders': 'Мои заказы',
  'menu.brands': 'Бренды',
  'menu.help': 'Помощь',
  'menu.language': 'Язык',
  'menu.settings': 'Настройки',

  'cmd.help': 'Что я умею',
  'cmd.helpBody':
    'Я открываю магазин прямо в Telegram и присылаю уведомления о заказах.\n\n' +
    '<b>/start</b> — главное меню\n' +
    '<b>/shop</b> — открыть каталог\n' +
    '<b>/stylist</b> — собрать образ\n' +
    '<b>/orders</b> — мои заказы\n' +
    '<b>/help</b> — частые вопросы\n' +
    '<b>/language</b> — сменить язык\n' +
    '<b>/stop</b> — отключить уведомления',

  'stylist.prompt':
    'Опишите повод, бюджет и настроение — например: «образ на свадьбу до 3 000 000 сум».\n\nИли откройте стилиста в приложении:',
  'stylist.open': 'Открыть стилиста',
  'stylist.examples': 'Примеры запросов:',

  'catalog.pick': 'Выберите категорию:',
  'catalog.all': 'Весь каталог',
  'brands.pick': 'Выберите бренд:',
  'brands.all': 'Все бренды',

  'orders.none': 'Заказов пока нет. Загляните в каталог — там есть на что посмотреть.',
  'orders.recent': 'Ваши последние заказы:',
  'orders.open': 'Открыть заказ',

  'help.title': 'Частые вопросы',
  'help.escalation': 'Не нашли ответ? Напишите нам прямо здесь — ответит живой человек.',
  'help.contact': 'Написать в поддержку',
  'help.received':
    'Спасибо, передали в поддержку. Ответим в этом чате — обычно в течение рабочего дня.',

  'language.changed': 'Язык изменён на русский.',
  'language.pick': 'Выберите язык:',

  'notify.stopped':
    'Уведомления отключены. Вы по-прежнему можете открыть магазин командой /shop, а включить обратно — /start.',
  'notify.resumed': 'Уведомления снова включены.',

  'error.generic': 'Что-то пошло не так. Попробуйте ещё раз через минуту.',
  'error.noApp':
    'Магазин пока не настроен. Попробуйте позже — мы уже этим занимаемся.',
  'error.unknownCommand': 'Не знаю такой команды. Попробуйте /start.',

  'common.back': '← Назад',
  'common.openApp': 'Открыть приложение',
};

const uz: Dict = {
  'start.greeting': '<b>Atlas</b> — Toshkent brendlari bir joyda.',
  'start.lead':
    'Bitta katalog, barcha brendlarga bitta buyurtma va faqat mavjud mahsulotlardan uslub yigʻadigan AI-stilist.',
  'start.openApp': 'Doʻkonni ochish',
  'start.pickLanguage': 'Выберите язык / Tilni tanlang / Choose a language',
  'start.welcomeBack': 'Qaytganingiz bilan, {name}.',

  'menu.catalog': 'Katalog',
  'menu.stylist': 'AI-stilist',
  'menu.orders': 'Buyurtmalarim',
  'menu.brands': 'Brendlar',
  'menu.help': 'Yordam',
  'menu.language': 'Til',
  'menu.settings': 'Sozlamalar',

  'cmd.help': 'Nima qila olaman',
  'cmd.helpBody':
    'Men doʻkonni toʻgʻridan-toʻgʻri Telegramda ochaman va buyurtmalar haqida xabar beraman.\n\n' +
    '<b>/start</b> — asosiy menyu\n' +
    '<b>/shop</b> — katalogni ochish\n' +
    '<b>/stylist</b> — uslub yigʻish\n' +
    '<b>/orders</b> — buyurtmalarim\n' +
    '<b>/help</b> — koʻp beriladigan savollar\n' +
    '<b>/language</b> — tilni almashtirish\n' +
    '<b>/stop</b> — xabarnomalarni oʻchirish',

  'stylist.prompt':
    'Tadbir, budjet va kayfiyatni yozing — masalan: «toʻyga 3 000 000 soʻmgacha uslub».\n\nYoki stilistni ilovada oching:',
  'stylist.open': 'Stilistni ochish',
  'stylist.examples': 'Soʻrov namunalari:',

  'catalog.pick': 'Kategoriyani tanlang:',
  'catalog.all': 'Butun katalog',
  'brands.pick': 'Brendni tanlang:',
  'brands.all': 'Barcha brendlar',

  'orders.none': 'Hozircha buyurtma yoʻq. Katalogga qarang — koʻradigan narsa bor.',
  'orders.recent': 'Oxirgi buyurtmalaringiz:',
  'orders.open': 'Buyurtmani ochish',

  'help.title': 'Koʻp beriladigan savollar',
  'help.escalation': 'Javob topilmadimi? Shu yerga yozing — jonli odam javob beradi.',
  'help.contact': 'Yordamga yozish',
  'help.received':
    'Rahmat, yordam xizmatiga uzatdik. Shu chatda javob beramiz — odatda ish kuni ichida.',

  'language.changed': 'Til oʻzbekchaga oʻzgartirildi.',
  'language.pick': 'Tilni tanlang:',

  'notify.stopped':
    'Xabarnomalar oʻchirildi. Doʻkonni /shop buyrugʻi bilan ochishingiz, qayta yoqish uchun /start yozishingiz mumkin.',
  'notify.resumed': 'Xabarnomalar yana yoqildi.',

  'error.generic': 'Nimadir xato ketdi. Bir daqiqadan soʻng qayta urinib koʻring.',
  'error.noApp': 'Doʻkon hali sozlanmagan. Keyinroq urinib koʻring — ustida ishlayapmiz.',
  'error.unknownCommand': 'Bunday buyruqni bilmayman. /start ni sinab koʻring.',

  'common.back': '← Orqaga',
  'common.openApp': 'Ilovani ochish',
};

const en: Dict = {
  'start.greeting': '<b>Atlas</b> — Tashkent brands in one place.',
  'start.lead':
    'One catalogue, one order across every brand, and an AI stylist that builds a look only from what is actually in stock.',
  'start.openApp': 'Open the shop',
  'start.pickLanguage': 'Выберите язык / Tilni tanlang / Choose a language',
  'start.welcomeBack': 'Welcome back, {name}.',

  'menu.catalog': 'Catalogue',
  'menu.stylist': 'AI stylist',
  'menu.orders': 'My orders',
  'menu.brands': 'Brands',
  'menu.help': 'Help',
  'menu.language': 'Language',
  'menu.settings': 'Settings',

  'cmd.help': 'What I can do',
  'cmd.helpBody':
    'I open the shop right inside Telegram and send you order updates.\n\n' +
    '<b>/start</b> — main menu\n' +
    '<b>/shop</b> — open the catalogue\n' +
    '<b>/stylist</b> — build a look\n' +
    '<b>/orders</b> — my orders\n' +
    '<b>/help</b> — frequently asked questions\n' +
    '<b>/language</b> — change language\n' +
    '<b>/stop</b> — turn notifications off',

  'stylist.prompt':
    'Describe the occasion, the budget and the mood — for example: “a wedding look under 3 000 000 soum”.\n\nOr open the stylist in the app:',
  'stylist.open': 'Open the stylist',
  'stylist.examples': 'Example briefs:',

  'catalog.pick': 'Choose a category:',
  'catalog.all': 'The whole catalogue',
  'brands.pick': 'Choose a brand:',
  'brands.all': 'All brands',

  'orders.none': 'No orders yet. Have a look at the catalogue — there is plenty to see.',
  'orders.recent': 'Your most recent orders:',
  'orders.open': 'Open the order',

  'help.title': 'Frequently asked questions',
  'help.escalation': 'Not answered here? Write to us right in this chat — a person will reply.',
  'help.contact': 'Message support',
  'help.received':
    'Thank you, passed to support. We will reply in this chat, usually within the working day.',

  'language.changed': 'Language changed to English.',
  'language.pick': 'Choose a language:',

  'notify.stopped':
    'Notifications are off. You can still open the shop with /shop, and turn them back on with /start.',
  'notify.resumed': 'Notifications are back on.',

  'error.generic': 'Something went wrong. Please try again in a minute.',
  'error.noApp': 'The shop is not configured yet. Please try later — we are on it.',
  'error.unknownCommand': 'I do not know that command. Try /start.',

  'common.back': '← Back',
  'common.openApp': 'Open the app',
};

const DICTS: Record<Locale, Dict> = { ru, uz, en };

export function t(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const template = DICTS[locale]?.[key] ?? DICTS.ru[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** ADM-011: which keys a locale is missing, so the gap is measurable. */
export function missingKeys(locale: Locale): string[] {
  const reference = Object.keys(ru);
  const target = DICTS[locale] ?? {};
  return reference.filter((key) => !(key in target));
}

/**
 * Telegram's HTML parse mode understands a small tag set and rejects a message
 * with stray angle brackets. Everything interpolated from the database — a
 * product title, a brand name, a shopper's own words — goes through this.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
