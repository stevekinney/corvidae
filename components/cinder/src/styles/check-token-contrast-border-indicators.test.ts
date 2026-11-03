import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NON_TEXT, contrastRatio, wcagLuminance } from '../tokens/runtime/contrast/index.ts';
import * as values from './check-token-contrast-test-values.ts';
import type { TranslucentColor, TranslucentTokenArms } from './token-contrast-test-readers.ts';

function ruleBody(source: string, selectorText: string): string {
  const selectorIndex = source.indexOf(selectorText);
  if (selectorIndex === -1) {
    throw new Error(`Selector containing "${selectorText}" not found.`);
  }
  const braceOpen = source.indexOf('{', selectorIndex);
  const braceClose = source.indexOf('}', braceOpen);
  return source.slice(braceOpen + 1, braceClose);
}

function ruleOpacity(body: string): number {
  const match = /opacity:\s*([0-9.]+)/.exec(body);
  return Number(match?.[1] ?? 1);
}

const {
  bg,
  border,
  borderControl,
  borderControlHover,
  borderMuted,
  borderStrong,
  surface,
  surfaceInset,
  surfaceRaised,
  translucentContrastOn,
} = values;
describe('CIN-603: previously diluted border-tier indicators now clear the functional floor', () => {
  // Every non-exempt site the ticket named: a persistent or interactive
  // indicator that either filled with `border.muted` (a 1.4:1 decorative
  // tier) or compounded a structural tier with an element/child opacity,
  // landing under WCAG 1.4.11's 3:1 floor in the dark arm.
  //
  // This reads the REAL component `.css` files rather than modeling a fixed
  // "effective ink" by hand, so a regression is actually caught rather than
  // merely documented: reverting a fix restores either the diluting
  // `opacity` (parsed straight out of the site's own rule body) or the
  // `border.muted` reference (parsed out of the fill declaration), and the
  // effective alpha computed from that real text fails the assertion below
  // exactly as it did before the fix.
  const componentsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'components');

  function readComponentCss(...segments: readonly string[]): string {
    return readFileSync(join(componentsDirectory, ...segments), 'utf8');
  }

  /** Which border tier this rule body's fill/border actually references. */
  function ruleTier(body: string): TranslucentTokenArms {
    if (/var\(--cinder-(?:border-control-hover|control-border-hover)[,)]/.test(body)) {
      return borderControlHover;
    }
    if (/var\(--cinder-(?:border-control|control-border)[,)]/.test(body)) return borderControl;
    if (/var\(--cinder-border-muted\)/.test(body)) return borderMuted;
    if (/var\(--cinder-border-strong\)/.test(body)) return borderStrong;
    if (/var\(--cinder-border[,)]/.test(body)) return border;
    throw new Error(`No border-tier reference found in rule body: ${body}`);
  }

  const retunedSites: ReadonlyArray<{
    readonly name: string;
    readonly body: string;
    /** Set only when the tier reference lives in a different rule than the opacity (ResizablePanels). */
    readonly tierOverride?: TranslucentTokenArms;
  }> = [
    {
      name: 'SortableList placeholder outline',
      body: ruleBody(
        readComponentCss('sortable-list', 'sortable-list.css'),
        '.cinder-sortable-item--placeholder {',
      ),
    },
    {
      name: 'ResizablePanels handle line at rest',
      body: ruleBody(
        readComponentCss('resizable-panels', 'resizable-panels.css'),
        '.cinder-resizable-panels__handle-line {',
      ),
      // The tier (`border.control`) is set via `color` on the PARENT
      // `.cinder-resizable-panels__handle` rule and consumed here through
      // `currentColor` -- this rule body has no `var(--cinder-border*)` of
      // its own to parse, so the tier is pinned explicitly. The opacity this
      // site actually compounded with is still read from THIS rule's body.
      tierOverride: borderControl,
    },
    {
      name: 'AreaChart legend toggle border',
      body: ruleBody(
        readComponentCss('area-chart', 'area-chart.css'),
        "__legend button[aria-pressed='false'] {",
      ),
      tierOverride: borderControl,
    },
    {
      name: 'BarChart legend toggle border',
      body: ruleBody(
        readComponentCss('bar-chart', 'bar-chart.css'),
        "__legend button[aria-pressed='false'] {",
      ),
      tierOverride: borderControl,
    },
    {
      name: 'LineChart legend toggle border',
      body: ruleBody(
        readComponentCss('line-chart', 'line-chart.css'),
        "__legend button[aria-pressed='false'] {",
      ),
      tierOverride: borderControl,
    },
    {
      name: 'Select empty-state border',
      body: ruleBody(readComponentCss('select', 'select.css'), "[data-cinder-empty='true'] {"),
      tierOverride: borderControl,
    },
    {
      name: 'ParameterField rail',
      body: ruleBody(
        readComponentCss('parameter-field', 'parameter-field.css'),
        '.cinder-parameter-field__rail {',
      ),
    },
    {
      name: 'MegaMenu indicator track',
      body: ruleBody(
        readComponentCss('mega-menu', 'mega-menu.css'),
        '.cinder-mega-menu__indicator-track {',
      ),
    },
    {
      name: 'Slider tick',
      body: ruleBody(readComponentCss('slider', 'slider.css'), '.cinder-slider__tick {'),
    },
  ];

  const surfaces = { inset: surfaceInset, bg, surface, raised: surfaceRaised } as const;

  for (const arm of ['light', 'dark'] as const) {
    for (const site of retunedSites) {
      const tier = site.tierOverride ?? ruleTier(site.body);
      const elementOpacity = ruleOpacity(site.body);
      for (const [surfaceName, surfaceToken] of Object.entries(surfaces)) {
        it(`${arm}: ${site.name} clears 3:1 on ${surfaceName}`, () => {
          const effectiveInk: TranslucentColor = {
            ...tier[arm],
            alpha: tier[arm].alpha * elementOpacity,
          };
          expect(translucentContrastOn(effectiveInk, surfaceToken[arm])).toBeGreaterThanOrEqual(
            NON_TEXT,
          );
        });
      }
    }
  }
});

describe('COR-2010 row 08f: the skeleton fill stays visible on the canvas and the surface', () => {
  // A skeleton bar is a placeholder, not a control, so WCAG 1.4.11 does not apply; it only has to
  // read as a shape. The floor is the one the faint hairline holds (1.1:1), which both arms clear on
  // the page canvas and on the plain surface a card body paints. The dark arm is the raised
  // surface, never the surface itself, which is what keeps a bar inside a card from vanishing.
  const SKELETON_FLOOR = 1.1;
  const skeleton = values.readOklchToken('--cinder-skeleton-background');

  for (const arm of ['light', 'dark'] as const) {
    for (const [groundName, ground] of Object.entries({ canvas: bg, surface })) {
      it(`${arm}: the skeleton fill reads at least ${SKELETON_FLOOR}:1 on the ${groundName}`, () => {
        expect(
          contrastRatio(wcagLuminance(skeleton[arm]), wcagLuminance(ground[arm])),
        ).toBeGreaterThanOrEqual(SKELETON_FLOOR);
      });
    }
  }

  it('the dark skeleton fill is the raised surface, not the plain surface', () => {
    expect(skeleton.dark.l).toBeCloseTo(surfaceRaised.dark.l, 5);
    expect(skeleton.dark.l).not.toBeCloseTo(surface.dark.l, 2);
  });
});
