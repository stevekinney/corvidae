/**
 * Every text token against every surface it is drawn on, in both themes (owner, 2026-11-19: light
 * mode read "faded", with secondary text light grey on light grey and borders that barely showed).
 * Body and secondary text hold WCAG AA, 4.5:1, on every surface a page puts them on; the edges that
 * mark a control, the selected row and the page against its panels hold 3:1, the non-text contrast
 * a person needs to see where one thing ends. A translucent edge is composited over the surface it
 * sits on before it is measured.
 */
import { describe, expect, test } from 'bun:test';

import {
  readOklchToken,
  readTranslucentToken,
  translucentContrastOn,
} from './token-contrast-test-readers.ts';

/** The text a page sets in body copy and in secondary lines: AA, 4.5:1. */
const TEXT = ['--cinder-text-default', '--cinder-text-muted', '--cinder-text-subtle'] as const;

/** The surfaces that text sits on: the page, the panels on it, a well, a hovered and a chosen row. */
const SURFACES = [
  '--cinder-surface-canvas',
  '--cinder-surface',
  '--cinder-surface-raised',
  '--cinder-surface-inset',
  '--cinder-surface-hover',
  '--cinder-selected-background',
] as const;

/** The edges that must read at a glance: a control's and a strong divider's, 3:1. */
const EDGES = ['--cinder-border-control', '--cinder-border-contrast'] as const;

/** The surfaces a panel or a control is drawn on. */
const EDGE_SURFACES = ['--cinder-surface-canvas', '--cinder-surface', '--cinder-surface-raised'];

const THEMES = ['light', 'dark'] as const;

/** A token as a translucent colour, alpha 1 where it is opaque. */
function paint(token: string, theme: (typeof THEMES)[number]) {
  try {
    return readTranslucentToken(token, { opaqueArms: ['light', 'dark'] })[theme];
  } catch {
    return { ...readOklchToken(token)[theme], alpha: 1 };
  }
}

describe('text on every surface it is drawn on, in both themes', () => {
  for (const theme of THEMES) {
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        test(`${theme}: ${text} on ${surface} holds 4.5:1`, () => {
          const ratio = translucentContrastOn(paint(text, theme), readOklchToken(surface)[theme]);
          expect(ratio, `${text} on ${surface} in ${theme}`).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

describe('the edges that must read at a glance, in both themes', () => {
  for (const theme of THEMES) {
    for (const edge of EDGES) {
      for (const surface of EDGE_SURFACES) {
        test(`${theme}: ${edge} on ${surface} holds 3:1`, () => {
          const ratio = translucentContrastOn(paint(edge, theme), readOklchToken(surface)[theme]);
          expect(ratio, `${edge} on ${surface} in ${theme}`).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }
});

// Owner, 2026-11-19: the page ground, the list pane and the detail pane were near-identical pale
// greys, and the selected item was a thin outline.
describe('light mode is not faded', () => {
  const light = (token: string) => readOklchToken(token).light;

  // The light canvas is one step below the white panels. The focus ring has its own contrast test.
  test('the content surface is white against a page ground a step darker, outlined by an edge that reads', () => {
    expect(light('--cinder-surface').l).toBeGreaterThanOrEqual(0.995);
    expect(light('--cinder-surface').l - light('--cinder-surface-canvas').l).toBeGreaterThanOrEqual(
      0.028,
    );
    expect(paint('--cinder-border', 'light').alpha).toBeGreaterThanOrEqual(0.16);
  });

  test('primary text is near-black', () => {
    expect(light('--cinder-text-default').l).toBeLessThanOrEqual(0.18);
  });

  test('a selected row is a real fill, a clear step from the surface and tinted with the accent', () => {
    const selected = light('--cinder-selected-background');
    expect(light('--cinder-surface').l - selected.l).toBeGreaterThanOrEqual(0.06);
    expect(selected.c).toBeGreaterThanOrEqual(0.05);
  });

  test('the accent is saturated', () => {
    expect(light('--cinder-accent-solid').c).toBeGreaterThanOrEqual(0.2);
  });

  test('a container edge reads at a glance on the white surface', () => {
    const border = paint('--cinder-border', 'light');
    expect(border.alpha).toBeGreaterThanOrEqual(0.16);
  });
});
