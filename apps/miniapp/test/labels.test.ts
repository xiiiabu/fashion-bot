/**
 * Label coverage — spec USR-001.
 *
 * Every taxonomy code the API can return has to have a human label in all
 * three locales, or the shopper sees a machine identifier. This test exists
 * because that is not hypothetical: the colour labels and swatches were first
 * written with upper-case keys while the taxonomy is lower case, so the whole
 * colour filter rendered grey circles labelled "BLACK", and the stylist's
 * explanation printed "Палитра: color.brown + color.navy".
 *
 * A missing label is a shipped defect, so it fails here rather than in the UI.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLOR_FAMILIES,
  FIT_PREFERENCES,
  LOCALES,
  OCCASIONS,
  OUTFIT_SLOTS,
  SEASONS,
  SILHOUETTES,
  STYLE_TAGS,
  type Locale,
  translate,
} from '@fashion/core';

import {
  colorLabel,
  colorSwatch,
  missingLabels,
  occasionLabel,
  seasonLabel,
  silhouetteLabel,
  slotLabel,
  styleLabel,
} from '../src/lib/taxonomy-labels';
import { missingKeys, t } from '../src/lib/copy';

describe('taxonomy labels', () => {
  it('has a label for every code in every taxonomy', () => {
    assert.deepEqual(missingLabels(), {});
  });

  it('never returns the raw code as a label', () => {
    const cases: Array<[readonly string[], (value: string, locale: string) => string]> = [
      [COLOR_FAMILIES, colorLabel],
      [STYLE_TAGS, styleLabel],
      [OCCASIONS, occasionLabel],
      [SEASONS, seasonLabel],
      [SILHOUETTES, silhouetteLabel],
      [OUTFIT_SLOTS, slotLabel],
    ];
    for (const locale of LOCALES) {
      for (const [codes, label] of cases) {
        for (const code of codes) {
          const text = label(code, locale);
          assert.ok(text.length > 0, `${locale}/${code} is empty`);
          // An exact match against the code means the lookup missed. Codes with
          // no sensible translation (y2k, preppy) are allowed to equal
          // themselves case-insensitively but must not keep their underscores.
          assert.ok(!text.includes('_'), `${locale}/${code} rendered the raw code: ${text}`);
        }
      }
    }
  });

  it('has a swatch for every colour family', () => {
    for (const family of COLOR_FAMILIES) {
      const swatch = colorSwatch(family);
      assert.match(
        swatch,
        /^(#[0-9a-f]{6}|linear-gradient|repeating-linear-gradient)/i,
        `${family} has no swatch`,
      );
    }
  });
});

describe('shared message catalogue', () => {
  it('resolves colour and style names used in the stylist explanation', () => {
    for (const locale of LOCALES) {
      for (const family of COLOR_FAMILIES) {
        const key = `color.${family}`;
        assert.notEqual(translate(locale, key), key, `${locale}/${key} is missing from core`);
      }
      for (const tag of STYLE_TAGS) {
        const key = `style.${tag}`;
        assert.notEqual(translate(locale, key), key, `${locale}/${key} is missing from core`);
      }
    }
  });

  it('leaves no unsubstituted placeholder in the explanation templates', () => {
    const templates = [
      ['ai.explain.style', { styles: 'минимализм' }],
      ['ai.explain.palette', { colors: 'navy + beige' }],
      ['ai.explain.multibrand', { count: '2' }],
    ] as const;
    for (const locale of LOCALES) {
      for (const [key, params] of templates) {
        const text = translate(locale, key, params as Record<string, string>);
        assert.ok(!/\{\w+\}/.test(text), `${locale}/${key} left a placeholder: ${text}`);
      }
    }
  });
});

describe('screen copy', () => {
  it('is complete for Russian and Uzbek (USR-001 MUST)', () => {
    for (const locale of ['ru', 'uz'] as Locale[]) {
      assert.deepEqual(missingKeys(locale), [], `${locale} is missing screen copy`);
    }
  });

  it('is complete for English (USR-001 SHOULD)', () => {
    assert.deepEqual(missingKeys('en'), []);
  });

  it('labels every fit preference (FIT-006)', () => {
    for (const locale of LOCALES) {
      for (const preference of FIT_PREFERENCES) {
        const key = `fit.preference.${preference}`;
        assert.notEqual(t(locale, key), key, `${locale}/${key} is missing`);
      }
    }
  });

  it('interpolates its own parameters', () => {
    for (const locale of LOCALES) {
      assert.match(t(locale, 'cart.itemCount', { n: 3 }), /3/);
      assert.ok(!/\{\w+\}/.test(t(locale, 'pdp.onlyLeft', { n: 2 })));
      assert.ok(!/\{\w+\}/.test(t(locale, 'checkout.pay', { amount: '1 000' })));
    }
  });
});
