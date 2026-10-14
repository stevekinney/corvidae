/**
 * The descending 101-step chroma grid, shared by palette generation (COR-263) and by the
 * foreground remediation algorithm (COR-487), so both reduce chroma the same way.
 *
 * For an OKLCH lightness `l`, hue `h` and original chroma `c`, the candidates are
 * `c * j / 100` for `j = 100 … 0`, largest first. A candidate passes only when converting it
 * to the selected output gamut (sRGB or Display-P3, through Culori) leaves every target RGB
 * channel inside `[0, 1]`. Nothing is clipped: a color that needs clipping is not a candidate.
 * COR-487 narrows "passes" further with its own predicate (every affected contrast pairing);
 * this module only owns the grid and the gamut test.
 *
 * Pure: no DOM, no storage. Culori is the only color engine.
 */

import { converter } from 'culori';

export type OutputGamut = 'srgb' | 'display-p3';

/** Recorded in proposals and reports so a change to the grid invalidates them. */
export const CHROMA_GRID_VERSION = 'oklch-chroma-grid-101/1';

export const CHROMA_GRID_STEPS = 100;

/** Floating-point slack for a channel that sits exactly on the gamut boundary. */
export const GAMUT_EPSILON = 1e-9;

const toSrgb = converter('rgb');
const toDisplayP3 = converter('p3');

export type OklchColor = { l: number; c: number; h: number };

/** The target RGB channels of an OKLCH color in the selected output gamut, unclipped. */
export function targetChannels(color: OklchColor, gamut: OutputGamut): [number, number, number] {
  const source = { mode: 'oklch' as const, l: color.l, c: color.c, h: color.h };
  const converted = gamut === 'srgb' ? toSrgb(source) : toDisplayP3(source);
  return [converted.r, converted.g, converted.b];
}

/** True when every target channel lies in `[0, 1]` (within floating-point slack). */
export function inOutputGamut(color: OklchColor, gamut: OutputGamut): boolean {
  return targetChannels(color, gamut).every(
    (channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON,
  );
}

/** The chroma candidates for an original chroma, largest first: `c * j / 100`, `j = 100 … 0`. */
export function chromaGrid(originalChroma: number): number[] {
  const grid: number[] = [];
  for (let step = CHROMA_GRID_STEPS; step >= 0; step -= 1) {
    grid.push((originalChroma * step) / CHROMA_GRID_STEPS);
  }
  return grid;
}

export type ChromaReduction = {
  /** The largest passing chroma on the grid. */
  chroma: number;
  /** The grid step `j` it came from; 100 means the original chroma already passed. */
  step: number;
};

/**
 * The largest chroma on the grid that stays in the output gamut and that `accepts` (when
 * given). Returns `null` only when no candidate passes, which cannot happen for the gamut
 * test alone at a lightness in `[0, 1]` because chroma 0 is always a gray inside the gamut.
 */
export function largestPassingChroma(
  lightness: number,
  hue: number,
  originalChroma: number,
  gamut: OutputGamut,
  accepts?: (candidate: OklchColor) => boolean,
): ChromaReduction | null {
  const grid = chromaGrid(originalChroma);
  for (const [index, chroma] of grid.entries()) {
    const candidate = { l: lightness, c: chroma, h: hue };
    if (!inOutputGamut(candidate, gamut)) continue;
    if (accepts !== undefined && !accepts(candidate)) continue;
    return { chroma, step: CHROMA_GRID_STEPS - index };
  }
  return null;
}
