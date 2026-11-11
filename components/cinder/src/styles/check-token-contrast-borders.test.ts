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
  borderContrast,
  borderContrastHover,
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
  // --cinder-ring-color is one quiet ring in both arms: oklch(from accent 0.62 0.16 h).
  it('ring clears 3:1 against the page background (both arms)', () => {
    const ringLight: OklchColor = { l: 0.62, c: 0.16, h: accent.light.h };
    const ringDark: OklchColor = { l: 0.62, c: 0.16, h: accent.dark.h };
    expect(contrastRatio(wcagLuminance(ringLight), wcagLuminance(bg.light))).toBeGreaterThanOrEqual(
      NON_TEXT,
    );
    expect(contrastRatio(wcagLuminance(ringDark), wcagLuminance(bg.dark))).toBeGreaterThanOrEqual(
      NON_TEXT,
    );
  });
});

describe('focus ring contrast on the sidebar and the canvas (COR-2010 row 02o)', () => {
  // The sidebar paints `--cinder-surface` (sidebar.css) beside the page canvas, and the design asks
  // the shared quiet ring to read at 3.6:1 against both, in light and dark.
  // COR-2311 darkened the light canvas to 97.5% so a card reads as a step; the ring held 3.5:1 there.
  // COR-2308 moved the grey step to the surface the sidebar paints: at the revision's 97.3% the ring
  // read 3.48:1, so the surface ships at 97.6% (3.51:1). The canvas is now 99.4% (3.70:1). Dark: the
  // ring reads 4.97:1 on the 18.5% surface and 5.28:1 on the 14.5% canvas.
  const SIDEBAR_RING_FLOOR = 3.5;
  for (const arm of ['light', 'dark'] as const) {
    for (const [groundName, ground] of Object.entries({ sidebar: surface, canvas: bg })) {
      it(`${arm}: the ring reads at least ${SIDEBAR_RING_FLOOR}:1 on the ${groundName}`, () => {
        const ring: OklchColor = { l: 0.62, c: 0.16, h: accent[arm].h };
        expect(
          contrastRatio(wcagLuminance(ring), wcagLuminance(ground[arm])),
        ).toBeGreaterThanOrEqual(SIDEBAR_RING_FLOOR);
      });
    }
  }
});

describe('border-on-surface contrast', () => {
  // The neutral tiers do three jobs. STRUCTURAL tiers (muted, border, strong)
  // separate regions and outline containers; the region is identified by its
  // surface and content, so WCAG 1.4.11 does not apply and they are kept
  // quiet. CONTROL tiers (control, control.hover) are the edge of an input,
  // button, checkbox, or radio. The owner decided on 2026-11-11 that this edge
  // is quiet by default, reversing COR-1814: heavier than every structural
  // tier, lighter than 3:1. CONTRAST tiers (contrast, contrast.hover) clear
  // 3:1: they are what the control tiers become under `prefers-contrast: more`,
  // and what fills a neutral indicator that has no other boundary.
  //
  // Faint borders are decorative hairlines and only need to stay distinguishable.
  const FAINT_BORDER = 1.1;
  // Every structural tier must stay perceptible, each at its own floor. COR-1552 moved the tiers to
  // 5%, 9% and 15% of the ink, and these sit just under the lowest ratio each measures on any
  // surface in either arm (dark: 1.067, 1.143, 1.308), so a regression below the weight the owner
  // chose still fails.
  const STRUCTURAL_FLOORS = { 'border.muted': 1.06, border: 1.14, 'border.strong': 1.3 } as const;
  // The control tiers are 32% and 42% of the ink in both arms. Each floor sits just under the lowest
  // ratio the tier measures on any surface (light: 2.036 and 2.654; dark: 2.799 and 4.020), so a
  // control edge fainter than the weight the owner chose from the comparison fails.
  const CONTROL_FLOORS = {
    light: { 'border.control': 2.03, 'border.control.hover': 2.65 },
    dark: { 'border.control': 2.79, 'border.control.hover': 4.01 },
  } as const;
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
  const contrastTiers = {
    'border.contrast': borderContrast,
    'border.contrast.hover': borderContrastHover,
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
        it(`${arm}: ${tierName} keeps the weight the owner chose on ${surfaceName}`, () => {
          expect(translucentContrastOn(tier[arm], surfaceToken[arm])).toBeGreaterThanOrEqual(
            CONTROL_FLOORS[arm][tierName as keyof (typeof CONTROL_FLOORS)['light']],
          );
        });
      }

      it(`${arm}: border.control stays below border.contrast on ${surfaceName}`, () => {
        // More contrast must mean a heavier edge: if the resting edge ever met the tier it becomes
        // under `prefers-contrast: more`, the preference would change nothing.
        expect(translucentContrastOn(borderControl[arm], surfaceToken[arm])).toBeLessThan(
          translucentContrastOn(borderContrast[arm], surfaceToken[arm]),
        );
      });

      for (const [tierName, tier] of Object.entries(contrastTiers)) {
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
      // The dark contrast tier is the one opaque literal, so it cannot track the surface under it;
      // it is not in this ladder, and its 3:1 floor on every surface is gated above instead.
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

  it('the emitted color-mix percentage agrees with the resolved alpha in each arm', () => {
    // The CSS comes from `cssRecipe` and the resolved artifacts come from
    // `$value`. The generator now materializes the second from the first, so
    // this pins the end result: the border every gate above measured is the
    // border the stylesheet ships, in every block. COR-2308 gives the dark arm
    // its own structural steps (8% and 12% of a white ink), so a tier whose
    // arms differ is a `light-dark()` of the two recipes at `:root`.
    const tierProperties = {
      '--cinder-border-muted': borderMuted,
      '--cinder-border': border,
      '--cinder-border-strong': borderStrong,
      '--cinder-border-control': borderControl,
      '--cinder-border-control-hover': borderControlHover,
      '--cinder-border-contrast-hover': borderContrastHover,
    } as const;
    // The two control tiers are declared a fourth time, as aliases of the contrast tiers, in the
    // `prefers-contrast: more` block that follows the theme blocks.
    const highContrastAlias: Readonly<Record<string, string>> = {
      '--cinder-border-control': 'var(--cinder-border-contrast)',
      '--cinder-border-control-hover': 'var(--cinder-border-contrast-hover)',
    };
    const recipeFor = (alpha: number) =>
      `color-mix(in oklch, var(--cinder-border-ink), transparent ${Math.round((1 - alpha) * 100)}%)`;
    for (const [property, tier] of Object.entries(tierProperties)) {
      const lightRecipe = recipeFor(tier.light.alpha);
      const darkRecipe = recipeFor(tier.dark.alpha);
      const declarations = readAllTokenValues(css, property);
      const alias = highContrastAlias[property];
      expect(
        declarations.length,
        `${property} should be declared at :root and in both [data-theme] blocks`,
      ).toBe(alias === undefined ? 3 : 4);
      const [rootDeclaration, darkDeclaration, lightDeclaration, aliasDeclaration] = declarations;
      expect(aliasDeclaration, `${property} under prefers-contrast: more`).toBe(alias);
      expect(rootDeclaration, `${property} :root recipe`).toBe(
        lightRecipe === darkRecipe ? lightRecipe : `light-dark( ${lightRecipe}, ${darkRecipe} )`,
      );
      expect(darkDeclaration, `${property} dark recipe`).toBe(darkRecipe);
      expect(lightDeclaration, `${property} light recipe`).toBe(lightRecipe);
    }
  });

  it('the dark structural tiers are 8% and 12% of a white ink (COR-2308)', () => {
    expect(borderInk.dark).toEqual({ l: 1, c: 0, h: 0 });
    expect(borderMuted.dark.alpha).toBe(0.08);
    expect(border.dark.alpha).toBe(0.12);
    expect(borderMuted.light.alpha).toBe(0.05);
    expect(border.light.alpha).toBe(0.09);
  });

  it('the dark contrast tier keeps its 56% step on every dark surface', () => {
    // The Interborough design drew the dark control edge, now the contrast tier, at oklch(52% .05 248). On the old navy
    // ladder that read 2.65:1 on `surface.raised`, so the token shipped 56%. COR-2308 darkened
    // raised to 23.5%, where 52% would clear by only 3.04:1, so the edge keeps 56% as margin:
    // 4.28:1 on the canvas, 4.03:1 on the surface, 3.83:1 on the inset and 3.60:1 on raised.
    expect(borderContrast.dark.l).toBeCloseTo(0.56, 5);
    for (const [groundName, ground] of Object.entries({
      canvas: bg.dark,
      surface: surface.dark,
      inset: surfaceInset.dark,
      raised: surfaceRaised.dark,
    })) {
      expect(
        contrastRatio(wcagLuminance(borderContrast.dark), wcagLuminance(ground)),
        `dark contrast tier on the ${groundName}`,
      ).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it('the contrast tier is the ink step in the light arm and the opaque literal in the dark arm', () => {
    // `--cinder-border-contrast` is the one tier whose arms differ in kind: light is the ink at 52%
    // transparency (about oklch(66% .006 255) over white), dark is the opaque oklch(56% .05 248).
    const [rootDeclaration, ...blockDeclarations] = readAllTokenValues(
      css,
      '--cinder-border-contrast',
    );
    const lightRecipe = `color-mix(in oklch, var(--cinder-border-ink), transparent ${Math.round((1 - borderContrast.light.alpha) * 100)}%)`;
    const darkLiteral = 'oklch(56% 0.05 248)';
    expect(rootDeclaration?.replace(/\s+/g, ' ')).toBe(
      `light-dark( ${lightRecipe}, ${darkLiteral} )`,
    );
    expect(blockDeclarations.sort()).toEqual([darkLiteral, lightRecipe].sort());
    expect(borderContrast.dark.alpha).toBe(1);
  });

  it('the control edge is 32% of the ink at rest and 42% on hover, in both arms', () => {
    for (const arm of ['light', 'dark'] as const) {
      expect(borderControl[arm].alpha).toBe(0.32);
      expect(borderControlHover[arm].alpha).toBe(0.42);
    }
  });

  it('more contrast turns the control edge into the contrast tier, after every theme block', () => {
    // The alias has to follow the `[data-theme]` blocks, which redeclare the control tiers at the
    // same specificity, or a scoped theme would keep its quiet edge under `prefers-contrast: more`.
    const block = css.indexOf('@media (prefers-contrast: more)');
    expect(block).toBeGreaterThan(css.indexOf("\n[data-theme='light'] {"));
    expect(block).toBeGreaterThan(css.indexOf("\n[data-theme='dark'] {"));
    const body = css.slice(block, css.indexOf('@media (prefers-reduced-motion', block));
    expect(body).toContain(":root,\n  [data-theme='dark'],\n  [data-theme='light'] {");
    expect(body).toContain('--cinder-border-control: var(--cinder-border-contrast);');
    expect(body).toContain('--cinder-border-control-hover: var(--cinder-border-contrast-hover);');
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

describe('field edges (COR-1814)', () => {
  // COR-1814 kept field edges at 3:1. The owner reversed that on 2026-11-11, from a side-by-side
  // of the New schedule form: every text-entry field draws its resting edge with
  // `--cinder-control-border` (the 32% `border.control` tier) and its hover edge with
  // `--cinder-control-border-hover` (42%), which stay heavier than a container's edge, and both
  // clear 3:1 against the page and the field's own fill once the person asks for more contrast.
  const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
  const fieldStylesheets = {
    input: '../components/input/input.css',
    select: '../components/select/select.css',
    combobox: '../components/combobox/combobox.css',
    multiSelect: '../components/multi-select/multi-select.css',
    textarea: '../components/textarea/textarea.css',
    inputFrame: './components/_input-frame.css',
  } as const;

  it('the field edge tokens alias the control border tiers', async () => {
    const tokens = await read('./tokens-base.css');
    expect(tokens).toContain('--cinder-control-border: var(--cinder-border-control);');
    expect(tokens).toContain('--cinder-control-border-hover: var(--cinder-border-control-hover);');
    expect(tokens).toContain('--cinder-control-background: var(--cinder-surface-raised);');
  });

  for (const [name, path] of Object.entries(fieldStylesheets)) {
    it(`${name} draws its resting edge with --cinder-control-border`, async () => {
      expect(await read(path)).toMatch(/border: 1px solid var\(--cinder-control-border\);/);
    });
  }

  for (const name of ['input', 'select', 'combobox', 'textarea'] as const) {
    it(`${name} draws its hover edge with --cinder-control-border-hover`, async () => {
      expect(await read(fieldStylesheets[name])).toContain(
        'border-color: var(--cinder-control-border-hover);',
      );
    });
  }

  for (const arm of ['light', 'dark'] as const) {
    for (const [edgeName, edge, highContrastEdge] of [
      ['control.border', borderControl, borderContrast],
      ['control.border.hover', borderControlHover, borderContrastHover],
    ] as const) {
      for (const [surfaceName, surfaceToken] of Object.entries({
        page: bg,
        'field fill': surfaceRaised,
      })) {
        it(`${arm}: ${edgeName} is heavier than a container's edge against the ${surfaceName}`, () => {
          expect(translucentContrastOn(edge[arm], surfaceToken[arm])).toBeGreaterThan(
            translucentContrastOn(borderStrong[arm], surfaceToken[arm]),
          );
        });

        it(`${arm}: ${edgeName} clears 3:1 against the ${surfaceName} under more contrast`, () => {
          expect(
            translucentContrastOn(highContrastEdge[arm], surfaceToken[arm]),
          ).toBeGreaterThanOrEqual(NON_TEXT);
        });
      }
    }
  }
});
