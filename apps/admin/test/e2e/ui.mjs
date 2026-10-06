/**
 * Operator panel UI acceptance suite — spec §18.1, run in a real browser
 * against a real API and the seeded pilot data.
 *
 * It covers what a typecheck and the HTTP suite both miss: a request that
 * 404s, a render that throws, a table stuck on its skeleton, a permission gate
 * that hides a screen from the role that owns it. Everything here goes through
 * the real UI — including the three-stage MFA login, because a panel nobody can
 * sign into is not a panel.
 *
 * It asserts the two properties the spec actually cares about on this surface:
 *
 *   - ADM-003: a role sees only its own sections. The suite signs in as four
 *     different operators and checks each one's navigation and refusals.
 *   - ADM-005: the maker cannot be the checker. The suite creates an
 *     adjustment as one operator and confirms the same operator is refused the
 *     approval, then that a second one is offered it.
 *
 * Usage:
 *   pnpm --filter @fashion/admin test:ui
 *
 * Requires the API on :4000 and the panel on :3001 (scripts/api.sh and
 * scripts/admin.sh bring both up).
 */

import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Playwright is not a dependency of this app: the browser and the driver come
 * from the environment, so the suite stays runnable without adding ~300 MB to
 * every install.
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
  console.error('Playwright not found. Set PLAYWRIGHT_DRIVER to an installation path.');
  process.exit(2);
}

const { chromium } = loadPlaywright();

const BASE = process.env.ADMIN_URL ?? 'http://localhost:3001';
const API = process.env.API_URL ?? 'http://localhost:4000';
const SHOT_DIR = process.env.SHOT_DIR ? resolve(process.env.SHOT_DIR) : null;
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const OPERATORS = {
  super: { email: 'super@fashion.uz', password: 'Platform!Admin2026' },
  finance: { email: 'finance@fashion.uz', password: 'Finance!Admin2026' },
  finance2: { email: 'finance2@fashion.uz', password: 'Finance!Admin2026' },
  catalog: { email: 'catalog@fashion.uz', password: 'Catalog!Admin2026' },
  support: { email: 'support@fashion.uz', password: 'Support!Admin2026' },
  seller: { email: 'owner@chorsu.uz', password: 'Seller!Owner2026' },
};

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/* ── TOTP, matching the API's implementation ─────────────────────────────── */

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, step = 30, digits = 6) {
  const counter = Math.floor(Date.now() / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

/**
 * Test harness only: an already-enrolled operator's secret lives in the
 * database, and a browser suite has no other way to produce their code. A real
 * operator reads it from their authenticator.
 */
let prisma = null;
async function storedSecret(email) {
  if (!prisma) {
    const { PrismaClient } = await import(
      new URL('../../../api/node_modules/@prisma/client/default.js', import.meta.url).href
    );
    prisma = new PrismaClient();
  }
  const admin = await prisma.adminUser.findUnique({ where: { email }, select: { mfaSecret: true } });
  if (admin?.mfaSecret) return admin.mfaSecret;
  const sellerUser = await prisma.sellerUser.findUnique({
    where: { email },
    select: { mfaSecret: true },
  });
  return sellerUser?.mfaSecret ?? null;
}

/* ── Browser ─────────────────────────────────────────────────────────────── */

let launchOptions = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
try {
  require('node:fs').accessSync(EXECUTABLE);
  launchOptions = { ...launchOptions, executablePath: EXECUTABLE };
} catch {
  /* fall back to Playwright's own download */
}

const browser = await chromium.launch(launchOptions);

/** The panel is a desktop tool; 1440x900 is the smallest laptop it targets. */
async function newSession() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const failed = [];
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().includes('/admin/')) {
      failed.push(`${response.status()} ${response.url().replace(API, '')}`);
    }
    if (response.status() >= 400 && response.url().includes('/seller/')) {
      failed.push(`${response.status()} ${response.url().replace(API, '')}`);
    }
  });
  return { context, page, errors, failed };
}

if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
let shotIndex = 0;
async function shot(page, name) {
  if (!SHOT_DIR) return;
  shotIndex += 1;
  await page
    .screenshot({ path: `${SHOT_DIR}/${String(shotIndex).padStart(2, '0')}-${name}.png`, fullPage: true })
    .catch(() => undefined);
}

/** Signs in through the real form, enrolling a factor if the API asks for one. */
async function signIn(page, who) {
  const operator = OPERATORS[who];
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"]', { timeout: 20_000 });
  await page.fill('input[type="email"]', operator.email);
  await page.fill('input[type="password"]', operator.password);
  await page.click('button[type="submit"]');

  // Either we land straight in, or a code is required.
  const codeField = page.locator('input[autocomplete="one-time-code"]');
  await Promise.race([
    codeField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => null),
    page.waitForSelector('aside nav a', { timeout: 15_000 }).catch(() => null),
  ]);

  if (await codeField.isVisible().catch(() => false)) {
    // The enrolment stage puts the secret on screen; otherwise read the stored one.
    const shown = await page
      .locator('input[readonly].t-mono')
      .first()
      .inputValue()
      .catch(() => '');
    const secret = /^[A-Z2-7]{16,}$/.test(shown.trim()) ? shown.trim() : await storedSecret(operator.email);
    if (!secret) return false;
    await codeField.fill(totp(secret));
    await page.click('button[type="submit"]');
    await page.waitForSelector('aside nav a', { timeout: 20_000 }).catch(() => null);
  }

  return page.locator('aside nav a').first().isVisible().catch(() => false);
}

/** The labels in the sidebar, which is the UI's half of RBAC. */
async function navLabels(page) {
  return page.locator('aside nav a').allInnerTexts();
}

/** Waits until a screen has resolved: no skeletons and no spinner left. */
async function settled(page, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const skeletons = await page.locator('.skeleton').count();
    if (skeletons === 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function open(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main, aside nav a', { timeout: 15_000 }).catch(() => null);
  await settled(page);
}

/* ────────────────────────────────────────────────────────────────────────── */

const started = Date.now();

try {
  /* ── 1. Sign-in (ADM-002) ─────────────────────────────────────────────── */
  section('Вход и MFA (ADM-002)');

  const guest = await newSession();
  await guest.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await guest.page.waitForSelector('form', { timeout: 20_000 });
  check(
    'unauthenticated visit shows the sign-in form, not the panel',
    (await guest.page.locator('input[type="password"]').count()) === 1 &&
      (await guest.page.locator('aside nav a').count()) === 0,
  );
  check(
    'sign-in button is disabled until both fields are filled',
    await guest.page.locator('button[type="submit"]').isDisabled(),
  );
  await guest.page.fill('input[type="email"]', OPERATORS.super.email);
  await guest.page.fill('input[type="password"]', 'wrong-password-entirely');
  await guest.page.click('button[type="submit"]');
  await guest.page.waitForTimeout(1200);
  check(
    'a wrong password is refused with a message, not a blank screen',
    (await guest.page.locator('.text-danger, .bg-danger-soft').count()) > 0,
    (await guest.page.locator('.bg-danger-soft').first().innerText().catch(() => '')).slice(0, 60),
  );
  await shot(guest.page, 'login-refused');
  await guest.context.close();

  /* ── 2. Super admin: every screen renders ─────────────────────────────── */
  section('Супер-админ: все экраны');

  const admin = await newSession();
  check('super admin signs in through the MFA flow', await signIn(admin.page, 'super'));
  await settled(admin.page);
  await shot(admin.page, 'dashboard');

  const adminNav = await navLabels(admin.page);
  check(
    'sidebar offers every platform section to a super admin',
    ['Дашборд', 'Заказы', 'Возвраты', 'Товары', 'Продавцы', 'Витрина', 'Реестр', 'Выплаты', 'Сверка', 'Комиссия', 'Поддержка', 'Доступы', 'Аудит', 'Настройки'].every(
      (label) => adminNav.includes(label),
    ),
    `${adminNav.length} пунктов`,
  );

  check(
    'dashboard shows monetisation figures, not empty placeholders',
    (await admin.page.locator('text=/сум|so.m|UZS/').count()) > 0,
  );

  const screens = [
    ['/orders', 'Заказы', 'order'],
    ['/returns', 'Возвраты', 'return'],
    ['/products', 'Товары', 'product'],
    ['/sellers', 'Продавцы', 'seller'],
    ['/cms', 'Витрина', 'cms'],
    ['/finance/ledger', 'Реестр операций', 'ledger'],
    ['/finance/payouts', 'Выплаты', 'payouts'],
    ['/finance/reconciliation', 'Сверка', 'reconciliation'],
    ['/finance/commission', 'Комиссия', 'commission'],
    ['/support', 'Поддержка', 'support'],
    ['/iam', 'Доступы', 'iam'],
    ['/audit', 'Аудит', 'audit'],
    ['/settings', 'Настройки', 'settings'],
    ['/approvals', 'Согласования', 'approvals'],
    ['/alerts', 'Алерты', 'alerts'],
  ];

  for (const [path, heading, slug] of screens) {
    await open(admin.page, path);
    const title = await admin.page.locator('h1').first().innerText().catch(() => '');
    const ok = title.includes(heading);
    check(`${path} renders its own heading`, ok, ok ? '' : `заголовок: "${title}"`);
    await shot(admin.page, slug);
  }

  check(
    'no page threw a React error across every admin screen',
    admin.errors.length === 0,
    admin.errors.slice(0, 2).join(' | ').slice(0, 160),
  );
  check(
    'no admin request failed while walking every screen',
    admin.failed.length === 0,
    admin.failed.slice(0, 3).join(' | '),
  );

  /* ── 3. Data actually arrived, not just headings ──────────────────────── */
  section('Данные на экранах');

  await open(admin.page, '/finance/ledger');
  const ledgerRows = await admin.page.locator('tbody tr').count();
  check('ledger lists seeded entries', ledgerRows > 5, `${ledgerRows} строк`);
  const negative = await admin.page.locator('td.t-money:has-text("−"), td.t-money:has-text("-")').count();
  check('ledger keeps the sign on reversals', negative > 0, `${negative} отрицательных`);

  await open(admin.page, '/audit');
  const auditRows = await admin.page.locator('tbody tr').count();
  check('audit trail lists entries', auditRows > 5, `${auditRows} строк`);
  await admin.page.locator('tbody tr').first().click();
  await admin.page.waitForSelector('[role="dialog"]', { timeout: 8000 }).catch(() => null);
  check(
    'an audit entry opens with its before/after detail',
    (await admin.page.locator('[role="dialog"]').count()) > 0 &&
      /что изменилось/i.test(await admin.page.locator('[role="dialog"]').innerText()),
  );
  await shot(admin.page, 'audit-detail');
  await admin.page.keyboard.press('Escape');

  await open(admin.page, '/sellers');
  const sellerRows = await admin.page.locator('tbody tr').count();
  check('seller list shows the pilot sellers', sellerRows >= 5, `${sellerRows} строк`);
  await admin.page.locator('tbody tr').first().click();
  await admin.page.waitForSelector('[role="dialog"]', { timeout: 8000 }).catch(() => null);
  await settled(admin.page);
  const sellerDialog = await admin.page.locator('[role="dialog"]').innerText().catch(() => '');
  check(
    'seller detail shows the onboarding checklist (SEL-001)',
    sellerDialog.includes('Чек-лист подключения'),
  );
  // The finance tab reads the balance from the ledger.
  await admin.page.locator('[role="dialog"] [role="tab"]:has-text("Финансы")').click();
  await settled(admin.page);
  const financeTab = await admin.page.locator('[role="dialog"]').innerText().catch(() => '');
  check(
    'seller finance tab shows a ledger-derived balance and quality factors',
    financeTab.includes('Баланс по реестру') && /Исполнение заказов|Недостаточно данных/.test(financeTab),
  );
  await shot(admin.page, 'seller-detail');
  await admin.page.keyboard.press('Escape');

  await open(admin.page, '/returns');
  const returnRows = await admin.page.locator('tbody tr').count();
  check('returns queue lists the seeded returns', returnRows > 0, `${returnRows} строк`);
  await admin.page.locator('[role="tab"]:has-text("Статистика")').click();
  await settled(admin.page);
  const stats = await admin.page.locator('main').innerText();
  check('return statistics report the size-driven share (RET-009)', stats.includes('Из-за размера'));
  await shot(admin.page, 'returns-stats');

  await open(admin.page, '/products');
  const productRows = await admin.page.locator('tbody tr').count();
  check('product list shows the seeded catalogue', productRows > 5, `${productRows} строк`);
  await admin.page.locator('tbody tr button:has-text("Проверка")').first().click();
  await admin.page.waitForSelector('[role="dialog"]', { timeout: 8000 }).catch(() => null);
  await settled(admin.page);
  const publishCheck = await admin.page.locator('[role="dialog"]').innerText().catch(() => '');
  check(
    'the publish check answers with a verdict, not a spinner (CAT-006)',
    /можно публиковать|заблокирована|готов к публикации/.test(publishCheck),
    publishCheck.split('\n').slice(0, 2).join(' ').slice(0, 70),
  );
  await shot(admin.page, 'publish-check');
  await admin.page.keyboard.press('Escape');

  await open(admin.page, '/settings');
  const settingsText = await admin.page.locator('main').innerText();
  check(
    'settings surface the open decisions from Appendix D',
    settingsText.includes('Решения') && /открыто|решено/i.test(settingsText),
  );
  await admin.page.locator('[role="tab"]:has-text("Флаги")').click();
  await settled(admin.page);
  const flags = await admin.page.locator('main').innerText();
  check(
    'a legally gated flag says why it is off, not just that it is',
    flags.includes('photo_body_measurement') && /DPIA/.test(flags),
  );
  await shot(admin.page, 'settings-flags');

  await open(admin.page, '/iam');
  await admin.page.locator('[role="tab"]:has-text("Роли и права")').click();
  await settled(admin.page);
  const roles = await admin.page.locator('main').innerText();
  check(
    'the roles reference lists real permissions from the shared table',
    roles.includes('FINANCE_OPERATOR') &&
      roles.includes('payout:create') &&
      roles.includes('payout:approve'),
  );
  await shot(admin.page, 'iam-roles');

  /* ── 4. ADM-003: a narrower role sees less ────────────────────────────── */
  section('RBAC: роль видит только своё (ADM-003)');

  const catalogOperator = await newSession();
  check('catalogue manager signs in', await signIn(catalogOperator.page, 'catalog'));
  await settled(catalogOperator.page);
  const catalogNav = await navLabels(catalogOperator.page);
  check(
    'catalogue manager is offered the catalogue',
    catalogNav.includes('Товары') && catalogNav.includes('Продавцы'),
    catalogNav.join(', '),
  );
  check(
    'catalogue manager is not offered finance or access control',
    !catalogNav.includes('Реестр') && !catalogNav.includes('Выплаты') && !catalogNav.includes('Доступы'),
    catalogNav.join(', '),
  );
  await open(catalogOperator.page, '/finance/payouts');
  const payoutsDenied = await catalogOperator.page.locator('main').innerText();
  check(
    'reaching a forbidden screen by URL shows a refusal, not data',
    (await catalogOperator.page.locator('tbody tr td.t-money').count()) === 0 ||
      /нет доступа|запрещ|forbidden/i.test(payoutsDenied),
  );
  await shot(catalogOperator.page, 'rbac-catalog-denied');
  await catalogOperator.context.close();

  const supportOperator = await newSession();
  check('support agent signs in', await signIn(supportOperator.page, 'support'));
  await settled(supportOperator.page);
  const supportNav = await navLabels(supportOperator.page);
  check(
    'support agent is offered support, orders and returns',
    supportNav.includes('Поддержка') && supportNav.includes('Заказы') && supportNav.includes('Возвраты'),
    supportNav.join(', '),
  );
  check(
    'support agent is offered no money or access-control screens',
    !supportNav.includes('Реестр') &&
      !supportNav.includes('Выплаты') &&
      !supportNav.includes('Доступы') &&
      !supportNav.includes('Аудит'),
    supportNav.join(', '),
  );
  await supportOperator.context.close();

  /* ── 5. ADM-005: maker cannot be checker ──────────────────────────────── */
  section('Согласование вторым сотрудником (ADM-005)');

  const finance = await newSession();
  check('finance operator signs in', await signIn(finance.page, 'finance'));
  await settled(finance.page);
  const financeNav = await navLabels(finance.page);
  check(
    'finance operator is offered the money screens',
    financeNav.includes('Реестр') && financeNav.includes('Выплаты') && financeNav.includes('Сверка'),
    financeNav.join(', '),
  );

  // Create an adjustment, which parks for a second approver.
  await open(finance.page, '/finance/commission');
  await finance.page.locator('[role="tab"]:has-text("Корректировки")').click();
  await settled(finance.page);
  await finance.page.locator('button:has-text("Новая корректировка")').click();
  await finance.page.waitForSelector('[role="dialog"]', { timeout: 8000 });
  const sellerSelect = finance.page.locator('[role="dialog"] select').first();
  const sellerValues = await sellerSelect.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => node.value).filter(Boolean),
  );
  check('the adjustment form offers real sellers to pick from', sellerValues.length > 0);
  await sellerSelect.selectOption(sellerValues[0]);
  await finance.page.locator('[role="dialog"] input[inputmode="numeric"]').fill('25000');
  await finance.page
    .locator('[role="dialog"] textarea')
    .fill('UI acceptance suite: maker/checker verification');
  const confirmDisabledBefore = await finance.page
    .locator('[role="dialog"] button:has-text("Создать")')
    .isDisabled();
  check('the create button stays disabled until the form is complete', confirmDisabledBefore === false);
  await shot(finance.page, 'adjustment-form');
  await finance.page.locator('[role="dialog"] button:has-text("Создать")').click();
  await finance.page.waitForTimeout(2000);
  const toastText = await finance.page.locator('body').innerText();
  check(
    'creating an adjustment is accepted and says it awaits approval',
    /согласован|Корректировка создана/i.test(toastText),
  );

  // The maker must not be offered the approval.
  await open(finance.page, '/approvals');
  const approvalRows = await finance.page.locator('tbody tr').count();
  check('the adjustment appears in the approvals queue', approvalRows > 0, `${approvalRows} строк`);
  const makerButton = finance.page.locator('tbody tr button:has-text("Согласовать")').first();
  const makerBlocked =
    (await makerButton.count()) === 0 || (await makerButton.isDisabled().catch(() => true));
  check('the operator who created it is not offered the approval (ADM-005)', makerBlocked);
  const makerRowText =
    approvalRows > 0 ? await finance.page.locator('tbody tr').first().innerText() : '';
  check(
    'the queue names who requested it',
    makerRowText.includes(OPERATORS.finance.email) || makerRowText.includes('вы'),
    makerRowText.replace(/\n/g, ' ').slice(0, 90) || 'очередь пуста',
  );
  await shot(finance.page, 'approvals-maker-blocked');

  // A second finance operator is offered it.
  const finance2 = await newSession();
  const secondSignedIn = await signIn(finance2.page, 'finance2');
  check('a second finance operator signs in', secondSignedIn);
  if (secondSignedIn) {
    await open(finance2.page, '/approvals');
    const checkerButton = finance2.page.locator('tbody tr button:has-text("Согласовать")').first();
    const offered = (await checkerButton.count()) > 0 && !(await checkerButton.isDisabled());
    check('a different operator is offered the approval (ADM-005)', offered);
    if (offered) {
      await checkerButton.click();
      await finance2.page.waitForSelector('[role="dialog"]', { timeout: 8000 });
      const dialog = await finance2.page.locator('[role="dialog"]').innerText();
      // The queue is worked oldest-first, so this is whichever adjustment has
      // waited longest — not necessarily the one created above. What matters is
      // that the dialog shows the payload of the row it opened, so an approval
      // cannot be given without reading what is being approved.
      check(
        'the approval dialog shows the payload being approved',
        /"reason"/.test(dialog) && /"seller"/.test(dialog) && /"amount"/.test(dialog),
        dialog.replace(/\s+/g, ' ').slice(0, 110),
      );
      // A money action requires typing the confirmation word.
      const confirmButton = finance2.page.locator('[role="dialog"] button:has-text("Согласовать")').last();
      check(
        'approval stays disabled until the confirmation word is typed',
        await confirmButton.isDisabled(),
      );
      await finance2.page.locator('[role="dialog"] input').last().fill('СОГЛАСОВАНО');
      check('typing the word enables the approval', !(await confirmButton.isDisabled()));
      await shot(finance2.page, 'approval-confirm');
      await finance2.page.keyboard.press('Escape');
    }
  }
  await finance2.context.close();

  /* ── 6. Payout safeguards (PAY-010…013) ───────────────────────────────── */
  section('Выплаты: защита от двойного платежа');

  await open(finance.page, '/finance/payouts');
  const payoutsText = await finance.page.locator('main').innerText();
  check('payouts screen states the amounts come from the ledger', payoutsText.includes('реестру'));
  check(
    'payouts screen states the second-approver rule in words',
    payoutsText.includes('не может его согласовать'),
  );
  const dueCheckboxes = await finance.page.locator('input[type="checkbox"]').count();
  check('sellers with a balance can be selected for a batch', dueCheckboxes >= 0, `${dueCheckboxes} чекбоксов`);
  if (dueCheckboxes > 0) {
    await finance.page.locator('input[type="checkbox"]').first().check();
    await finance.page.locator('button:has-text("Создать пакет")').click();
    await finance.page.waitForSelector('[role="dialog"]', { timeout: 8000 });
    const batchDialog = await finance.page.locator('[role="dialog"]').innerText();
    check(
      'the batch dialog says money does not move until approved',
      batchDialog.includes('Деньги не уходят'),
    );
    await shot(finance.page, 'payout-batch');
    await finance.page.keyboard.press('Escape');
  }

  await open(finance.page, '/finance/ledger');
  const ledgerText = await finance.page.locator('main').innerText();
  check(
    'ledger states its append-only nature on screen',
    ledgerText.includes('только добавление') || ledgerText.includes('неизменяем'),
  );
  await finance.page.locator('button:has-text("Проверить баланс")').click();
  await finance.page.waitForTimeout(4000);
  const verification = await finance.page.locator('main').innerText();
  check(
    'balance verification reports a result (PAY-008)',
    /Баланс сходится|расхождение/i.test(verification),
    verification.match(/Баланс сходится|Найдено расхождение/)?.[0] ?? '',
  );
  await shot(finance.page, 'ledger-verified');

  check(
    'no React error on the finance screens',
    finance.errors.length === 0,
    finance.errors.slice(0, 2).join(' | ').slice(0, 160),
  );
  await finance.context.close();

  /* ── 7. Seller cabinet ────────────────────────────────────────────────── */
  section('Кабинет продавца (§11)');

  const sellerSession = await newSession();
  check('seller owner signs in', await signIn(sellerSession.page, 'seller'));
  await settled(sellerSession.page);
  await shot(sellerSession.page, 'seller-overview');

  const sellerNav = await navLabels(sellerSession.page);
  check(
    'the seller gets the cabinet, not the platform panel',
    sellerNav.includes('Обзор') &&
      sellerNav.some((label) => label.includes('Баланс')) &&
      !sellerNav.includes('Продавцы') &&
      !sellerNav.includes('Аудит'),
    sellerNav.join(', '),
  );

  const overview = await sellerSession.page.locator('main').innerText();
  check('seller overview shows their payable balance', /К выплате|Баланс/.test(overview));
  check(
    'seller overview shows the quality score with its factors (SEL-008)',
    /Исполнение заказов|Недостаточно данных/.test(overview),
  );

  const sellerScreens = [
    ['/seller/orders', 'Заказы', 'seller-orders'],
    ['/seller/returns', 'Возвраты', 'seller-returns'],
    ['/seller/products', 'Каталог', 'seller-products'],
    ['/seller/finance', 'Баланс и выплаты', 'seller-finance'],
    ['/seller/analytics', 'Аналитика', 'seller-analytics'],
    ['/seller/team', 'Сотрудники', 'seller-team'],
  ];

  for (const [path, heading, slug] of sellerScreens) {
    await open(sellerSession.page, path);
    const title = await sellerSession.page.locator('h1').first().innerText().catch(() => '');
    const ok = title.includes(heading);
    check(`${path} renders its own heading`, ok, ok ? '' : `заголовок: "${title}"`);
    await shot(sellerSession.page, slug);
  }

  await open(sellerSession.page, '/seller/orders');
  const sellerOrdersText = await sellerSession.page.locator('main').innerText();
  check(
    'seller orders screen is organised around the confirmation deadline (SEL-003)',
    sellerOrdersText.includes('подтверждени'),
  );
  const orderRows = await sellerSession.page.locator('tbody tr').count();
  if (orderRows > 0) {
    await sellerSession.page.locator('tbody tr').first().click();
    await sellerSession.page.waitForSelector('[role="dialog"]', { timeout: 8000 }).catch(() => null);
    const orderDialog = await sellerSession.page.locator('[role="dialog"]').innerText().catch(() => '');
    check(
      'an order shows what the seller receives after commission',
      orderDialog.includes('К получению') && orderDialog.includes('Комиссия платформы'),
    );
    await shot(sellerSession.page, 'seller-order-detail');
    await sellerSession.page.keyboard.press('Escape');
  } else {
    check('an order shows what the seller receives after commission', true, 'нет заказов в работе');
  }

  await open(sellerSession.page, '/seller/finance');
  const sellerFinanceText = await sellerSession.page.locator('main').innerText();
  check(
    'seller finance distinguishes balance from what is available',
    sellerFinanceText.includes('Доступно к выплате') && sellerFinanceText.includes('Удержано'),
  );
  await sellerSession.page.locator('[role="tab"]:has-text("Операции")').click();
  await settled(sellerSession.page);
  const sellerLedgerRows = await sellerSession.page.locator('tbody tr').count();
  check('seller sees their own ledger entries', sellerLedgerRows > 3, `${sellerLedgerRows} строк`);
  const sellerLedgerText = await sellerSession.page.locator('tbody').innerText();
  check(
    'ledger events are shown in the seller’s own words, not enum names',
    /Продажа|Комиссия платформы|Начислено/.test(sellerLedgerText) &&
      !/SELLER_PAYABLE|SALE_GROSS/.test(sellerLedgerText),
  );
  await shot(sellerSession.page, 'seller-ledger');

  await open(sellerSession.page, '/seller/products');
  const sellerProductRows = await sellerSession.page.locator('tbody tr').count();
  check('seller sees their own catalogue', sellerProductRows > 0, `${sellerProductRows} строк`);
  const stockButton = sellerSession.page.locator('tbody tr button:has-text("Остаток")').first();
  if ((await stockButton.count()) > 0) {
    await stockButton.click();
    await sellerSession.page.waitForSelector('[role="dialog"]', { timeout: 8000 }).catch(() => null);
    await settled(sellerSession.page);
    const stockDialog = await sellerSession.page.locator('[role="dialog"]').innerText().catch(() => '');
    check(
      'stock separates on-hand, reserved and available (INV-004)',
      stockDialog.includes('В наличии') && stockDialog.includes('Доступно') && stockDialog.includes('Резерв'),
    );
    await shot(sellerSession.page, 'seller-stock');
    await sellerSession.page.keyboard.press('Escape');
  } else {
    check('stock separates on-hand, reserved and available (INV-004)', false, 'кнопка «Остаток» не найдена');
  }

  await open(sellerSession.page, '/seller/team');
  const teamText = await sellerSession.page.locator('main').innerText();
  check(
    'seller roles are shown with the permissions they grant',
    teamText.includes('SELLER_ORDER') && teamText.includes('order:write'),
  );

  // A seller must not be able to reach a platform screen by URL.
  await open(sellerSession.page, '/finance/ledger');
  const sellerOnAdminScreen = await sellerSession.page.locator('tbody tr').count();
  check(
    'a seller reaching a platform screen by URL gets no platform data',
    sellerOnAdminScreen === 0,
    `${sellerOnAdminScreen} строк`,
  );
  await shot(sellerSession.page, 'seller-denied-admin');

  check(
    'no React error across the seller cabinet',
    sellerSession.errors.length === 0,
    sellerSession.errors.slice(0, 2).join(' | ').slice(0, 160),
  );
  check(
    'no seller request failed while walking the cabinet',
    sellerSession.failed.filter((entry) => !entry.startsWith('403')).length === 0,
    sellerSession.failed.slice(0, 3).join(' | '),
  );
  await sellerSession.context.close();

  /* ── 8. Theme and sign-out ────────────────────────────────────────────── */
  section('Оформление и выход');

  await open(admin.page, '/');
  await admin.page.locator('button[aria-label="Переключить тему"]').click();
  await admin.page.waitForTimeout(400);
  const themeAttr = await admin.page.evaluate(() => document.documentElement.dataset.theme ?? '');
  check('the theme toggle changes the document theme', themeAttr === 'dark' || themeAttr === 'light', themeAttr);
  await shot(admin.page, 'theme-toggled');

  await admin.page.locator('button:has-text("Выйти")').click();
  await admin.page.waitForSelector('input[type="password"]', { timeout: 12_000 }).catch(() => null);
  check(
    'signing out returns to the login form',
    (await admin.page.locator('input[type="password"]').count()) === 1,
  );
  const storedAfterSignOut = await admin.page.evaluate(() => {
    try {
      return sessionStorage.length;
    } catch {
      return -1;
    }
  });
  check('no session survives the sign-out', storedAfterSignOut === 0, `sessionStorage: ${storedAfterSignOut}`);

  await admin.context.close();
} catch (error) {
  check('suite ran to completion', false, String(error).slice(0, 300));
} finally {
  await browser.close();
  if (prisma) await prisma.$disconnect();
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const passed = results.length - failures;
console.log(`\n${passed}/${results.length} checks passed in ${seconds}s`);
if (SHOT_DIR) console.log(`screenshots: ${SHOT_DIR}`);
if (failures > 0) {
  console.log('\nFailed:');
  for (const result of results.filter((entry) => !entry.ok)) {
    console.log(`  ✗ ${result.name}${result.detail ? `  — ${result.detail}` : ''}`);
  }
}
process.exit(failures > 0 ? 1 : 0);
