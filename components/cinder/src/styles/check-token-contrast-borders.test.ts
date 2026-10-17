import { describe, expect, it } from 'bun:test';
import type { OklchColor } from '../tokens/runtime/contrast/index.ts';
import type { TranslucentColor } from './token-contrast-test-readers.ts';

import {
  AA_TEXT,
  NON_TEXT,
  contrastRatio,
  wcagLuminance,
} from '../tokens/runtime/contrast/index.ts';
import * as values from './check-token-contrast-test-values.ts';

const {
  accent,
  bg,
  border,
  borderControl,
  borderControlHover,
  borderFaint,
  borderInk,
  borderMuted,
  borderStrong,
  css,
  polarityInk,
  readAllTokenValues,
  readOklchToken,
  surface,
  surfaceInset,
  surfaceRaised,
  translucentContrastOn,
} = values;
describe('focus ring contrast (WCAG 1.4.11)', () => {
  // --cinder-ring-color light arm = oklch(from accent 0.55 0.16 h); dark arm = 0.7 0.14 h.
  it('ring clears 3:1 against the page background (both arms)', () => {
    const ringLight: OklchColor = { l: 0.55, c: 0.16, h: accent.light.h };
    const ringDark: OklchColor = { l: 0.7, c: 0.14, h: accent.dark.h };
    expect(contrastRatio(wcagLuminance(ringLight), wcagLuminance(bg.light))).toBeGreaterThanOrEqual(
      NON_TEXT,
    );
    expect(contrastRatio(wcagLuminance(ringDark), wcagLuminance(bg.dark))).toBeGreaterThanOrEqual(
      NON_TEXT,
    );
  });
});

describe('border-on-surface contrast', () => {
  // The neutral tiers do two jobs. STRUCTURAL tiers (muted, border, strong)
  // separate regions and outline containers; the region is identified by its
  // surface and content, so WCAG 1.4.11 does not apply and they are kept
  // quiet. CONTROL tiers (control, control.hover) are the only visible
  // boundary of an input, checkbox, or radio, so they must clear 3:1.
  //
  // Faint borders are decorative hairlines and only need to stay distinguishable.
  const FAINT_BORDER = 1.1;
  // Every structural tier must stay perceptible; muted, the interior hairline,
  // sits at the faint floor, the others at the decorative one.
  const STRUCTURAL_FLOORS = { 'border.muted': 1.1, border: 1.4, 'border.strong': 1.4 } as const;
  const surfaces = { inset: surfaceInset, bg, surface, raised: surfaceRaised } as const;
  const structuralTiers = {
    'border.muted': borderMuted,
    border,
    'border.strong': borderStrong,
  } as const;
  const controlTiers = {
    'border.control': borderControl,
    'border.control.hover': borderControlHover,
  } as const;
  const allTiers = { ...structuralTiers, ...controlTiers } as const;

  for (const arm of ['light', 'dark'] as const) {
    for (const [surfaceName, surfaceToken] of Object.entries(surfaces)) {
      it(`${arm}: faint border remains distinguishable on ${surfaceName}`, () => {
        expect(
          contrastRatio(wcagLuminance(borderFaint[arm]), wcagLuminance(surfaceToken[arm])),
        ).toBeGreaterThanOrEqual(FAINT_BORDER);
      });

      for (const [tierName, tier] of Object.entries(structuralTiers)) {
        it(`${arm}: ${tierName} is perceptible on ${surfaceName}`, () => {
          expect(translucentContrastOn(tier[arm], surfaceToken[arm])).toBeGreaterThanOrEqual(
            STRUCTURAL_FLOORS[tierName as keyof typeof STRUCTURAL_FLOORS],
          );
        });

        it(`${arm}: ${tierName} stays below border.control on ${surfaceName}`, () => {
          // The hierarchy must not invert: a structural edge heavier than a
          // control edge would make a container read as the interactive thing.
          expect(translucentContrastOn(tier[arm], surfaceToken[arm])).toBeLessThan(
            translucentContrastOn(borderControl[arm], surfaceToken[arm]),
          );
        });
      }

      for (const [tierName, tier] of Object.entries(controlTiers)) {
        it(`${arm}: ${tierName} clears WCAG 1.4.11 on ${surfaceName}`, () => {
          expect(translucentContrastOn(tier[arm], surfaceToken[arm])).toBeGreaterThanOrEqual(
            NON_TEXT,
          );
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // CIN-245: the tiers are alpha steps over ONE ink.
  //
  // The point of composing them that way is not economy, it is UNIFORMITY: an
  // alpha border tracks the surface underneath it, so one tier reads the same
  // weight everywhere it is used. The opaque values these replaced could not
  // do that -- the dark arm's surface ramp spans L 0.11..0.28, so a single
  // opaque border was 4.80:1 on `inset` and 3.42:1 on `raised`, a 29% spread,
  // and every retune had to re-chase it by eye.
  // -------------------------------------------------------------------------

  // Deliberately a proportion of the larger ratio rather than an absolute
  // spread: the tiers sit at very different ratios (1.2:1 vs 4.9:1), so a
  // fixed delta would be near-free for one and unreachable for another.
  const MAX_SPREAD = 0.15;

  for (const arm of ['light', 'dark'] as const) {
    for (const [tierName, tier] of Object.entries(allTiers)) {
      it(`${arm}: ${tierName} reads within ${MAX_SPREAD * 100}% across every legal surface`, () => {
        const ratios = Object.entries(surfaces).map(
          ([surfaceName, surfaceToken]) =>
            [surfaceName, translucentContrastOn(tier[arm], surfaceToken[arm])] as const,
        );
        const ratioValues = ratios.map(([, ratio]) => ratio);
        const spread =
          (Math.max(...ratioValues) - Math.min(...ratioValues)) / Math.max(...ratioValues);
        expect(
          spread,
          ratios.map(([name, ratio]) => `${name}=${ratio.toFixed(3)}`).join(' '),
        ).toBeLessThanOrEqual(MAX_SPREAD);
      });
    }

    it(`${arm}: the five tiers stay ordered on every surface`, () => {
      const ladder = Object.entries(allTiers);
      for (const [surfaceName, surfaceToken] of Object.entries(surfaces)) {
        const on = (tier: TranslucentColor) => translucentContrastOn(tier, surfaceToken[arm]);
        for (let index = 1; index < ladder.length; index += 1) {
          const [lighterName, lighter] = ladder[index - 1]!;
          const [heavierName, heavier] = ladder[index]!;
          expect(
            on(heavier[arm]),
            `${heavierName} > ${lighterName} on ${surfaceName}`,
          ).toBeGreaterThan(on(lighter[arm]));
        }
      }
    });

    it(`${arm}: every tier is the SAME ink, differing only in alpha`, () => {
      // A tested property rather than an authoring convention: nothing but this
      // stops one tier from being nudged off the shared ink and quietly
      // becoming a second source.
      for (const [tierName, tier] of Object.entries(allTiers)) {
        expect(
          { l: tier[arm].l, c: tier[arm].c, h: tier[arm].h },
          `${tierName} (${arm}) must resolve to border.ink`,
        ).toEqual(borderInk[arm]);
        expect(tier[arm].alpha, `${tierName} (${arm}) must be translucent`).toBeLessThan(1);
      }
    });
  }

  it('the emitted color-mix percentage agrees with the resolved alpha', () => {
    // The CSS comes from `cssRecipe` and the resolved artifacts come from
    // `$value`. The generator now materializes the second from the first, so
    // this pins the end result: the border every gate above measured is the
    // border the stylesheet ships, in every block.
    const tierProperties = {
      '--cinder-border-muted': borderMuted,
      '--cinder-border': border,
      '--cinder-border-strong': borderStrong,
      '--cinder-border-control': borderControl,
      '--cinder-border-control-hover': borderControlHover,
    } as const;
    for (const [property, tier] of Object.entries(tierProperties)) {
      const expected = `color-mix(in oklch, var(--cinder-border-ink), transparent ${Math.round((1 - tier.light.alpha) * 100)}%)`;
      const declarations = readAllTokenValues(css, property);
      expect(
        declarations.length,
        `${property} should be declared at :root and in both [data-theme] blocks`,
      ).toBe(3);
      for (const declaration of declarations) {
        expect(
          declaration,
          `${property} recipe must agree with its resolved alpha in every block`,
        ).toBe(expected);
      }
      expect(tier.dark.alpha, `${property} shares one alpha ladder across arms`).toBe(
        tier.light.alpha,
      );
    }
  });

  it('the polarity ink actually contrasts with the surfaces of its own arm', () => {
    // `--cinder-polarity-ink` promises one thing in its name: it is the ink
    // that opposes whatever the theme paints underneath it. Nothing gated that
    // promise -- the browser test proves only that its value PARSES -- so an
    // arm authored backwards, or nudged toward its own surfaces, would ship.
    //
    // The floor is AA text contrast rather than a non-text floor: the ink is
    // the basis for washes at arbitrary alpha, and a basis that only just
    // clears 3:1 leaves nothing to dilute.
    for (const arm of ['light', 'dark'] as const) {
      for (const [surfaceName, surfaceToken] of Object.entries(surfaces)) {
        expect(
          contrastRatio(wcagLuminance(polarityInk[arm]), wcagLuminance(surfaceToken[arm])),
          `polarity ink on ${surfaceName} (${arm})`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
    // And it opposes the surface rather than matching it: the light arm is the
    // darker of the two, the dark arm the lighter. A swapped `light-dark()`
    // would still clear the ratios above, so polarity is asserted on its own.
    expect(polarityInk.light.l, 'light arm must be the dark ink').toBeLessThan(surface.light.l);
    expect(polarityInk.dark.l, 'dark arm must be the light ink').toBeGreaterThan(surface.dark.l);
  });

  it('semantic and status borders stay opaque', () => {
    // The hybrid model CIN-245 ratified: alpha-composed neutral STRUCTURE,
    // opaque semantics. A translucent status border would take its hue from
    // whatever it happened to sit on, which is the opposite of what a status
    // color is for. `readOklchToken` throws on any alpha channel, so simply
    // reading these through it is the assertion.
    for (const status of ['info', 'success', 'warning', 'danger'] as const) {
      expect(() => readOklchToken(`--cinder-status-${status}-border`)).not.toThrow();
    }
    expect(() => readOklchToken('--cinder-border-faint')).not.toThrow();
  });
});
