/**
 * The selected vertical row has a fill of its own (owner, 2026-11-16). Since 2026-11-15 the light
 * sidebar surface and the raised surface are both white, so the raised pill the row used to take
 * vanished into the sidebar. These resolve the colours the row paints from the token corpus and pin
 * that the selected fill stands apart from the sidebar and from the hover tint, with an AA label.
 */
import { describe, expect, test } from 'bun:test';

import { declarationsFor } from '@lostgradient/component-tooling/test/css.ts';
import { readOklchToken } from '@lostgradient/tokens/styles/token-contrast-test-readers.ts';
import {
  AA_TEXT,
  type OklchColor,
  type Rgb,
  clampRgb,
  compositeOver,
  contrastRatio,
  oklchToLinearSrgb,
  relativeLuminance,
  wcagLuminance,
} from '@lostgradient/tokens/tokens/runtime/contrast/index.ts';

const navigationItemCss = await Bun.file(new URL('./navigation-item.css', import.meta.url)).text();

const SELECTED = ".cinder-navigation-item[data-variant='vertical'][data-active='true']";

function linear(color: OklchColor): Rgb {
  return clampRgb(oklchToLinearSrgb(color.l, color.c, color.h));
}

/** The 4% ink a hovered, unselected vertical row paints over the sidebar surface. */
function hoverOver(surface: OklchColor, arm: 'light' | 'dark'): number {
  const ink = readOklchToken('--cinder-border-ink')[arm];
  return relativeLuminance(compositeOver(linear(ink), linear(surface), 0.04));
}

describe('selected vertical NavigationItem fill', () => {
  test('is the one selected fill, at rest and on hover', () => {
    expect(declarationsFor(navigationItemCss, SELECTED).get('background-color')).toBe(
      'var(--cinder-selected-background)',
    );
    // The hover rule for the selected row lives inside `@media (hover: hover)`.
    expect(navigationItemCss).toMatch(
      /\[data-variant='vertical'\]\[data-active='true'\]:hover \{\s*background-color: var\(--cinder-selected-background\);/,
    );
  });

  test('is the same fill a selected StackedListItem paints, so the app has one selected recipe', async () => {
    const stackedListItemCss = await Bun.file(
      new URL(
        '../../../../data-list/src/components/stacked-list-item/stacked-list-item.css',
        import.meta.url,
      ),
    ).text();
    expect(
      declarationsFor(
        stackedListItemCss,
        '.cinder-stacked-list-item.cinder-stacked-list-item--selected',
      ).get('background'),
    ).toBe('var(--cinder-selected-background)');
    const tokensCss = await Bun.file(
      new URL('../../../../tokens/src/styles/tokens-base.css', import.meta.url),
    ).text();
    expect(tokensCss).toContain('--cinder-selected-background: var(--cinder-accent-background);');
  });

  test('the hover rule for unselected rows is the 4% ink this test composites', () => {
    expect(navigationItemCss).toContain(
      'background-color: color-mix(in oklch, var(--cinder-border-ink), transparent 96%);',
    );
  });

  // `--cinder-selected-background` is `--cinder-accent-background`, which mixes the accent into
  // `--cinder-surface`, the sidebar's own surface, so its resolved value is the colour the row
  // paints in the sidebar.
  const fill = readOklchToken('--cinder-selected-background');
  const surface = readOklchToken('--cinder-surface');
  const label = readOklchToken('--cinder-text-default');

  for (const arm of ['light', 'dark'] as const) {
    test(`${arm}: the selected fill stands a visible step off the sidebar surface`, () => {
      // The white pill on the white light sidebar measured 1.00:1; the tint measures 1.18:1 in
      // light and 1.16:1 in dark (the dark raised pill it replaces measured 1.12:1).
      expect(
        contrastRatio(wcagLuminance(fill[arm]), wcagLuminance(surface[arm])),
      ).toBeGreaterThanOrEqual(1.14);
    });

    test(`${arm}: the selected fill reads apart from the hover tint`, () => {
      // 1.09:1 in light and 1.06:1 in dark; the dark raised pill measured 1.02:1.
      expect(
        contrastRatio(wcagLuminance(fill[arm]), hoverOver(surface[arm], arm)),
      ).toBeGreaterThanOrEqual(1.05);
    });

    test(`${arm}: the label clears AA text on the selected fill`, () => {
      expect(
        contrastRatio(wcagLuminance(label[arm]), wcagLuminance(fill[arm])),
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test(`${arm}: the selected fill carries the accent hue, so it is a tint and not a grey`, () => {
      expect(fill[arm].c).toBeGreaterThanOrEqual(0.02);
    });
  }
});
