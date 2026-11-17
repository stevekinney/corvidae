/**
 * `--cinder-surface-translucent`, the ground of `.cinder-translucent-surface`, lets the page
 * beneath show through, so the text on it must hold its contrast over the worst thing that can be
 * there. The token is the canvas at its alpha, and what shows through is the rest: the worst case
 * is the darkest or the lightest thing the page can paint, pure black or pure white, whichever is
 * further from the text. Blur softens detail but gives no contrast credit, so none is counted. A
 * title and each status line must stay at 4.5:1 (WCAG 1.4.3, normal text) in both themes, so an
 * alpha that is lowered later fails here instead of in a capture.
 */
import { describe, expect, test } from 'bun:test';

import { readOklchToken, readTranslucentToken } from '../../styles/token-contrast-test-readers.ts';
import {
  clampRgb,
  compositeOver,
  contrastRatio,
  oklchToLinearSrgb,
  relativeLuminance,
  type OklchColor,
  type Rgb,
} from '../../tokens/runtime/contrast/index.ts';

const css = await Bun.file(
  new URL('../../styles/components/_translucent-surface.css', import.meta.url),
).text();
const SHARED_ENTRIES = ['../../styles/index.css', '../../styles/components.css'] as const;

const toRgb = (color: OklchColor): Rgb => clampRgb(oklchToLinearSrgb(color.l, color.c, color.h));
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [1, 1, 1];

const surface = readTranslucentToken('--cinder-surface-translucent');
const canvas = readOklchToken('--cinder-surface-canvas');
const TEXT = [
  '--cinder-text-default',
  '--cinder-text-muted',
  '--cinder-status-info-text',
  '--cinder-status-success-text',
  '--cinder-status-warning-text',
  '--cinder-status-danger-text',
] as const;

/** The least contrast `ink` has over the token painted on pure black or pure white. */
function worstContrast(ink: OklchColor, arm: 'light' | 'dark'): number {
  const ground = surface[arm];
  return Math.min(
    ...[BLACK, WHITE].map((backdrop) => {
      const painted = compositeOver(toRgb(ground), backdrop, ground.alpha);
      return contrastRatio(relativeLuminance(toRgb(ink)), relativeLuminance(painted));
    }),
  );
}

describe('the translucent surface', () => {
  for (const arm of ['light', 'dark'] as const) {
    test(`is the canvas, at a partial alpha, in the ${arm} theme`, () => {
      expect(surface[arm].l).toBeCloseTo(canvas[arm].l, 6);
      expect(surface[arm].c).toBeCloseTo(canvas[arm].c, 6);
      expect(surface[arm].alpha).toBeGreaterThan(0.5);
      expect(surface[arm].alpha).toBeLessThan(1);
    });

    for (const name of TEXT) {
      test(`${name} holds 4.5:1 over the worst backdrop in the ${arm} theme`, () => {
        expect(worstContrast(readOklchToken(name)[arm], arm)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test('paints the token under a blur, and the solid canvas under reduced transparency', () => {
    expect(css).toMatch(
      /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.cinder-translucent-surface \{\s*background: var\(--cinder-surface-translucent\);/,
    );
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-transparency: reduce)'));
    expect(reduced).toMatch(
      /\.cinder-translucent-surface\s*\{\s*background: var\(--cinder-surface-canvas\);\s*backdrop-filter: none;/,
    );
  });

  // A page applies the class by hand, so the rule must reach an application that imports no
  // AppBar: it lived in app-bar.css once, and Interborough's chat header painted no ground at all.
  test('ships with the shared styles every application loads, not in a component stylesheet', async () => {
    for (const entry of SHARED_ENTRIES) {
      const text = await Bun.file(new URL(entry, import.meta.url)).text();
      expect(text).toContain("@import './components/_translucent-surface.css';");
    }
    const appBar = await Bun.file(new URL('./app-bar.css', import.meta.url)).text();
    expect(appBar).not.toMatch(/\.cinder-translucent-surface\s*\{/);
  });
});
