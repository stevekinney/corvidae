import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import githubDark from '@shikijs/themes/github-dark';

import type { Rgb } from '../tokens/runtime/contrast/index.ts';

import {
  AA_TEXT,
  contrastRatio,
  decodeSrgb,
  relativeLuminance,
  wcagLuminance,
} from '../tokens/runtime/contrast/index.ts';
import * as values from './check-token-contrast-test-values.ts';

const { readOklchToken, surfaceInset } = values;

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` into linear sRGB, ignoring alpha. */
function hexToLinearRgb(hex: string): Rgb {
  const digits = hex.replace('#', '');
  const full =
    digits.length === 3 ? digits.replaceAll(/./g, (digit) => digit + digit) : digits.slice(0, 6);
  const channel = (offset: number): number =>
    decodeSrgb(Number.parseInt(full.slice(offset, offset + 2), 16) / 255);
  return [channel(0), channel(2), channel(4)];
}

/** Every foreground color the `github-dark` theme paints text with: tokens and the default. */
function githubDarkForegrounds(): ReadonlyMap<string, string> {
  const foregrounds = new Map<string, string>();
  const defaultForeground = githubDark.colors?.['editor.foreground'];
  if (defaultForeground !== undefined) foregrounds.set('editor.foreground', defaultForeground);
  for (const rule of githubDark.tokenColors ?? []) {
    const foreground = rule.settings?.foreground;
    // A rule that paints its own background (the invalid-character marker) never sits on the inset.
    if (foreground === undefined || rule.settings?.background !== undefined) continue;
    const scope = Array.isArray(rule.scope) ? rule.scope.join(', ') : (rule.scope ?? 'unscoped');
    foregrounds.set(`${scope} ${foreground}`, foreground);
  }
  return foregrounds;
}

/**
 * The dark values `code-block.css` lifts: each `span[style*='--shiki-dark:#rrggbb' i]` rule that
 * reassigns `--shiki-dark` to a Cinder token, keyed by the lowercase hex it replaces.
 */
function liftedDarkColors(): ReadonlyMap<string, string> {
  const css = readFileSync(
    new URL('../components/code-block/code-block.css', import.meta.url),
    'utf8',
  );
  const lifted = new Map<string, string>();
  const rule =
    /span\[style\*='--shiki-dark:(#[0-9a-f]{6})' i\]\s*\{\s*--shiki-dark:\s*var\((--cinder-[a-z-]+)\)\s*!important;/gi;
  for (const match of css.matchAll(rule)) {
    lifted.set((match[1] ?? '').toLowerCase(), match[2] ?? '');
  }
  return lifted;
}

describe('dark code-block contrast (COR-2308 inset at 21%)', () => {
  // The code-block ground is `--cinder-surface-inset` in the dark arm (code-block.css), which the
  // design moved from 11% to 18% lightness (COR-2010) and COR-2308's neutral ladder lifts to 21%
  // (hue 265, chroma 0.012). Shiki's `github-dark` token colors were chosen against a near-black
  // field, so the move is adopted only while every one of them still clears AA text on the lighter
  // ground: the dimmest unlifted token color, #ea4a5a, reads 4.75:1 on the 21% inset.
  const inset = surfaceInset.dark;
  const insetLuminance = wcagLuminance(inset);

  it('the dark inset is the 21% band the neutral ladder draws', () => {
    expect(inset.l).toBeCloseTo(0.21, 5);
  });

  it('every github-dark token color clears AA text on the dark inset', () => {
    const foregrounds = githubDarkForegrounds();
    const lifted = liftedDarkColors();
    expect(foregrounds.size).toBeGreaterThan(5);
    for (const [label, hex] of foregrounds) {
      const lift = lifted.get(hex.toLowerCase());
      const luminance =
        lift === undefined
          ? relativeLuminance(hexToLinearRgb(hex))
          : wcagLuminance(readOklchToken(lift).dark);
      expect(
        contrastRatio(luminance, insetLuminance),
        `${label} on the dark inset${lift === undefined ? '' : ` (lifted to ${lift})`}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('lifts the comment color, which falls under AA on the 21% inset without it (3.68:1)', () => {
    const lifted = liftedDarkColors();
    expect([...lifted.keys()]).toEqual(['#6a737d', '#9ecbff']);
    const unlifted = contrastRatio(relativeLuminance(hexToLinearRgb('#6a737d')), insetLuminance);
    expect(unlifted).toBeLessThan(AA_TEXT);
  });

  it('lifts the string color to the success text role, so a JSON key and string differ in hue', () => {
    // github-dark paints keys #79b8ff and strings #9ecbff: two steps of one blue. The design draws
    // keys blue and strings green.
    expect(liftedDarkColors().get('#9ecbff')).toBe('--cinder-status-success-text');
  });

  it('the amber a numeric literal is lifted to clears AA text on the dark inset', () => {
    // code-block.css lifts a marked number from the key blue to this fill (row 07s).
    expect(
      contrastRatio(
        wcagLuminance(readOklchToken('--cinder-status-warning-solid').dark),
        insetLuminance,
      ),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('Cinder text tokens clear AA text on the dark inset', () => {
    for (const token of [
      '--cinder-text-default',
      '--cinder-text-muted',
      '--cinder-text-subtle',
      '--cinder-accent-text',
    ]) {
      const foreground = readOklchToken(token).dark;
      expect(
        contrastRatio(wcagLuminance(foreground), insetLuminance),
        `${token} on the dark inset`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe('dark json-highlight and line notes on the code block (row 07s, COR-2012)', () => {
  const inset = surfaceInset.dark;
  const insetLuminance = wcagLuminance(inset);

  it('every json-highlight token color clears AA text on the dark inset', () => {
    // `json-highlight.css` colors a JSON code block with these roles; the dark code block is the
    // surface it is drawn on.
    for (const token of [
      '--cinder-accent-text',
      '--cinder-status-success-text',
      '--cinder-status-warning-text',
      '--cinder-status-info-text',
      '--cinder-text-muted',
    ]) {
      expect(
        contrastRatio(wcagLuminance(readOklchToken(token).dark), insetLuminance),
        `${token} on the dark inset`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('json-highlight.css colors its tokens only with those roles', () => {
    const css = readFileSync(new URL('./components/json-highlight.css', import.meta.url), 'utf8');
    const roles = new Set(
      [...css.matchAll(/color:\s*var\((--cinder-[a-z-]+)\)/g)].map((m) => m[1]),
    );
    expect([...roles].sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      '--cinder-accent-text',
      '--cinder-status-info-text',
      '--cinder-status-success-text',
      '--cinder-status-warning-text',
      '--cinder-text-muted',
    ]);
  });

  it('a line note and its tinted row stay legible in both themes', () => {
    for (const tone of ['danger', 'warning', 'info']) {
      for (const arm of ['light', 'dark'] as const) {
        const text = wcagLuminance(readOklchToken(`--cinder-status-${tone}-text`)[arm]);
        const tint = wcagLuminance(readOklchToken(`--cinder-status-${tone}-background`)[arm]);
        expect(
          contrastRatio(text, tint),
          `${tone} note text on its tint (${arm})`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('a muted line number clears AA on the code block ground in both themes', () => {
    for (const arm of ['light', 'dark'] as const) {
      const ground =
        arm === 'dark' ? surfaceInset.dark : readOklchToken('--cinder-surface-raised').light;
      expect(
        contrastRatio(
          wcagLuminance(readOklchToken('--cinder-text-muted')[arm]),
          wcagLuminance(ground),
        ),
        `line numbers (${arm})`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
