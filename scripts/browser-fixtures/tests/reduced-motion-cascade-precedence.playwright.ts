/// <reference lib="dom" />
/**
 * CIN-468: exercise the real token generator in a browser. The two motion
 * contexts intentionally disagree so computed style proves which selector wins.
 * This tooling integration imports the generator script, not a library subpath.
 */

import { expect, test } from '@playwright/test';

import { buildTokensBaseCss } from '../../../components/cinder/scripts/tokens/css-generator.ts';
import type {
  ResolverDocument,
  TokenDocument,
} from '../../../components/cinder/scripts/tokens/types.ts';

const TEST_PROPERTY = '--test-reduced-motion-duration';

/** Builds a fixture corpus whose `reduced` and `forced-reduced-motion` contexts disagree. */
async function buildFixtureCss(): Promise<string> {
  const baseDocument: TokenDocument = {
    duration: {
      $type: 'duration',
      cascade: {
        $value: { value: 5, unit: 'ms' },
        $extensions: { 'com.lostgradient.cinder': { cssProperty: TEST_PROPERTY } },
      },
    },
  };
  const themeDocument: TokenDocument = {};
  const motionDefaultDocument: TokenDocument = {};
  // Deliberately DIFFERENT values -- the real corpus's two motion documents
  // happen to agree today, which is exactly why the cascade bug this test
  // guards against was invisible against the real app.
  const motionReducedDocument: TokenDocument = {
    duration: { $type: 'duration', cascade: { $value: { value: 1, unit: 'ms' } } },
  };
  const motionForcedDocument: TokenDocument = {
    duration: { $type: 'duration', cascade: { $value: { value: 2, unit: 'ms' } } },
  };

  const resolver: ResolverDocument = {
    version: '2025.10',
    sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
    modifiers: {
      theme: {
        contexts: {
          light: [{ $ref: 'theme-light.json' }],
          dark: [{ $ref: 'theme-dark.json' }],
        },
        default: 'light',
      },
      motion: {
        contexts: {
          default: [{ $ref: 'motion-default.json' }],
          reduced: [{ $ref: 'motion-reduced.json' }],
          'forced-reduced-motion': [{ $ref: 'motion-forced.json' }],
        },
        default: 'default',
      },
    },
    resolutionOrder: [
      { $ref: '#/sets/foundation' },
      { $ref: '#/modifiers/theme' },
      { $ref: '#/modifiers/motion' },
    ],
  };

  const documentsByPath = new Map<string, TokenDocument>([
    ['base.json', baseDocument],
    ['theme-light.json', themeDocument],
    ['theme-dark.json', themeDocument],
    ['motion-default.json', motionDefaultDocument],
    ['motion-reduced.json', motionReducedDocument],
    ['motion-forced.json', motionForcedDocument],
  ]);

  return buildTokensBaseCss(resolver, documentsByPath);
}

/** Reads `TEST_PROPERTY`'s resolved value off `:root`, normalised to milliseconds. */
async function rootDurationMs(page: import('@playwright/test').Page): Promise<number> {
  const raw = await page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    TEST_PROPERTY,
  );
  const amount = Number.parseFloat(raw);
  return raw.endsWith('ms') ? amount : amount * 1000;
}

test.describe('reduced-motion block cascade precedence', () => {
  test('the explicit data-reduced-motion="on" override wins over the media block when both match', async ({
    page,
  }) => {
    const css = await buildFixtureCss();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('about:blank');
    await page.addStyleTag({ content: css });

    // Reduced motion remains active for every assertion below.

    // No attribute at all: only the media block's selector can match.
    // Its `reduced` context value (1ms) applies.
    expect(await rootDurationMs(page)).toBe(1);

    // The bug: with the OS preferring reduced motion AND the explicit
    // override set to 'on', the OLD media selector (missing
    // `:not([data-reduced-motion='on'])`) still matched, and its (0,3,0)
    // specificity beat the explicit block's (0,2,0) -- so the media block's
    // `reduced` value (1ms) won instead of the user's explicit
    // `forced-reduced-motion` override (2ms). The fix makes the two blocks
    // mutually exclusive so the explicit override always wins.
    await page.evaluate(() => document.documentElement.setAttribute('data-reduced-motion', 'on'));
    expect(await rootDurationMs(page)).toBe(2);

    // The existing opt-out must keep working: 'off' excludes the media block
    // too, and there is no 'off'-specific block, so this falls back to the
    // base value (5ms) -- neither reduced-motion block applies.
    await page.evaluate(() => document.documentElement.setAttribute('data-reduced-motion', 'off'));
    expect(await rootDurationMs(page)).toBe(5);

    // Removing the attribute returns to the media-block-only state.
    await page.evaluate(() => document.documentElement.removeAttribute('data-reduced-motion'));
    expect(await rootDurationMs(page)).toBe(1);
  });
});
