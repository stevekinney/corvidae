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
  borderContrast,
  borderContrastHover,
  borderControl,
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
    if (/var\(--cinder-border-contrast-hover[,)]/.test(body)) return borderContrastHover;
    if (/var\(--cinder-border-contrast[,)]/.test(body)) return borderContrast;
    // A control edge is quiet by owner decision; anything this suite holds to 3:1 has to name
    // the contrast tier, so a control-tier reference here is a site that was missed.
    if (/var\(--cinder-(?:border-control|control-border)(?:-hover)?[,)]/.test(body)) {
      throw new Error(`An indicator held to 3:1 reads the quiet control tier: ${body}`);
    }
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
    /**
     * Set for a control's own resting edge. The owner decided on 2026-11-11 that this edge is the
     * quiet control tier, not 3:1, so what CIN-603 still guards here is the dilution it removed:
     * the edge keeps its tier's full alpha and stays heavier than a container's edge.
     */
    readonly controlEdge?: true;
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
      // The tier (`border.contrast`) is set via `color` on the PARENT
      // `.cinder-resizable-panels__handle` rule and consumed here through
      // `currentColor` -- this rule body has no `var(--cinder-border*)` of
      // its own to parse, so the tier is pinned explicitly. The opacity this
      // site actually compounded with is still read from THIS rule's body.
      tierOverride: borderContrast,
    },
    {
      name: 'AreaChart legend toggle border',
      body: ruleBody(
        readComponentCss('area-chart', 'area-chart.css'),
        "__legend button[aria-pressed='false'] {",
      ),
      tierOverride: borderControl,
      controlEdge: true,
    },
    {
      name: 'BarChart legend toggle border',
      body: ruleBody(
        readComponentCss('bar-chart', 'bar-chart.css'),
        "__legend button[aria-pressed='false'] {",
      ),
      tierOverride: borderControl,
      controlEdge: true,
    },
    {
      name: 'LineChart legend toggle border',
      body: ruleBody(
        readComponentCss('line-chart', 'line-chart.css'),
        "__legend button[aria-pressed='false'] {",
      ),
      tierOverride: borderControl,
      controlEdge: true,
    },
    {
      name: 'Select empty-state border',
      body: ruleBody(readComponentCss('select', 'select.css'), "[data-cinder-empty='true'] {"),
      tierOverride: borderControl,
      controlEdge: true,
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
        const effectiveInk: TranslucentColor = {
          ...tier[arm],
          alpha: tier[arm].alpha * elementOpacity,
        };
        if (site.controlEdge) {
          it(`${arm}: ${site.name} keeps the undiluted control edge on ${surfaceName}`, () => {
            expect(elementOpacity).toBe(1);
            expect(translucentContrastOn(effectiveInk, surfaceToken[arm])).toBeGreaterThan(
              translucentContrastOn(borderStrong[arm], surfaceToken[arm]),
            );
          });
          continue;
        }
        it(`${arm}: ${site.name} clears 3:1 on ${surfaceName}`, () => {
          expect(translucentContrastOn(effectiveInk, surfaceToken[arm])).toBeGreaterThanOrEqual(
            NON_TEXT,
          );
        });
      }
    }
  }
});

describe('the warning indicator clears 3:1 on every surface a lone dot sits on', () => {
  // A warning dot (StatusDot, the collapsed rail's count dot, Statistic's attention dot, the
  // FilterBar toggle dot) is often the only sign of the warning, so WCAG 1.4.11 holds it to 3:1.
  // The bright `status.warning.solid` read about 1.9:1 on the light surfaces; the indicator token
  // is the darker step in light and the solid itself in dark.
  const indicator = values.readOklchToken('--cinder-status-warning-indicator');
  const grounds = { canvas: bg, surface, raised: surfaceRaised, inset: surfaceInset };

  for (const arm of ['light', 'dark'] as const) {
    for (const [groundName, ground] of Object.entries(grounds)) {
      it(`${arm}: the warning indicator reads at least 3:1 on the ${groundName}`, () => {
        expect(
          contrastRatio(wcagLuminance(indicator[arm]), wcagLuminance(ground[arm])),
        ).toBeGreaterThanOrEqual(NON_TEXT);
      });
    }
  }

  const componentsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'components');
  const dotSites: ReadonlyArray<readonly [name: string, file: string, selector: string]> = [
    ['StatusDot', 'status-dot/status-dot.css', "[data-cinder-status='warning'] {"],
    [
      'SideNavigationItem collapsed count dot',
      'side-navigation-item/side-navigation-item.css',
      '.cinder-side-navigation-item__count {\n    position: absolute;',
    ],
    ['Statistic attention dot', 'statistic/statistic.css', '.cinder-statistic__attention {'],
    ['FilterBar toggle dot', 'filter-bar/filter-bar.css', '.cinder-filter-bar__dot {'],
    ['SettingRow dot', 'setting-row/setting-row.css', '.cinder-setting-row__dot {'],
    [
      'ToolCallRail waiting count dot',
      'tool-call-rail/tool-call-rail.css',
      "[data-cinder-count='waiting'] .cinder-tool-call-rail__count-dot {",
    ],
    [
      'FeedEvent warning dot',
      'feed-event/feed-event.css',
      "[data-cinder-tone='warning'] .cinder-feed-event-dot {",
    ],
  ];
  for (const [name, file, selector] of dotSites) {
    it(`${name} fills with the warning indicator, not the bright solid`, () => {
      const body = ruleBody(readFileSync(join(componentsDirectory, file), 'utf8'), selector);
      expect(body).toContain('var(--cinder-status-warning-indicator)');
      expect(body).not.toContain('var(--cinder-status-warning-solid)');
    });
  }
});

describe('the skeleton fill is a visible step over every surface a bar sits on', () => {
  // A skeleton bar is a placeholder, not a control, so WCAG 1.4.11 does not apply; it only has to
  // read as a shape. The fill is a 12% alpha step over the border ink, so it is the same step over
  // the canvas, the surface a list or card body paints, raised and the inset. The opaque fills it
  // replaced read about 1.05:1 in light on the surface (the inset bars) and vanished in dark on a
  // raised statistic card (the raised bars).
  const SKELETON_FLOOR = 1.15;
  const skeleton = values.readTranslucentToken('--cinder-skeleton-background');
  const grounds = { canvas: bg, surface, raised: surfaceRaised, inset: surfaceInset };

  for (const arm of ['light', 'dark'] as const) {
    for (const [groundName, ground] of Object.entries(grounds)) {
      it(`${arm}: the skeleton fill reads at least ${SKELETON_FLOOR}:1 on the ${groundName}`, () => {
        expect(translucentContrastOn(skeleton[arm], ground[arm])).toBeGreaterThanOrEqual(
          SKELETON_FLOOR,
        );
      });
    }
  }
});
