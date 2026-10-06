/**
 * Bot ↔ API service channel — spec TG-006.
 *
 * These run against a live API, because the thing worth proving is that the
 * two sides agree on the signature, and that can only be wrong between
 * processes. The bot's `stableStringify` has to produce byte-for-byte what the
 * API's does: sorted keys, no whitespace. A divergence there rejects every
 * single call, and a unit test over the bot's own copy would not notice.
 *
 *   pnpm --filter @fashion/bot test
 *
 * Requires the API on :4000 with TELEGRAM_BOT_TOKEN set to the same value.
 * Without it the suite skips rather than failing, so it does not block a
 * checkout that has no bot configured.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

import { ApiClient, signBody, stableStringify } from '../src/api';
import { missingKeys, escapeHtml, t } from '../src/copy';
import { LOCALES, decodeDeepLink, deepLinkToRoute, encodeDeepLink } from '@fashion/core';

loadDotenv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

const API_URL = (process.env.API_INTERNAL_URL ?? process.env.API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

let live = false;

before(async () => {
  if (!TOKEN) {
    console.log('  (skipping the live checks: TELEGRAM_BOT_TOKEN is not set)');
    return;
  }
  try {
    const response = await fetch(`${API_URL}/healthz`, { signal: AbortSignal.timeout(2500) });
    live = response.ok;
  } catch {
    live = false;
  }
  if (!live) console.log(`  (skipping the live checks: no API on ${API_URL})`);
});

describe('stable serialisation', () => {
  it('sorts keys so two orderings sign identically', () => {
    assert.equal(
      stableStringify({ b: 1, a: 2 }),
      stableStringify({ a: 2, b: 1 }),
    );
    assert.equal(stableStringify({ a: 2, b: 1 }), '{"a":2,"b":1}');
  });

  it('emits no whitespace', () => {
    const text = stableStringify({ telegramId: '1', nested: { x: [1, 2] } });
    assert.ok(!/\s/.test(text), text);
  });

  it('keeps array order, which is meaningful', () => {
    assert.equal(stableStringify([3, 1, 2]), '[3,1,2]');
  });

  it('handles the shapes the service channel actually sends', () => {
    assert.equal(stableStringify({ limit: 25 }), '{"limit":25}');
    assert.equal(
      stableStringify({ telegramId: '777000001', blocked: true }),
      '{"blocked":true,"telegramId":"777000001"}',
    );
    assert.equal(stableStringify({}), '{}');
  });

  it('produces a stable hex signature', () => {
    const signature = signBody({ limit: 1 }, 'secret');
    assert.match(signature, /^[0-9a-f]{64}$/);
    assert.equal(signature, signBody({ limit: 1 }, 'secret'));
    assert.notEqual(signature, signBody({ limit: 2 }, 'secret'));
    assert.notEqual(signature, signBody({ limit: 1 }, 'other-secret'));
  });
});

describe('deep links — TG-002', () => {
  it('round-trips every kind the bot sends', () => {
    const targets = [
      { kind: 'home' },
      { kind: 'product', id: 'abc-123' },
      { kind: 'order', id: 'FM-261006-0005' },
      { kind: 'brand', slug: 'atlas-adras' },
      { kind: 'category', slug: 'coats' },
      { kind: 'look', id: 'look-1' },
      { kind: 'stylist', prompt: 'office look' },
    ] as const;

    for (const target of targets) {
      const encoded = encodeDeepLink(target);
      // Telegram restricts startapp to A-Z a-z 0-9 _ - and 64 characters.
      assert.match(encoded, /^[A-Za-z0-9_-]+$/, `${target.kind} encoded to ${encoded}`);
      assert.ok(encoded.length <= 64, `${target.kind} encoded to ${encoded.length} chars`);
      const decoded = decodeDeepLink(encoded);
      assert.equal(decoded.kind, target.kind);
      assert.ok(deepLinkToRoute(decoded).startsWith('/'));
    }
  });

  it('falls back to the home screen rather than throwing on rubbish', () => {
    for (const payload of ['', 'not-a-link', '!!!', 'z_'.repeat(50)]) {
      const decoded = decodeDeepLink(payload);
      assert.ok(deepLinkToRoute(decoded).startsWith('/'));
    }
  });
});

describe('copy', () => {
  it('is complete in every locale (USR-001)', () => {
    for (const locale of LOCALES) {
      assert.deepEqual(missingKeys(locale), [], `${locale} is missing bot copy`);
    }
  });

  it('interpolates its parameters', () => {
    for (const locale of LOCALES) {
      const text = t(locale, 'start.welcomeBack', { name: 'Дилноза' });
      assert.match(text, /Дилноза/);
      assert.ok(!/\{\w+\}/.test(text), text);
    }
  });

  it('escapes what Telegram would otherwise parse as markup', () => {
    assert.equal(escapeHtml('<b>hi</b> & "x"'), '&lt;b&gt;hi&lt;/b&gt; &amp; "x"');
    // A product title really can contain these.
    assert.equal(escapeHtml('Пальто <oversize> & шарф'), 'Пальто &lt;oversize&gt; &amp; шарф');
  });
});

describe('live service channel — TG-006', () => {
  it('rejects a request with no signature', async (context) => {
    if (!live) return context.skip();
    const response = await fetch(`${API_URL}/bot/claim-notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 1 }),
    });
    assert.equal(response.status, 401);
  });

  it('rejects a request signed with the wrong key', async (context) => {
    if (!live) return context.skip();
    const body = { limit: 1 };
    const response = await fetch(`${API_URL}/bot/claim-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bot-signature': signBody(body, 'not-the-bot-token'),
      },
      body: stableStringify(body),
    });
    assert.equal(response.status, 401);
  });

  it('rejects a signature that does not cover the body actually sent', async (context) => {
    if (!live) return context.skip();
    // Signing one body and sending another is the attack this prevents.
    const response = await fetch(`${API_URL}/bot/claim-notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bot-signature': signBody({ limit: 1 }, TOKEN),
      },
      body: stableStringify({ limit: 50 }),
    });
    assert.equal(response.status, 401);
  });

  it('accepts a correctly signed claim and returns a batch', async (context) => {
    if (!live) return context.skip();
    const api = new ApiClient(API_URL, TOKEN);
    const result = await api.claimNotifications(5);
    assert.ok(Array.isArray(result.items), 'items should be an array');
    for (const job of result.items) {
      assert.ok(job.id, 'every job carries an id');
      assert.ok(job.telegramId, 'every job carries a telegram id');
      assert.ok(typeof job.text === 'string' && job.text.length > 0, 'every job carries text');
      assert.ok(LOCALES.includes(job.locale), `unexpected locale ${job.locale}`);
    }
    await api.releaseNotifications(result.items.map((job) => job.id));
  });

  it('syncs a user from the bot side (TG-006)', async (context) => {
    if (!live) return context.skip();
    const api = new ApiClient(API_URL, TOKEN);
    const telegramId = String(880_000_000 + (Date.now() % 1_000_000));
    const created = await api.syncUser({
      telegramId,
      firstName: 'Bot',
      username: 'bot_test_user',
      languageCode: 'uz',
      chatId: telegramId,
    });
    assert.ok(created.userId, 'a user id comes back');
    assert.equal(created.locale, 'uz', 'the reported language is honoured');
    assert.equal(created.isNewUser, true);

    // Idempotent: the same Telegram id is the same shopper.
    const again = await api.syncUser({ telegramId, firstName: 'Bot' });
    assert.equal(again.userId, created.userId);
    assert.equal(again.isNewUser, false);
  });

  it('serves the /start context, localised and live (§7.2)', async (context) => {
    if (!live) return context.skip();
    const api = new ApiClient(API_URL, TOKEN);
    for (const locale of LOCALES) {
      const result = await api.context({ locale });
      assert.ok(Array.isArray(result.categories), `${locale}: categories`);
      assert.ok(Array.isArray(result.brands), `${locale}: brands`);
      assert.ok(result.stylistSuggestions.length > 0, `${locale}: stylist suggestions`);
      for (const category of result.categories) {
        // Every deep link the bot puts on a button must be a valid one.
        assert.match(category.deepLink, /^[A-Za-z0-9_-]+$/);
        assert.ok(deepLinkToRoute(decodeDeepLink(category.deepLink)).startsWith('/'));
      }
    }
  });

  it('claims a batch exclusively, so two senders cannot double-send (NTF-002)', async (context) => {
    if (!live) return context.skip();
    const api = new ApiClient(API_URL, TOKEN);

    const first = await api.claimNotifications(3);
    if (first.items.length === 0) return context.skip();
    const second = await api.claimNotifications(3);

    try {
      const firstIds = new Set(first.items.map((job) => job.id));
      const overlap = second.items.filter((job) => firstIds.has(job.id));
      assert.deepEqual(
        overlap.map((job) => job.id),
        [],
        'a second claim returned notifications the first already owns',
      );
    } finally {
      // Give them back, exactly as a sender shutting down would.
      await api.releaseNotifications([...first.items, ...second.items].map((job) => job.id));
    }
  });

  it('releases a claim back to the queue without counting an attempt (NTF-002)', async (context) => {
    if (!live) return context.skip();
    const api = new ApiClient(API_URL, TOKEN);

    const batch = await api.claimNotifications(2);
    if (batch.items.length === 0) return context.skip();
    const ids = batch.items.map((job) => job.id);

    const { released } = await api.releaseNotifications(ids);
    assert.equal(released, ids.length, 'every claimed notification should come back');

    // Released means immediately available again — unlike a failure, which
    // backs off. This is what makes a deploy invisible to the shopper.
    const reclaimed = await api.claimNotifications(25);
    const reclaimedIds = new Set(reclaimed.items.map((job) => job.id));
    for (const id of ids) {
      assert.ok(reclaimedIds.has(id), `released notification ${id} was not handed out again`);
    }
    await api.releaseNotifications([...reclaimedIds]);
  });

  it('re-queues a transient failure behind a backoff rather than losing it (NTF-002)', async (context) => {
    if (!live) return context.skip();
    const api = new ApiClient(API_URL, TOKEN);

    const batch = await api.claimNotifications(1);
    if (batch.items.length === 0) return context.skip();
    const job = batch.items[0];

    await api.reportNotification({ id: job.id, sent: false, error: 'socket hang up' });

    // It is queued again — but behind a backoff, so an immediate claim must
    // not pick it straight back up and spin.
    const immediate = await api.claimNotifications(25);
    assert.ok(
      !immediate.items.some((item) => item.id === job.id),
      'a just-failed notification came back immediately instead of backing off',
    );
    await api.releaseNotifications(immediate.items.map((item) => item.id));
  });

  it('suppresses a blocked recipient instead of retrying forever (TG-005)', async (context) => {
    if (!live) return context.skip();
    const api = new ApiClient(API_URL, TOKEN);

    const batch = await api.claimNotifications(1);
    if (batch.items.length === 0) return context.skip();
    const job = batch.items[0];

    await api.reportNotification({
      id: job.id,
      sent: false,
      error: 'bot_blocked',
      blocked: true,
    });

    // Suppressed is terminal: it must never be handed out again.
    const after = await api.claimNotifications(50);
    assert.ok(
      !after.items.some((item) => item.id === job.id),
      'a suppressed notification was handed out again',
    );
    await api.releaseNotifications(after.items.map((item) => item.id));
  });

  it('records a block so the queue stops producing for that shopper (TG-005)', async (context) => {
    if (!live) return context.skip();
    const api = new ApiClient(API_URL, TOKEN);
    const telegramId = String(881_000_000 + (Date.now() % 1_000_000));
    await api.syncUser({ telegramId, firstName: 'Blocked' });
    const blocked = await api.reportBlocked(telegramId, true);
    assert.deepEqual(blocked, { ok: true });
    const unblocked = await api.reportBlocked(telegramId, false);
    assert.deepEqual(unblocked, { ok: true });
  });
});

after(() => {
  if (live) console.log(`  (live checks ran against ${API_URL})`);
});
