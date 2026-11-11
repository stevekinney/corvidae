/**
 * COR-2287 (Chat board row T1): the dark danger ink reads as red, not pink-white, and keeps its
 * contrast. The board draws the text at about oklch(76% .15 25) and the border at oklch(62% .17 25);
 * chroma 0.15 at 76% leaves sRGB (its red channel is about 1.03 in linear light), so the text ships
 * the in-gamut step the row accepts, chroma 0.14.
 *
 * Ratios at the time of writing, computed from the shipped resolved values (WCAG luminance of the
 * clamped linear sRGB):
 *
 * | Pairing (dark)                                  | Ratio  | Floor |
 * | ----------------------------------------------- | ------ | ----- |
 * | danger text on the danger background (25.3%)    | 7.03:1 | 4.5:1 |
 * | danger text on the surface (18.5%)              | 8.19:1 | 4.5:1 |
 * | danger text on raised (23.5%)                   | 7.33:1 | 4.5:1 |
 * | danger border on the danger background          | 4.05:1 | 3:1   |
 * | danger border on the surface                    | 4.72:1 | 3:1   |
 * | danger border on raised                         | 4.22:1 | 3:1   |
 */

import { describe, expect, it } from 'bun:test';

import {
  AA_TEXT,
  NON_TEXT,
  contrastRatio,
  isInSrgbGamut,
  wcagLuminance,
} from '../tokens/runtime/contrast/index.ts';
import * as values from './check-token-contrast-test-values.ts';

const { bg, dangerBg, dangerBorder, dangerFg, surface, surfaceInset, surfaceRaised } = values;

const darkGrounds = {
  'danger background': dangerBg.dark,
  canvas: bg.dark,
  surface: surface.dark,
  inset: surfaceInset.dark,
  raised: surfaceRaised.dark,
} as const;

describe('COR-2287: dark danger contrast', () => {
  it('ships the board values: text oklch(76% .14 25), border oklch(62% .17 25)', () => {
    expect(dangerFg.dark).toEqual({ l: 0.76, c: 0.14, h: 25 });
    expect(dangerBorder.dark).toEqual({ l: 0.62, c: 0.17, h: 25 });
  });

  it('keeps both inside sRGB, so nothing is clamped on the way to the screen', () => {
    expect(isInSrgbGamut(dangerFg.dark)).toBe(true);
    expect(isInSrgbGamut(dangerBorder.dark)).toBe(true);
  });

  for (const [groundName, ground] of Object.entries(darkGrounds)) {
    it(`the danger text clears 4.5:1 on the ${groundName}`, () => {
      expect(
        contrastRatio(wcagLuminance(dangerFg.dark), wcagLuminance(ground)),
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`the danger border clears 3:1 on the ${groundName}`, () => {
      expect(
        contrastRatio(wcagLuminance(dangerBorder.dark), wcagLuminance(ground)),
      ).toBeGreaterThanOrEqual(NON_TEXT);
    });
  }

  it('reads as red: the text keeps a real chroma instead of the old near-neutral pink', () => {
    // The previous dark danger text was oklch(90% .05 25), close enough to white that a danger row
    // read as default text on a tinted ground.
    expect(dangerFg.dark.c).toBeGreaterThanOrEqual(0.14);
    expect(dangerFg.dark.l).toBeLessThanOrEqual(0.8);
  });
});
