/**
 * COR-1552: the values the Interborough retune ships, read from the resolved
 * contexts the runtime and the generated CSS both come from.
 *
 * The light arm asserts every value in the issue's "Theme as it ships" table.
 *
 * COR-2010 (the Interborough redesign's foundations) then moved four dark values on purpose: the
 * inset band, the inverse tooltip chip, the control edge and the skeleton fill. They are pinned
 * in their own block below.
 *
 * COR-2308 retuned both ladders. Light is the app-shell ladder (a near-white canvas above a grey
 * surface and a tinted well, raised still pure white), the text tiers step at 44% and 50%, and
 * the success and warning backgrounds drop to chroma 0.035. Dark is a neutral ladder at hue 265
 * (chroma at most 0.014) with a white border ink at 12% and 8%, and its status backgrounds are
 * `color-mix(in oklab, <solid> 14%, <surface>)`. The derived values below are what that recipe
 * evaluates to in each arm (`scripts/tokens/derived-values.ts`).
 *
 * The owner then found the grey surface made every panel read as a grey slab (2026-11-15) and
 * chose the consumer ladder for the default light arm too: the surface is pure white like raised,
 * the canvas a grey page at 97.6% (3.51:1 for the focus ring; 97.0% would read 3.45:1), and the well
 * 95.5%. The hover, pressed and soft accent washes now mix from white, so they follow.
 *
 * COR-2450 made the light well neutral: chroma 0.005 read as a blue-grey band inside a white
 * panel, so it drops to 0.002 at the same 95.5% (the faint hairline needs the well at 95.2% or
 * lighter). The light overlay backdrop drops to alpha 0.25.
 */

import { describe, expect, test } from 'bun:test';

import { readJsonRecord } from '../styles/token-contrast-test-readers.ts';

type ResolvedColor = { components: number[]; alpha: number | undefined };
type ExpectedColor = readonly [property: string, components: number[], alpha?: number];

const TOKENS_DIRECTORY = import.meta.dirname;

function readContext(arm: 'light' | 'dark'): Map<string, ResolvedColor> {
  const context = readJsonRecord(TOKENS_DIRECTORY, 'resolved', `${arm}.json`);
  const byProperty = new Map<string, ResolvedColor>();
  for (const token of Object.values(context)) {
    const { $value: value, $extensions: extensions } = token as {
      $value?: { components?: number[]; alpha?: number };
      $extensions?: { 'com.lostgradient.cinder'?: { cssProperty?: string } };
    };
    const property = extensions?.['com.lostgradient.cinder']?.cssProperty;
    if (property === undefined || value?.components === undefined) continue;
    byProperty.set(property, { components: value.components, alpha: value.alpha });
  }
  return byProperty;
}

const contexts = { light: readContext('light'), dark: readContext('dark') };

function expectColor(arm: 'light' | 'dark', [property, components, alpha]: ExpectedColor): void {
  const actual = contexts[arm].get(property);
  expect(actual, `${property} is missing from the ${arm} context`).toBeDefined();
  expect(actual?.components, `${property} (${arm}) components`).toEqual(components);
  expect(actual?.alpha, `${property} (${arm}) alpha`).toEqual(alpha);
}

// Raised has chroma 0, so its hue paints nothing. It is 255 rather than 0 because
// `hue-travel.test.ts` fails any OKLCH mix whose operands are more than 40° apart, and the hover
// and pressed washes mix it toward the accent at hue 272.
const LIGHT_VALUES: readonly ExpectedColor[] = [
  ['--cinder-surface-canvas', [0.976, 0.004, 265]],
  ['--cinder-surface', [1, 0, 255]],
  ['--cinder-surface-raised', [1, 0, 255]],
  ['--cinder-surface-inset', [0.955, 0.002, 265]],
  ['--cinder-surface-hover', [0.9712, 0.0144, 256.02]],
  ['--cinder-surface-pressed', [0.9424, 0.0288, 257.04]],
  ['--cinder-surface-raised-hover', [0.9664, 0.0168, 256.19]],
  ['--cinder-text-muted', [0.44, 0.01, 265]],
  ['--cinder-text-subtle', [0.5, 0.01, 265]],
  ['--cinder-accent-solid', [0.52, 0.24, 272]],
  ['--cinder-accent-background', [0.9424, 0.0288, 257.04]],
  ['--cinder-status-success-solid', [0.6, 0.174, 148]],
  ['--cinder-status-success-contrast', [0.15, 0.03, 148]],
  ['--cinder-status-success-solid-hover', [0.64, 0.174, 148]],
  ['--cinder-status-success-solid-active', [0.68, 0.174, 148]],
  ['--cinder-status-success-text', [0.44, 0.128, 148]],
  ['--cinder-status-success-background', [0.965, 0.035, 148]],
  ['--cinder-status-warning-solid', [0.79, 0.167, 75]],
  ['--cinder-status-warning-contrast', [0.22, 0.05, 70]],
  ['--cinder-status-warning-solid-hover', [0.71, 0.15, 75]],
  ['--cinder-status-warning-solid-active', [0.64, 0.135, 75]],
  ['--cinder-status-warning-text', [0.47, 0.109, 62]],
  ['--cinder-status-warning-background', [0.968, 0.035, 88]],
  ['--cinder-status-danger-solid', [0.57, 0.23, 27]],
  ['--cinder-status-danger-contrast', [1, 0, 0]],
  ['--cinder-status-danger-solid-hover', [0.49, 0.201, 27]],
  ['--cinder-status-danger-solid-active', [0.42, 0.173, 27]],
  ['--cinder-status-danger-text', [0.49, 0.201, 27]],
  ['--cinder-status-danger-background', [0.95, 0.025, 25]],
  ['--cinder-status-info-solid', [0.55, 0.122, 238]],
  ['--cinder-status-info-contrast', [1, 0, 0]],
  ['--cinder-status-info-solid-hover', [0.47, 0.105, 238]],
  ['--cinder-status-info-solid-active', [0.4, 0.09, 238]],
  ['--cinder-status-info-text', [0.46, 0.103, 238]],
  ['--cinder-status-info-background', [0.95, 0.028, 235]],
];

/**
 * The structural tiers and the control tiers, as alpha steps over the border ink. COR-2308 gives
 * the dark arm its own structural steps (8% and 12% of a white ink) and keeps the light ones.
 */
const INK_TIERS = [
  ['--cinder-border-muted', { light: 0.05, dark: 0.08 }],
  ['--cinder-border', { light: 0.09, dark: 0.35 }],
  ['--cinder-border-strong', { light: 0.15, dark: 0.36 }],
  ['--cinder-border-control', { light: 0.32, dark: 0.38 }],
  ['--cinder-border-control-hover', { light: 0.42, dark: 0.44 }],
  ['--cinder-border-contrast', { light: 0.48, dark: 0.48 }],
  ['--cinder-border-contrast-hover', { light: 0.58, dark: 0.58 }],
  ['--cinder-button-border', { light: 0.32, dark: 0.38 }],
] as const;

/** The one tier whose dark arm is the opaque literal below, not a step over the ink. */
const OPAQUE_IN_DARK = new Set<string>(['--cinder-border-contrast']);

/** The dark arm as COR-2308 ships it: neutral surfaces, a white border ink, mixed status grounds. */
const DARK_VALUES: readonly ExpectedColor[] = [
  ['--cinder-surface', [0.185, 0.012, 265]],
  ['--cinder-surface-raised', [0.235, 0.014, 265]],
  ['--cinder-surface-raised-hover', [0.25413, 0.01365, 265]],
  ['--cinder-surface-raised-pressed', [0.2809, 0.01316, 265]],
  ['--cinder-surface-hover', [0.2502, 0.01104, 265]],
  ['--cinder-surface-pressed', [0.2828, 0.01056, 265]],
  ['--cinder-surface-upcoming-marker', [0.185, 0.012, 265]],
  ['--cinder-surface-canvas', [0.145, 0.012, 265]],
  ['--cinder-border-ink', [1, 0, 0]],
  ['--cinder-border-control', [1, 0, 0], 0.38],
  ['--cinder-border-control-hover', [1, 0, 0], 0.44],
  ['--cinder-border-contrast-hover', [1, 0, 0], 0.58],
  ['--cinder-border-faint', [0.33, 0.03, 265]],
  ['--cinder-text-default', [0.95, 0.01, 265]],
  ['--cinder-text-muted', [0.78, 0.01, 265]],
  ['--cinder-text-subtle', [0.68, 0.01, 265]],
  ['--cinder-accent-contrast', [0.15, 0.035, 270]],
  ['--cinder-accent-text', [0.72, 0.14, 270]],
  ['--cinder-accent-text-hover', [0.64, 0.14, 270]],
  ['--cinder-accent-solid', [0.72, 0.14, 270]],
  ['--cinder-accent-solid-active', [0.57, 0.14, 270]],
  ['--cinder-accent-solid-active-on-fill', [0.61, 0.14, 270]],
  ['--cinder-accent-solid-hover', [0.64, 0.14, 270]],
  ['--cinder-accent-background', [0.2492, 0.02736, 265.6]],
  ['--cinder-accent-border', [0.72, 0.14, 270], 0.4],
  ['--cinder-status-success-contrast', [0.15, 0.03, 145]],
  ['--cinder-status-success-solid', [0.78, 0.14, 145]],
  ['--cinder-status-success-solid-active', [0.62, 0.14, 145]],
  ['--cinder-status-success-solid-hover', [0.7, 0.14, 145]],
  ['--cinder-status-success-background', [0.2683, 0.01698, 176.755]],
  ['--cinder-status-success-text', [0.88, 0.11, 145]],
  ['--cinder-status-success-border', [0.45, 0.09, 145]],
  ['--cinder-status-success-subtle', [0.8412, 0.05, 147.034]],
  ['--cinder-status-success-muted', [0.5658, 0.05, 147.45]],
  ['--cinder-status-warning-contrast', [0.2, 0.04, 75]],
  ['--cinder-status-warning-solid', [0.82, 0.156, 75]],
  ['--cinder-status-warning-solid-active', [0.66, 0.13, 75]],
  ['--cinder-status-warning-solid-hover', [0.74, 0.156, 75]],
  ['--cinder-status-warning-background', [0.2739, 0.01181, 66.275]],
  ['--cinder-status-warning-text', [0.9, 0.08, 75]],
  ['--cinder-status-warning-border', [0.5, 0.1, 75]],
  ['--cinder-status-warning-subtle', [0.8668, 0.05, 74.628]],
  ['--cinder-status-warning-muted', [0.5914, 0.05, 74.55]],
  ['--cinder-status-danger-contrast', [0.12, 0.02, 25]],
  ['--cinder-status-danger-solid', [0.67, 0.19, 27]],
  ['--cinder-status-danger-solid-active', [0.59, 0.18, 27]],
  ['--cinder-status-danger-solid-hover', [0.61, 0.19, 27]],
  ['--cinder-status-danger-background', [0.2529, 0.02287, 4.502]],
  // COR-2287: the dark danger ink is a red at 76% (chroma 0.14, the in-gamut step below the
  // board's 0.15) and its border a red at 62%, so a danger row reads red instead of pink-white.
  ['--cinder-status-danger-text', [0.76, 0.14, 25]],
  ['--cinder-status-danger-border', [0.62, 0.17, 25]],
  ['--cinder-status-danger-subtle', [0.7708, 0.05, 25.539]],
  ['--cinder-status-danger-muted', [0.4954, 0.05, 25.241]],
  ['--cinder-status-info-contrast', [0.15, 0.03, 230]],
  ['--cinder-status-info-solid', [0.78, 0.13, 230]],
  ['--cinder-status-info-solid-active', [0.62, 0.12, 230]],
  ['--cinder-status-info-solid-hover', [0.7, 0.13, 230]],
  ['--cinder-status-info-background', [0.2683, 0.0273, 242.521]],
  ['--cinder-status-info-text', [0.88, 0.071, 230]],
  ['--cinder-status-info-border', [0.45, 0.08, 230]],
  ['--cinder-status-info-subtle', [0.8412, 0.05, 231.373]],
  ['--cinder-status-info-muted', [0.5658, 0.05, 231.636]],
  ['--cinder-status-neutral-background', [0.268, 0.012, 265]],
  ['--cinder-status-neutral-text', [0.95, 0.01, 265]],
  ['--cinder-status-dot-color', [0.78, 0.01, 265]],
];

describe('COR-1552 and COR-2308: the light arm ships the retuned values', () => {
  for (const expected of LIGHT_VALUES) {
    test(`${expected[0]} resolves to ${JSON.stringify(expected[1])}`, () => {
      expectColor('light', expected);
    });
  }

  test('the status border tokens are unchanged, because the outline is removed in the components', () => {
    expectColor('light', ['--cinder-status-success-border', [0.8, 0.05, 145]]);
    expectColor('light', ['--cinder-status-warning-border', [0.8, 0.06, 75]]);
    expectColor('light', ['--cinder-status-danger-border', [0.8, 0.06, 25]]);
    expectColor('light', ['--cinder-status-info-border', [0.8, 0.05, 230]]);
  });
});

// COR-2450: at half alpha the light scrim greyed the whole page behind a modal. A quarter keeps
// the page readable behind the dialog. The dark scrim is unchanged.
describe('COR-2450: the light overlay backdrop dims the page by a quarter', () => {
  test('the light scrim is oklch(20% 0.03 245) at alpha 0.25', () => {
    expectColor('light', ['--cinder-overlay-backdrop', [0.2, 0.03, 245], 0.25]);
  });

  test('the dark scrim keeps alpha 0.65 and is a neutral at hue 265 (COR-2441)', () => {
    expectColor('dark', ['--cinder-overlay-backdrop', [0.08, 0.02, 265], 0.65]);
  });
});

describe('COR-2450: the light well is neutral', () => {
  test('the light inset keeps 95.5% lightness at chroma 0.004 or less', () => {
    const [lightness, chroma] = contexts.light.get('--cinder-surface-inset')?.components ?? [];
    expect(lightness).toBe(0.955);
    expect(chroma).toBeLessThanOrEqual(0.004);
  });
});

describe('COR-1552 and COR-2308: the structural and control border tiers', () => {
  for (const arm of ['light', 'dark'] as const) {
    for (const [property, alphas] of INK_TIERS) {
      if (arm === 'dark' && OPAQUE_IN_DARK.has(property)) continue;
      test(`${property} is ${alphas[arm] * 100}% of the border ink in the ${arm} arm`, () => {
        const tier = contexts[arm].get(property);
        const ink = contexts[arm].get('--cinder-border-ink');
        expect(tier?.alpha).toBe(alphas[arm]);
        expect(tier?.components).toEqual(ink?.components);
      });
    }
  }
});

describe('COR-2010: the dark arm moves the inset, inverse chip, control edge and skeleton', () => {
  test('the inset band sits between the surface and raised (COR-2308: 21%)', () => {
    expectColor('dark', ['--cinder-surface-inset', [0.21, 0.012, 265]]);
  });

  test('the inverse chip is the light text ink, so a tooltip separates from raised popovers', () => {
    expectColor('dark', ['--cinder-surface-inverse', [0.95, 0.01, 265]]);
    expectColor('light', ['--cinder-surface-inverse', [0.2, 0.018, 245]]);
    expectColor('dark', ['--cinder-text-inverse', [0.185, 0.012, 265]]);
  });

  test('the contrast tier is the opaque oklch(64% .03 265), which clears 3:1 on raised', () => {
    for (const property of OPAQUE_IN_DARK) {
      expectColor('dark', [property, [0.64, 0.03, 265]]);
    }
  });

  // L#3 (light sweep): the disabled field fill aliased `fill.disabled` (86%) in light, darker than
  // the white enabled control beside it. It is now the inset, the fill a disabled Button uses.
  test('the disabled control fill is the inset in light and fill.disabled in dark', () => {
    expectColor('light', ['--cinder-control-background-disabled', [0.955, 0.002, 265]]);
    expectColor('dark', ['--cinder-control-background-disabled', [0.3, 0.015, 265]]);
  });

  test('the skeleton fill is a 12% step of the border ink in both arms, never an opaque surface', () => {
    expectColor('light', ['--cinder-skeleton-background', [0.2, 0.02, 255], 0.12]);
    expectColor('dark', ['--cinder-skeleton-background', [1, 0, 0], 0.12]);
  });

  test('the focus ring is the accent hue at 62% lightness in both arms', () => {
    expectColor('light', ['--cinder-ring-color', [0.62, 0.16, 272]]);
    expectColor('dark', ['--cinder-ring-color', [0.62, 0.16, 270]]);
  });
});

describe('COR-2308: the dark arm ships the neutral ladder', () => {
  for (const expected of DARK_VALUES) {
    test(`${expected[0]} resolves to ${JSON.stringify(expected[1])} in the dark arm`, () => {
      expectColor('dark', expected);
    });
  }

  test('every dark resting surface is hue 265 at chroma 0.014 or less', () => {
    for (const property of [
      '--cinder-surface-canvas',
      '--cinder-surface',
      '--cinder-surface-inset',
      '--cinder-surface-raised',
    ]) {
      const [, chroma, hue] = contexts.dark.get(property)?.components ?? [];
      expect(hue, property).toBe(265);
      expect(chroma, property).toBeLessThanOrEqual(0.014);
    }
  });

  test('the neutral status border follows the structural border tier in each arm', () => {
    expect(contexts.dark.get('--cinder-status-neutral-border')?.alpha).toBe(0.35);
    expect(contexts.light.get('--cinder-status-neutral-border')?.alpha).toBe(0.09);
  });
});

// COR-2441 (COR-2308): the dark neutrals were authored at the old navy hue, 245, and read blue
// beside the hue-265 surfaces. Only status colors and the accent keep a chromatic hue.
describe('COR-2441: no dark neutral keeps hue 245', () => {
  const NEUTRALS = [
    '--cinder-border-faint',
    '--cinder-border-control',
    '--cinder-border-control-hover',
    '--cinder-border-contrast',
    '--cinder-text-disabled',
    '--cinder-fill-disabled',
    '--cinder-control-background-disabled',
    '--cinder-accent-contrast',
    '--cinder-overlay-backdrop',
    '--cinder-toggle-track-off-resting',
    '--cinder-toggle-track-off-hover-resting',
    '--cinder-checker-base',
    '--cinder-checker-tile',
  ];

  for (const property of NEUTRALS) {
    test(`${property} is not hue 245 in the dark arm`, () => {
      const color = contexts.dark.get(property);
      if (color === undefined) return;
      const [, chroma, hue] = color.components;
      // Hue is meaningless at zero chroma.
      if (chroma === 0) return;
      expect(hue, property).not.toBe(245);
    });
  }

  test('the resolved dark neutrals for the tokens the issue names exist', () => {
    for (const property of [
      '--cinder-border-faint',
      '--cinder-fill-disabled',
      '--cinder-accent-contrast',
      '--cinder-overlay-backdrop',
      '--cinder-toggle-track-off-resting',
      '--cinder-checker-base',
    ]) {
      expect(contexts.dark.get(property), `${property} is missing`).toBeDefined();
    }
  });
});

// COR-2440 AC15: the dark ladder (muted, border, strong, control, hover) moved so the structural
// edge and the control edge both clear 3:1 (check-token-contrast-borders.test.ts). The contrast
// tier, which `prefers-contrast: more` aliases the control edge to, stays heavier than the
// resting control edge it replaces.
describe('COR-2440 AC15: the retuned dark border ladder and prefers-contrast: more', () => {
  test('the dark ladder is pinned', () => {
    const alphas = ['--cinder-border-muted', '--cinder-border', '--cinder-border-strong'].map(
      (property) => contexts.dark.get(property)?.alpha,
    );
    expect(alphas).toEqual([0.08, 0.35, 0.36]);
  });

  test('more contrast keeps a stronger border than the resting control edge', async () => {
    const css = await Bun.file(new URL('../styles/tokens-base.css', import.meta.url)).text();
    const block = css.slice(css.indexOf('@media (prefers-contrast: more)'));
    expect(block).toContain('--cinder-border-control: var(--cinder-border-contrast);');
    expect(block).toContain('--cinder-border-control-hover: var(--cinder-border-contrast-hover);');
    const contrastLightness = contexts.dark.get('--cinder-border-contrast')?.components[0] ?? 0;
    expect(contrastLightness).toBeGreaterThan(0.6);
    expect(contexts.dark.get('--cinder-border-contrast-hover')?.alpha).toBeGreaterThan(
      contexts.dark.get('--cinder-border-control-hover')?.alpha ?? 1,
    );
  });
});
