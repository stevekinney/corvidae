/**
 * COR-1552: the values the Interborough retune ships, read from the resolved
 * contexts the runtime and the generated CSS both come from.
 *
 * The light arm asserts every value in the issue's "Theme as it ships" table.
 * The dark arm keeps its palette, so it asserts the pre-retune values for every
 * surface, accent, status and control-border token, and the new alphas only for
 * the three structural tiers and the secondary-button edge.
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

// The three white tiers have chroma 0, so their hue paints nothing. It is 255 rather than the
// issue's 0 because `hue-travel.test.ts` fails any OKLCH mix whose operands are more than 40° apart,
// and the hover and pressed washes mix these tiers toward the accent at hue 272.
const LIGHT_VALUES: readonly ExpectedColor[] = [
  ['--cinder-surface-canvas', [0.995, 0, 255]],
  ['--cinder-surface', [0.998, 0, 255]],
  ['--cinder-surface-raised', [1, 0, 255]],
  ['--cinder-surface-inset', [0.96, 0.008, 270]],
  ['--cinder-accent-solid', [0.52, 0.24, 272]],
  ['--cinder-status-success-solid', [0.6, 0.174, 148]],
  ['--cinder-status-success-contrast', [0.15, 0.03, 148]],
  ['--cinder-status-success-solid-hover', [0.64, 0.174, 148]],
  ['--cinder-status-success-solid-active', [0.68, 0.174, 148]],
  ['--cinder-status-success-text', [0.44, 0.128, 148]],
  ['--cinder-status-success-background', [0.945, 0.075, 148]],
  ['--cinder-status-warning-solid', [0.79, 0.167, 75]],
  ['--cinder-status-warning-contrast', [0.22, 0.05, 70]],
  ['--cinder-status-warning-solid-hover', [0.71, 0.15, 75]],
  ['--cinder-status-warning-solid-active', [0.64, 0.135, 75]],
  ['--cinder-status-warning-text', [0.47, 0.109, 62]],
  ['--cinder-status-warning-background', [0.955, 0.053, 88]],
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

/** The structural tiers (5%, 9%, 15% of the border ink) and the control tiers (48%, 58%). */
const INK_TIERS = [
  ['--cinder-border-muted', 0.05],
  ['--cinder-border', 0.09],
  ['--cinder-border-strong', 0.15],
  ['--cinder-border-control', 0.48],
  ['--cinder-border-control-hover', 0.58],
  ['--cinder-button-border', 0.48],
] as const;

/** The dark palette as it shipped before the retune, which the retune must not move. */
const DARK_UNCHANGED_VALUES: readonly ExpectedColor[] = [
  ['--cinder-surface', [0.21, 0.04, 245]],
  ['--cinder-surface-raised', [0.28, 0.045, 245]],
  ['--cinder-surface-raised-hover', [0.298, 0.04388, 245]],
  ['--cinder-surface-raised-pressed', [0.3232, 0.0423, 245]],
  ['--cinder-surface-inset', [0.11, 0.03, 245]],
  ['--cinder-surface-hover', [0.22975, 0.039, 245]],
  ['--cinder-surface-pressed', [0.2574, 0.0376, 245]],
  ['--cinder-surface-inverse', [0.28, 0.045, 245]],
  ['--cinder-surface-upcoming-marker', [0.21, 0.04, 245]],
  ['--cinder-surface-canvas', [0.15, 0.035, 245]],
  ['--cinder-border-ink', [0.86, 0.065, 250]],
  ['--cinder-border-control', [0.86, 0.065, 250], 0.48],
  ['--cinder-border-control-hover', [0.86, 0.065, 250], 0.58],
  ['--cinder-border-faint', [0.33, 0.03, 245]],
  ['--cinder-accent-contrast', [0.15, 0.035, 245]],
  ['--cinder-accent-text', [0.72, 0.14, 270]],
  ['--cinder-accent-text-hover', [0.64, 0.14, 270]],
  ['--cinder-accent-solid', [0.72, 0.14, 270]],
  ['--cinder-accent-solid-active', [0.57, 0.14, 270]],
  ['--cinder-accent-solid-active-on-fill', [0.61, 0.14, 270]],
  ['--cinder-accent-solid-hover', [0.64, 0.14, 270]],
  ['--cinder-accent-background', [0.2712, 0.052, 248]],
  ['--cinder-accent-border', [0.72, 0.14, 270], 0.4],
  ['--cinder-status-success-contrast', [0.15, 0.03, 145]],
  ['--cinder-status-success-solid', [0.78, 0.14, 145]],
  ['--cinder-status-success-solid-active', [0.62, 0.14, 145]],
  ['--cinder-status-success-solid-hover', [0.7, 0.14, 145]],
  ['--cinder-status-success-background', [0.28, 0.07, 145]],
  ['--cinder-status-success-text', [0.88, 0.11, 145]],
  ['--cinder-status-success-border', [0.45, 0.09, 145]],
  ['--cinder-status-success-subtle', [0.8304, 0.05, 149.589]],
  ['--cinder-status-success-muted', [0.5748, 0.05, 154.248]],
  ['--cinder-status-warning-contrast', [0.2, 0.04, 75]],
  ['--cinder-status-warning-solid', [0.82, 0.156, 75]],
  ['--cinder-status-warning-solid-active', [0.66, 0.13, 75]],
  ['--cinder-status-warning-solid-hover', [0.74, 0.156, 75]],
  ['--cinder-status-warning-background', [0.28, 0.06, 75]],
  ['--cinder-status-warning-text', [0.9, 0.08, 75]],
  ['--cinder-status-warning-border', [0.5, 0.1, 75]],
  ['--cinder-status-warning-subtle', [0.856, 0.05, 75.772]],
  ['--cinder-status-warning-muted', [0.6004, 0.05, 76.672]],
  ['--cinder-status-danger-contrast', [0.12, 0.02, 25]],
  ['--cinder-status-danger-solid', [0.67, 0.19, 27]],
  ['--cinder-status-danger-solid-active', [0.59, 0.18, 27]],
  ['--cinder-status-danger-solid-hover', [0.61, 0.19, 27]],
  ['--cinder-status-danger-background', [0.28, 0.09, 25]],
  ['--cinder-status-danger-text', [0.9, 0.05, 25]],
  ['--cinder-status-danger-border', [0.5, 0.11, 25]],
  ['--cinder-status-danger-subtle', [0.76, 0.05, 24.81]],
  ['--cinder-status-danger-muted', [0.5044, 0.05, 22.403]],
  ['--cinder-status-info-contrast', [0.15, 0.03, 230]],
  ['--cinder-status-info-solid', [0.78, 0.13, 230]],
  ['--cinder-status-info-solid-active', [0.62, 0.12, 230]],
  ['--cinder-status-info-solid-hover', [0.7, 0.13, 230]],
  ['--cinder-status-info-background', [0.28, 0.057, 230]],
  ['--cinder-status-info-text', [0.88, 0.071, 230]],
  ['--cinder-status-info-border', [0.45, 0.08, 230]],
  ['--cinder-status-info-subtle', [0.8304, 0.05, 231.184]],
  ['--cinder-status-info-muted', [0.5748, 0.05, 232.198]],
  ['--cinder-status-neutral-background', [0.28, 0.04, 245]],
  ['--cinder-status-neutral-text', [0.92, 0.02, 245]],
  ['--cinder-status-dot-color', [0.82, 0.02, 245]],
];

describe('COR-1552: the light arm ships the retuned values', () => {
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

describe('COR-1552: the structural and control border tiers', () => {
  for (const arm of ['light', 'dark'] as const) {
    for (const [property, alpha] of INK_TIERS) {
      test(`${property} is ${alpha * 100}% of the border ink in the ${arm} arm`, () => {
        const tier = contexts[arm].get(property);
        const ink = contexts[arm].get('--cinder-border-ink');
        expect(tier?.alpha).toBe(alpha);
        expect(tier?.components).toEqual(ink?.components);
      });
    }
  }
});

describe('COR-1552: the dark arm keeps its palette', () => {
  for (const expected of DARK_UNCHANGED_VALUES) {
    test(`${expected[0]} is unchanged in the dark arm`, () => {
      expectColor('dark', expected);
    });
  }

  test('the neutral status border follows the structural border tier', () => {
    expect(contexts.dark.get('--cinder-status-neutral-border')?.alpha).toBe(0.09);
    expect(contexts.light.get('--cinder-status-neutral-border')?.alpha).toBe(0.09);
  });
});
