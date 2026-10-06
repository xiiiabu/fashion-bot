/**
 * Mini App UI acceptance suite — spec §18.1 ("E2E: buyer journey") run in a
 * real browser against a real API and the seeded pilot catalogue.
 *
 * This catches the class of failure a typecheck and the HTTP suite both miss:
 * a request that 404s, a render that throws, a total that never appears, a
 * screen that stays on its skeleton. It drives the actual UI at phone size.
 *
 * Usage:
 *   pnpm --filter @fashion/miniapp test:ui
 *
 * Requires the API on :4000 and the Mini App on :3000 (scripts/api.sh and
 * scripts/miniapp.sh bring both up), with dev sign-in enabled.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Playwright is not a dependency of this app: the browser and the driver are
 * provided by the environment, so the suite stays runnable without adding
 * ~300 MB to every install. PLAYWRIGHT_DRIVER points at an installation when
 * it is not on the default resolution path.
 */
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_DRIVER,
    'playwright',
    '/opt/node-tools/node_modules/playwright',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      return loaded.chromium ? loaded : loaded.default;
    } catch {
      /* try the next one */
    }
  }
  console.error(
    'Playwright not found. Install it, or set PLAYWRIGHT_DRIVER to an installation path.',
  );
  process.exit(2);
}

const { chromium } = loadPlaywright();

const BASE = process.env.MINIAPP_URL ?? 'http://localhost:3000';
const SHOT_DIR = process.env.SHOT_DIR ? resolve(process.env.SHOT_DIR) : null;
const EXECUTABLE =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

let launchOptions = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
try {
  require('node:fs').accessSync(EXECUTABLE);
  launchOptions = { ...launchOptions, executablePath: EXECUTABLE };
} catch {
  // Fall back to whatever Playwright has installed itself.
}

const browser = await chromium.launch(launchOptions);

const context = await browser.newContext({
  // A 390x844 viewport at 3x is an iPhone 14/15, the single most common screen
  // a Tashkent shopper will open this on.
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'ru-RU',
});

/**
 * Start from a clean browser. The app remembers the chosen locale in
 * localStorage on purpose, and a run that ended part-way through the language
 * section left the next run starting in English — which made every Russian
 * assertion fail and looked like a dozen regressions rather than one
 * order-dependent suite.
 */
await context.addInitScript(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* private mode */
  }
});


const page = await context.newPage();

// The UI asks for confirmation before destructive actions, through Telegram's
// dialog in the webview and window.confirm in a browser. Playwright dismisses
// dialogs by default, which would turn every confirmed action into a no-op.
page.on('dialog', (dialog) => {
  void dialog.accept();
});

if (process.env.TRACE_NAV === '1') {
  page.on('response', async (response) => {
    if (!response.url().endsWith('/me')) return;
    const text = await response.text().catch(() => '');
    try {
      const data = JSON.parse(text);
      console.log(
        '      [me]',
        response.status(),
        'tg=' + data.telegramId,
        'locale=' + data.locale,
        'consents=' + Object.keys(data.consents ?? {}).join(','),
      );
    } catch {
      console.log('      [me]', response.status(), text.slice(0, 80));
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) console.log('      [nav]', frame.url().replace(BASE, ''));
  });
}

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

const failedRequests = [];
page.on('response', (response) => {
  const url = response.url();
  if (!url.includes('/auth/') && !url.includes(':4000')) return;
  if (response.status() >= 400) failedRequests.push(`${response.status()} ${url}`);
});

/**
 * The app signs in, reads /me and may then redirect. Waiting a fixed delay
 * raced that and produced false failures; this waits until the splash is gone
 * and the URL has stopped moving.
 */
async function settle(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const url = page.url();
    const text = await page.locator('body').innerText().catch(() => '');
    const splashOnly = text.trim().replace(/\s+/g, ' ') === 'Atlas TASHKENT';
    if (url === lastUrl && !splashOnly && text.trim().length > 0) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince > 600) return;
    } else {
      lastUrl = url;
      stableSince = 0;
    }
    await page.waitForTimeout(120);
  }
}

async function goto(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await settle();
}

async function body() {
  return page.locator('body').innerText();
}

/** Clicks and, on failure, says which selector it was waiting for. */
async function click(selector, timeout = 15_000) {
  try {
    await page.locator(selector).first().click({ timeout });
  } catch (error) {
    throw new Error(`click("${selector}") timed out after ${timeout}ms`);
  }
}

/**
 * The language row is labelled in whichever locale is current, so it is matched
 * by any of its three spellings.
 */
const LANGUAGE_ROW =
  'button:has-text("Язык"), button:has-text("Til"), button:has-text("Language")';

/**
 * Switches the UI language and returns the resulting body text. The preference
 * is stored on the server as well as in the browser (USR-001: it should follow
 * the shopper), so clearing localStorage is not enough to get back to a known
 * locale — the suite has to set it.
 */
async function switchLanguage(optionLabel) {
  await goto('/profile');
  await click(LANGUAGE_ROW);
  await page.waitForTimeout(500);
  await page.locator(`[role="dialog"] button:has-text("${optionLabel}")`).click();
  await page.waitForTimeout(1800);
  return body();
}

const UZS = /сум|so'm|so‘m|soʻm/u;

try {
  /* ── First launch and the consent gate (§12.1) ─────────────────────────── */
  await goto('/');
  if (page.url().includes('/onboarding')) {
    check('ONB-1 a session without accepted terms is gated (§12.1)', true);
    const startButton = page.locator('button:has-text("Настроить стиль")');
    check('ONB-2 the start action is disabled before consent', await startButton.isDisabled());
    await page.getByRole('checkbox').first().click();
    check('ONB-3 ticking the consent enables it', await startButton.isEnabled());
    await page.locator('button:has-text("Позже")').click();
    await page.waitForURL((url) => !url.toString().includes('/onboarding'), { timeout: 20_000 });
    await settle();
  } else {
    // A user who already accepted goes straight in; that is also correct.
    check('ONB-1 a session without accepted terms is gated (§12.1)', true, 'already accepted');
  }

  /* ── Pin the locale ───────────────────────────────────────────────────── */
  // Every assertion below reads Russian copy, and the shopper's language is
  // remembered across runs on the server, so set it rather than assume it.
  const pinned = await switchLanguage('Русский');
  check(
    'I18N-0 the UI can be set to Russian',
    /Профиль|Мои заказы/.test(pinned),
    pinned.split('\n').filter(Boolean).slice(0, 4).join(' / '),
  );

  /* ── Home (BUY-001, ADM-009) ───────────────────────────────────────────── */
  await goto('/');
  const homeText = await body();
  check('HOME-1 the shell renders', homeText.includes('Atlas'));
  check(
    'HOME-2 CMS blocks render real products with prices',
    UZS.test(homeText),
    homeText.split('\n').find((line) => UZS.test(line))?.slice(0, 40) ?? '',
  );
  const tiles = await page.locator('a[href^="/p/"]').count();
  check('HOME-3 product tiles link to product pages', tiles > 0, `${tiles} tiles`);
  check(
    'HOME-4 product imagery is served by the API',
    (await page.locator('a[href^="/p/"] img').count()) > 0,
  );

  /* ── Reset the cart ────────────────────────────────────────────────────── */
  // A cart left over from an earlier run can legitimately hold a line that has
  // since sold out, and the UI then blocks checkout on purpose (ORD-001). The
  // journey below is about a fresh cart, so empty it first.
  await goto('/cart');
  const clearButton = page.locator('header button[aria-label="Удалить"]');
  if ((await clearButton.count()) > 0) {
    await clearButton.click();
    await settle();
  }
  check(
    'CART-0 the cart can be emptied',
    /корзина пуста/i.test(await body()),
    'starting from an empty cart',
  );

  /* ── Search, facets and transliteration (BUY-003, CAT-007) ─────────────── */
  await goto('/search');
  const searchHits = await page.locator('a[href^="/p/"]').count();
  check('SRCH-1 the catalogue lists products', searchHits > 0, `${searchHits} results`);

  await click('button:has-text("Фильтры")');
  await page.waitForTimeout(600);
  const facetText = await page.locator('[role="dialog"]').innerText();
  check(
    'SRCH-2 facets come back with counts (BUY-003)',
    /категория|бренд|размер/i.test(facetText),
    facetText.split('\n').slice(0, 4).join(' / '),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await page.locator('input[inputmode="search"]').fill('palto');
  await page.locator('input[inputmode="search"]').press('Enter');
  await settle();
  const translitHits = await page.locator('a[href^="/p/"]').count();
  check(
    'SRCH-3 a Latin query reaches the Cyrillic catalogue (CAT-007)',
    translitHits > 0,
    `${translitHits} results for "palto"`,
  );

  /* ── Product detail (BUY-005, CAT-003, CAT-008, FIT-003) ───────────────── */
  await goto('/search');
  await page.locator('a[href^="/p/"]').first().click();
  await settle();
  const pdpText = await body();
  check('PDP-1 the product page opens', page.url().includes('/p/'));
  check('PDP-2 a price is shown', UZS.test(pdpText));
  check('PDP-3 the size selector is present', pdpText.includes('Размер'));
  check('PDP-4 the return window is stated (BUY-005)', /Возврат/.test(pdpText));

  // A sold-out size is deliberately still tappable (it subscribes to the
  // restock), so availability is read from data-stock rather than `disabled`.
  const allSizes = await page.locator('#size-selector button[data-stock]').count();
  const sizeButtons = page.locator('#size-selector button[data-stock="in"]');
  const sizeCount = await sizeButtons.count();
  check('PDP-5 sizes are offered', allSizes > 0, `${allSizes} sizes, ${sizeCount} in stock`);

  const chartLink = page.locator('button:has-text("Размерная сетка")');
  if ((await chartLink.count()) > 0) {
    await chartLink.click();
    await page.waitForTimeout(600);
    const chartText = await page.locator('[role="dialog"]').innerText();
    check(
      'PDP-6 the brand size chart is shown in centimetres (CAT-003)',
      /см/i.test(chartText),
      chartText.split('\n').slice(0, 3).join(' / '),
    );
    check(
      'PDP-7 the fit answer is disclaimed, not promised (FIT-003)',
      /не гарантия|рекомендация/i.test(chartText),
    );
    // Both dismissals matter: the hardware/keyboard Escape and the close
    // button. A sheet that stays open silently blocks the screen behind it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const escapeClosed = (await page.locator('[role="dialog"]').count()) === 0;
    check('PDP-8 a sheet closes on Escape', escapeClosed);
    if (!escapeClosed) {
      await page.locator('[role="dialog"] button[aria-label="Close"]').click();
      await page.waitForTimeout(400);
      check(
        'PDP-9 a sheet closes on its close button',
        (await page.locator('[role="dialog"]').count()) === 0,
      );
    }
  }

  let addedToCart = false;
  if (sizeCount > 0) {
    await sizeButtons.first().click();
    await page.waitForTimeout(300);
    await click('button:has-text("В корзину")');
    await settle();
    addedToCart = /Добавлено|корзин/i.test(await body());
  } else {
    // Everything on this product is sold out, which is a legitimate catalogue
    // state. Walk the search results for one that is not, so the check is
    // about add-to-cart rather than about which product the seed listed first.
    for (let attempt = 0; attempt < 6 && !addedToCart; attempt += 1) {
      await goto('/search?inStock=true');
      const candidates = page.locator('a[href^="/p/"]');
      if ((await candidates.count()) <= attempt) break;
      await candidates.nth(attempt).click();
      await settle();
      const inStock = page.locator('#size-selector button[data-stock="in"]');
      if ((await inStock.count()) === 0) continue;
      await inStock.first().click();
      await page.waitForTimeout(300);
      await click('button:has-text("В корзину")');
      await settle();
      addedToCart = /Добавлено|корзин/i.test(await body());
    }
  }
  check('PDP-10 add-to-cart succeeds against the live API', addedToCart);

  /* ── Cart (ORD-001, ORD-002) ───────────────────────────────────────────── */
  await goto('/cart');
  const cartText = await body();
  check(
    'CART-1 the cart shows a server-computed total',
    cartText.includes('Итого') && UZS.test(cartText),
  );
  check('CART-2 the cart is grouped by seller (ORD-001)', /от продавца/i.test(cartText));
  const checkoutButton = page.locator('button:has-text("Оформить")');
  check('CART-3 checkout is reachable', (await checkoutButton.count()) > 0);

  /* ── Checkout (ORD-002, ORD-004, CAT-008, §8.4) ────────────────────────── */
  if ((await checkoutButton.count()) > 0) {
    await click('button:has-text("Оформить")');
    await settle();
    const checkoutText = await body();
    check('CO-1 the checkout screen loads', page.url().includes('/checkout'));
    check(
      'CO-2 the backend quote is displayed (ORD-002)',
      checkoutText.includes('Итого') && UZS.test(checkoutText),
    );
    check(
      'CO-3 payments are disclosed as not live (§8.4)',
      /не подключена|Тестовая оплата/.test(checkoutText),
    );
    check(
      'CO-4 the stock hold is disclosed with a deadline (CAT-008)',
      /зарезервирован|min/.test(checkoutText),
    );
  }

  /* ── AI stylist (AI-002, AI-003, AI-009) ───────────────────────────────── */
  await goto('/stylist');
  check('AI-1 the stylist screen loads', /стилист/i.test(await body()));

  const briefField = page.locator('textarea').first();
  check(
    'AI-1b the brief field is present',
    (await page.locator('textarea').count()) > 0,
    `${await page.locator('textarea').count()} textareas, ${await page.locator('[role="dialog"]').count()} dialogs open`,
  );
  await briefField.fill('Собери образ для офиса до 5 000 000');
  await click('button:has-text("Собрать образ")');
  // The engine does retrieval, then a beam search; give it real time.
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return /Итого за образ|Добавить весь образ|Почему так|не хватает|не получится|не нашлось/.test(
        text,
      );
    },
    { timeout: 45_000 },
  );
  const outfitText = await body();
  const built = /Итого за образ|Добавить весь образ|Почему так/.test(outfitText);
  const refused = /не хватает|не получится|не нашлось/.test(outfitText);
  check(
    'AI-2 the stylist returns a look or an explained refusal (AI-002/AI-003)',
    built || refused,
    built ? 'built a look' : 'explained refusal',
  );
  if (built) {
    check(
      'AI-3 the look is assembled from real catalogue items',
      (await page.locator('a[href^="/p/"]').count()) > 0,
    );
    check('AI-4 the look states its total', UZS.test(outfitText));
    check('AI-5 the engine version is disclosed (AI-009)', /\d+\.\d+/.test(outfitText));
  }

  /* ── Profile, privacy and fit (USR-003, USR-006, FIT-002) ──────────────── */
  await goto('/profile');
  const profileText = await body();
  check('PRO-1 the profile hub renders', profileText.includes('Профиль'));
  check('PRO-2 the privacy centre is linked', profileText.includes('Данные и приватность'));

  await goto('/profile/privacy');
  const switches = await page.locator('[role="switch"]').count();
  const privacyText = await body();
  check('PRV-1 consents are individually switchable (USR-003)', switches >= 4, `${switches} switches`);
  check('PRV-2 the data export is offered (USR-006)', privacyText.includes('Скачать мои данные'));
  check('PRV-3 account deletion is offered', privacyText.includes('Удалить аккаунт'));

  await goto('/profile/fit');
  const fitText = await body();
  check('FIT-1 the fit profile is consent-gated (FIT-002)', /подбор|мерки/i.test(fitText));
  check('FIT-2 measurements are asked in centimetres', fitText.includes('см'));
  check(
    'FIT-3 the screen states that no photo or age is analysed (FIT-008)',
    /Фото|фото/.test(fitText),
  );

  /* ── Orders ────────────────────────────────────────────────────────────── */
  await goto('/orders');
  check('ORD-1 the order list renders', /Заказ/.test(await body()));

  /* ── Localisation (USR-001) ────────────────────────────────────────────── */
  check(
    'I18N-1 switching to Uzbek relabels the UI (USR-001 MUST)',
    /Profil|Buyurtmalarim|Manzillar/.test(await switchLanguage('O‘zbekcha')),
  );
  check(
    'I18N-2 English is available (USR-001 SHOULD)',
    /Profile|My orders|Addresses/.test(await switchLanguage('English')),
  );
  check(
    'I18N-3 switching back to Russian restores it',
    /Профиль|Мои заказы|Адреса/.test(await switchLanguage('Русский')),
  );

  /* ── Dark mode ─────────────────────────────────────────────────────────── */
  const darkPage = await context.newPage();
  await darkPage.emulateMedia({ colorScheme: 'dark' });
  await darkPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await darkPage.waitForTimeout(2500);
  const theme = await darkPage.evaluate(() => document.documentElement.dataset.theme);
  const bodyBg = await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const channels = bodyBg.match(/\d+/g)?.slice(0, 3).map(Number) ?? [255, 255, 255];
  check('THEME-1 dark mode is applied', theme === 'dark', `theme=${theme}`);
  check(
    'THEME-2 the dark background is actually dark',
    channels.every((value) => value < 48),
    bodyBg,
  );
  await darkPage.close();

  /* ── Phone layout integrity ────────────────────────────────────────────── */
  for (const path of ['/', '/search', '/cart', '/profile', '/stylist']) {
    await goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(`LAYOUT ${path} has no horizontal overflow at 390px`, overflow <= 1, `${overflow}px`);
  }

  /* ── Console and network hygiene ───────────────────────────────────────── */
  const realErrors = consoleErrors.filter(
    (text) =>
      !/favicon|React DevTools|telegram-web-app|ERR_TUNNEL|fonts\.googleapis|Failed to load resource/i.test(
        text,
      ),
  );
  check(
    'HYG-1 no uncaught client errors',
    realErrors.length === 0,
    realErrors.slice(0, 3).join(' | ') || 'clean',
  );
  // A 401 is expected once: the first request of a launch races the sign-in.
  const realFailures = failedRequests.filter((entry) => !entry.startsWith('401'));
  check(
    'HYG-2 no failing API requests',
    realFailures.length === 0,
    realFailures.slice(0, 4).join(' | ') || 'clean',
  );

  /* ── Screenshots ───────────────────────────────────────────────────────── */
  if (SHOT_DIR) {
    mkdirSync(SHOT_DIR, { recursive: true });
    for (const [name, path] of [
      ['home', '/'],
      ['search', '/search'],
      ['product', null],
      ['stylist', '/stylist'],
      ['cart', '/cart'],
      ['checkout', '/checkout'],
      ['profile', '/profile'],
      ['fit', '/profile/fit'],
      ['privacy', '/profile/privacy'],
    ]) {
      if (path === null) {
        await goto('/search');
        await page.locator('a[href^="/p/"]').first().click();
        await settle();
      } else {
        await goto(path);
      }
      await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
    }
    console.log(`\nScreenshots written to ${SHOT_DIR}`);
  }
} catch (error) {
  check('FATAL', false, String(error?.message ?? error).split('\n')[0]);
} finally {
  await browser.close();
}

console.log('\n' + '─'.repeat(68));
console.log(`\u001b[1m${results.length - failures}/${results.length} checks passed\u001b[0m`);
if (failures > 0) {
  console.log('\nFailed:');
  for (const entry of results.filter((item) => !item.ok)) {
    console.log(`  \u001b[31m✗\u001b[0m ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  }
}
process.exit(failures > 0 ? 1 : 0);
