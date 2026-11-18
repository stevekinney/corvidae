/**
 * COR-2441: the feature banner's indigo wash is stronger in dark (18%, glow 25%) than in light (9%,
 * glow 18%), because 9% of a dim accent over a dark surface read as a plain dark card. The muted
 * words must still clear 4.5:1 on the wash and on the brightest part of the glow.
 */
import { describe, expect, test } from 'bun:test';

import { readOklchToken } from '../../styles/token-contrast-test-readers.ts';
import {
  AA_TEXT,
  clampRgb,
  compositeOver,
  contrastRatio,
  oklchToLinearSrgb,
  relativeLuminance,
} from '../../tokens/runtime/contrast/index.ts';

const css = await Bun.file(new URL('./banner.css', import.meta.url)).text();

type Arm = 'light' | 'dark';
const WASH = { light: 0.09, dark: 0.18 } as const;
const GLOW = { light: 0.18, dark: 0.25 } as const;

/** `color-mix(in oklch, surface, accent p%)`, interpolated in OKLCH as the browser does. */
function mixedWash(arm: Arm) {
  const surface = readOklchToken('--cinder-surface')[arm];
  const accent = readOklchToken('--cinder-accent-solid')[arm];
  const p = WASH[arm];
  return {
    l: surface.l + (accent.l - surface.l) * p,
    c: surface.c + (accent.c - surface.c) * p,
    h: surface.h + (accent.h - surface.h) * p,
  };
}

function glowOverWash(arm: Arm): number {
  const accent = readOklchToken('--cinder-accent-solid')[arm];
  const wash = mixedWash(arm);
  const painted = compositeOver(
    clampRgb(oklchToLinearSrgb(accent.l, accent.c, accent.h)),
    clampRgb(oklchToLinearSrgb(wash.l, wash.c, wash.h)),
    GLOW[arm],
  );
  return relativeLuminance(painted);
}

function washLuminance(arm: Arm): number {
  const wash = mixedWash(arm);
  return relativeLuminance(clampRgb(oklchToLinearSrgb(wash.l, wash.c, wash.h)));
}

describe('feature banner wash', () => {
  test('the stylesheet gives the wash and the glow a light and a dark arm', () => {
    const feature = css.slice(
      css.indexOf(".cinder-banner[data-cinder-variant='feature'] {"),
      css.indexOf(':dir(rtl)'),
    );
    expect(feature).toMatch(
      /light-dark\(\s*color-mix\(in oklch, var\(--cinder-accent-solid\) 18%, transparent\),\s*color-mix\(in oklch, var\(--cinder-accent-solid\) 25%, transparent\)\s*\)/,
    );
    expect(feature).toMatch(
      /light-dark\(\s*color-mix\(in oklch, var\(--cinder-surface\), var\(--cinder-accent-solid\) 9%\),\s*color-mix\(in oklch, var\(--cinder-surface\), var\(--cinder-accent-solid\) 18%\)\s*\)/,
    );
  });

  test('the dark wash is lighter than the surface by a step a person sees', () => {
    const surface = readOklchToken('--cinder-surface').dark;
    expect(mixedWash('dark').l - surface.l).toBeGreaterThanOrEqual(0.08);
  });

  for (const arm of ['light', 'dark'] as const) {
    const muted = readOklchToken('--cinder-text-muted')[arm];
    const mutedLuminance = relativeLuminance(
      clampRgb(oklchToLinearSrgb(muted.l, muted.c, muted.h)),
    );
    test(`${arm}: the muted words clear 4.5:1 on the wash`, () => {
      expect(contrastRatio(mutedLuminance, washLuminance(arm))).toBeGreaterThanOrEqual(AA_TEXT);
    });
    test(`${arm}: the muted words clear 4.5:1 on the brightest part of the glow`, () => {
      expect(contrastRatio(mutedLuminance, glowOverWash(arm))).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }
});
