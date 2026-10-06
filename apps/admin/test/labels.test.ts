/**
 * Coverage for the operator surface's vocabularies.
 *
 * Every one of these tests exists because the thing it checks was wrong at
 * least once. A label map written from memory looks complete, compiles, and
 * then renders SELLER_PAYABLE_REVERSAL in front of a shopkeeper; a status list
 * written from memory offers an option the API answers with a 422. Both
 * happened. The fix in each case was to derive the list from the state machines
 * in @fashion/core — and these tests are what keeps it derived.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  LEDGER_EVENTS,
  ORDER_STATUSES,
  PERMISSIONS,
  PRODUCT_LIFECYCLE,
  RETURN_STATUSES,
  ROLE_PERMISSIONS,
  SUBORDER_STATUSES,
} from '@fashion/core';
import {
  SELLER_EVENT_LABELS,
  sellerEventLabel,
  sellerEventTone,
  sellerMemo,
} from '../src/lib/ledger-labels';
import {
  LIFECYCLE_OPTIONS,
  ORDER_STATUS_OPTIONS,
  PAYOUT_STATUSES,
  RETURN_STATUS_OPTIONS,
  SELLER_ONBOARDING_STATUSES,
  SUBORDER_STATUS_OPTIONS,
  lifecycleLabel,
  onboardingLabel,
  payoutLabel,
  returnLabel,
} from '../src/lib/status';

describe('ledger event labels', () => {
  it('names every event the ledger can post', () => {
    const missing = LEDGER_EVENTS.filter((event) => !(event in SELLER_EVENT_LABELS));
    assert.deepEqual(missing, [], `no seller-facing label for: ${missing.join(', ')}`);
  });

  it('invents no label for an event that does not exist', () => {
    const extra = Object.keys(SELLER_EVENT_LABELS).filter(
      (key) => !(LEDGER_EVENTS as readonly string[]).includes(key),
    );
    assert.deepEqual(extra, [], `labels for unknown events: ${extra.join(', ')}`);
  });

  it('never shows a raw enum name to a seller', () => {
    for (const event of LEDGER_EVENTS) {
      const label = sellerEventLabel(event);
      assert.notEqual(label, event, `${event} falls through to its enum name`);
      assert.ok(!/^[A-Z_]+$/.test(label), `${event} renders as shouting: ${label}`);
    }
  });

  it('gives every event a tone, and only the adjustment the alarming one', () => {
    for (const event of LEDGER_EVENTS) {
      assert.notEqual(sellerEventTone(event), 'neutral', `${event} has no tone`);
    }
    // A refund is ordinary business; an adjustment is the one worth a red flag,
    // because it moved a balance outside the normal flow of orders.
    assert.equal(sellerEventTone('REFUND_GROSS'), 'warn');
    assert.equal(sellerEventTone('ADJUSTMENT'), 'danger');
  });
});

describe('seller-facing memos', () => {
  it('shows the document reference a seller can look up', () => {
    assert.equal(
      sellerMemo('SELLER_PAYABLE_REVERSAL for refund RF-2026-00011'),
      'RF-2026-00011',
    );
    assert.equal(sellerMemo('SALE_GROSS for order FM-261006-0012'), 'FM-261006-0012');
  });

  it('drops an enum prefix that duplicates the event column', () => {
    assert.equal(sellerMemo('PLATFORM_COMMISSION charged at 10%'), 'charged at 10%');
  });

  it('leaves ordinary text alone and empties to nothing', () => {
    assert.equal(sellerMemo('Компенсация за просрочку'), 'Компенсация за просрочку');
    assert.equal(sellerMemo(null), null);
    assert.equal(sellerMemo(''), null);
    assert.equal(sellerMemo('ADJUSTMENT'), null);
  });
});

describe('status vocabularies come from the state machines', () => {
  it('offers exactly the order statuses the machine knows', () => {
    assert.deepEqual(
      ORDER_STATUS_OPTIONS.map((option) => option.value),
      [...ORDER_STATUSES],
    );
  });

  it('offers exactly the suborder statuses the machine knows', () => {
    assert.deepEqual(
      SUBORDER_STATUS_OPTIONS.map((option) => option.value),
      [...SUBORDER_STATUSES],
    );
  });

  it('offers exactly the return statuses the machine knows', () => {
    assert.deepEqual(
      RETURN_STATUS_OPTIONS.map((option) => option.value),
      [...RETURN_STATUSES],
    );
  });

  it('offers exactly the product lifecycle states the machine knows', () => {
    assert.deepEqual(
      LIFECYCLE_OPTIONS.map((option) => option.value),
      [...PRODUCT_LIFECYCLE],
    );
  });
});

describe('every offered status has a label', () => {
  it('labels return statuses', () => {
    for (const status of RETURN_STATUSES) {
      assert.notEqual(returnLabel(status), status, `${status} has no label`);
    }
  });

  it('labels product lifecycle states', () => {
    for (const lifecycle of PRODUCT_LIFECYCLE) {
      assert.notEqual(lifecycleLabel(lifecycle), lifecycle, `${lifecycle} has no label`);
    }
  });

  it('labels seller onboarding states', () => {
    for (const status of SELLER_ONBOARDING_STATUSES) {
      assert.notEqual(onboardingLabel(status), status, `${status} has no label`);
    }
  });

  it('labels payout states', () => {
    for (const status of PAYOUT_STATUSES) {
      assert.notEqual(payoutLabel(status), status, `${status} has no label`);
    }
  });
});

describe('the permission model the panel gates on', () => {
  /**
   * ADM-005 is dual control, not escalation. If the finance role loses its
   * approve permissions, the only possible checker becomes a super admin and
   * every refund turns into an escalation — which is how separation of duties
   * gets quietly dropped in practice.
   */
  it('lets two finance operators check each other', () => {
    const finance = ROLE_PERMISSIONS.FINANCE_OPERATOR as readonly string[];
    for (const permission of ['payout:create', 'payout:approve', 'adjustment:write', 'adjustment:approve']) {
      assert.ok(finance.includes(permission), `FINANCE_OPERATOR is missing ${permission}`);
    }
  });

  it('keeps money away from the roles that should not touch it', () => {
    for (const role of ['CATALOG_MANAGER', 'SUPPORT_AGENT', 'CONTENT_MANAGER'] as const) {
      const granted = ROLE_PERMISSIONS[role] as readonly string[];
      for (const permission of ['ledger:read', 'payout:create', 'payout:approve', 'adjustment:write']) {
        assert.ok(!granted.includes(permission), `${role} should not hold ${permission}`);
      }
    }
  });

  /**
   * A seller holds ledger:read and order:read for their own cabinet, which is
   * exactly why the platform endpoints cannot be guarded on permissions alone
   * — they are guarded on the surface too (PlatformOnly). This test records
   * the overlap so it is understood rather than discovered.
   */
  it('records that seller roles overlap the platform ones', () => {
    const owner = ROLE_PERMISSIONS.SELLER_OWNER as readonly string[];
    assert.ok(owner.includes('ledger:read'), 'a seller reads their own ledger');
    assert.ok(owner.includes('order:read'), 'a seller reads their own orders');
    assert.ok(!owner.includes('seller:read'), 'a seller does not list other sellers');
    assert.ok(!owner.includes('audit:read'), 'a seller does not read the platform audit trail');
  });

  it('gates on permissions that exist', () => {
    const all = new Set<string>(PERMISSIONS);
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      if ((granted as readonly string[])[0] === '*') continue;
      for (const permission of granted as readonly string[]) {
        assert.ok(all.has(permission), `${role} grants unknown permission ${permission}`);
      }
    }
  });
});
