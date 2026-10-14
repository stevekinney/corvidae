/**
 * The palette generation algorithm (COR-263), pure and deterministic.
 *
 * Given a seed color and the baseline of one family in one concrete context, it proposes an
 * OKLCH value for every role:
 *
 * - Accent and status families keep each role's baseline relative lightness: the role sits at
 *   the same offset from the family anchor as it does in the shipped base, and the anchor is
 *   set to the seed's lightness, chroma, and hue. Lightness is clamped to 0–1.
 * - The neutral family keeps each role's baseline lightness and takes the seed's hue.
 * - Chroma is the baseline chroma times the seed-to-anchor chroma ratio (the seed's chroma
 *   when the anchor has none), then reduced into the selected output gamut by the shared
 *   descending 101-step grid in `theme-chroma-grid.ts`. Nothing is clipped.
 *
 * The baseline is always the resolved, immutable embedded base, so a draft override never
 * moves an offset, an anchor, or a ratio. Alpha is not part of this module: a proposal keeps
 * the alpha the role already has.
 */

import {
  CHROMA_GRID_VERSION,
  inOutputGamut,
  largestPassingChroma,
  type OutputGamut,
} from './theme-chroma-grid.ts';
import { oklchOf, parseColorText, toCulori, type OklchValue } from './theme-color-model.ts';

export const PALETTE_ALGORITHM_VERSION = `palette-oklch/1+${CHROMA_GRID_VERSION}`;

export type PaletteSeed = { l: number; c: number; h: number };

export type SeedResult = { ok: true; seed: PaletteSeed } | { ok: false; message: string };

/** The seed's OKLCH coordinates; a seed's own alpha is ignored because roles keep theirs. */
export function parseSeed(text: string): SeedResult {
  const parsed = parseColorText(text);
  if (!parsed.ok) return parsed;
  const { l, c, h } = oklchOf(toCulori(parsed.color));
  return { ok: true, seed: { l, c, h } };
}

export type RoleBaseline = { path: string; role: string; anchor: boolean; color: OklchValue };

export type GeneratedRole = {
  path: string;
  role: string;
  anchor: boolean;
  baseline: OklchValue;
  /** The proposed OKLCH value, rounded to the precision the editor writes. */
  proposed: { l: number; c: number; h: number };
  /** The chroma the ratio asked for, when the gamut forced a smaller one. */
  requestedChroma: number;
  /** The grid step `j` the chroma came from; 100 means no reduction was needed. */
  gridStep: number;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** The rounding an OKLCH value is written with; the gamut test runs on the rounded value. */
export const roundOklch = (value: { l: number; c: number; h: number }) => ({
  l: round(value.l, 5),
  c: round(value.c, 5),
  h: round(value.h, 3),
});

/** The requested chroma for a role: the baseline scaled by the seed-to-anchor ratio. */
function requestedChroma(role: OklchValue, anchor: OklchValue, seed: PaletteSeed): number {
  if (anchor.c === 0) return seed.c;
  return role.c * (seed.c / anchor.c);
}

export function generateRoles(
  seed: PaletteSeed,
  family: string,
  roles: readonly RoleBaseline[],
  gamut: OutputGamut,
): GeneratedRole[] {
  const anchor = roles.find((role) => role.anchor);
  if (anchor === undefined) return [];
  return roles.map((role) => {
    const lightness =
      family === 'neutral' ? role.color.l : clamp01(seed.l + (role.color.l - anchor.color.l));
    const chroma = Math.max(0, requestedChroma(role.color, anchor.color, seed));
    const reduction = largestPassingChroma(lightness, seed.h, chroma, gamut, (candidate) =>
      inOutputGamut(roundOklch({ ...candidate, h: seed.h }), gamut),
    ) ?? { chroma: 0, step: 0 };
    return {
      path: role.path,
      role: role.role,
      anchor: role.anchor,
      baseline: role.color,
      proposed: roundOklch({ l: lightness, c: reduction.chroma, h: seed.h }),
      requestedChroma: chroma,
      gridStep: reduction.step,
    };
  });
}
