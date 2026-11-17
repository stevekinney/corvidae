/**
 * The translucent ground (`.cinder-translucent-surface`, AppBar's recipe) lets the page beneath
 * show through, so the text on it must hold its contrast over the worst thing that can be there.
 * The ground is the canvas at `--_cinder-app-bar-mix`, and what shows through is the rest: the
 * worst case is the darkest or the lightest thing the page can paint, pure black or pure white,
 * whichever is further from the text. Blur softens detail but gives no contrast credit, so none is
 * counted. A title and each status line must stay at 4.5:1 (WCAG 1.4.3, normal text) in both
 * themes, so a mix that is lowered later fails here instead of in a capture.
 */
import { describe, expect, test } from 'bun:test';

import { readOklchToken } from '../../styles/token-contrast-test-readers.ts';
import { declarationsFor } from '../../test/css.ts';
import {
  clampRgb,
  compositeOver,
  contrastRatio,
  oklchToLinearSrgb,
  relativeLuminance,
  type OklchColor,
  type Rgb,
} from '../../tokens/runtime/contrast/index.ts';

const css = await Bun.file(new URL('./app-bar.css', import.meta.url)).text();
const mix =
  Number.parseFloat(
    declarationsFor(css, '.cinder-translucent-surface').get('--_cinder-translucent-surface-mix') ??
      'NaN',
  ) / 100;

const toRgb = (color: OklchColor): Rgb => clampRgb(oklchToLinearSrgb(color.l, color.c, color.h));
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [1, 1, 1];

const canvas = readOklchToken('--cinder-surface-canvas');
const TEXT = [
  '--cinder-text-default',
  '--cinder-text-muted',
  '--cinder-status-info-text',
  '--cinder-status-success-text',
  '--cinder-status-warning-text',
  '--cinder-status-danger-text',
] as const;

/** The least contrast `ink` has over the canvas mixed with pure black or pure white. */
function worstContrast(ink: OklchColor, ground: OklchColor): number {
  return Math.min(
    ...[BLACK, WHITE].map((backdrop) => {
      const painted = compositeOver(toRgb(ground), backdrop, mix);
      return contrastRatio(relativeLuminance(toRgb(ink)), relativeLuminance(painted));
    }),
  );
}

describe('the translucent surface', () => {
  test('mixes the canvas at a share the contrast below was measured at', () => {
    expect(mix).toBeGreaterThan(0.5);
    expect(mix).toBeLessThanOrEqual(1);
  });

  for (const arm of ['light', 'dark'] as const) {
    for (const name of TEXT) {
      test(`${name} holds 4.5:1 over the worst backdrop in the ${arm} theme`, () => {
        expect(worstContrast(readOklchToken(name)[arm], canvas[arm])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test('falls back to the solid canvas under reduced transparency', () => {
    const reduced = css.slice(
      css.indexOf('@media (prefers-reduced-transparency: reduce)'),
      css.indexOf('.cinder-app-bar__leading'),
    );
    expect(reduced).toMatch(
      /\.cinder-translucent-surface\s*\{\s*background: var\(--cinder-surface-canvas\);\s*backdrop-filter: none;/,
    );
  });
});
