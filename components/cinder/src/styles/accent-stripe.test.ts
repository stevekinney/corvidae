/**
 * COR-1821: a status surface is a tint and an icon inside one edge, and a selected row is a tint
 * only. No accent stripe, which is a thicker or saturated `border-inline-start`, remains on
 * Callout, on a vertical NavigationItem, or on RunStepTimeline's detail panels and lanes.
 *
 * Markdown blockquotes keep their rule (`utilities.css`), and the other edges in the repository
 * (drawer, segmented-control and date-picker dividers, the compensation connector) are not
 * stripes, so the scan names the stylesheets it covers instead of sweeping the whole tree.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import { parse, type Rule } from 'postcss';

function load(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const stripeProperty = /^border-(?:inline-start|left)(?:-(?:width|color|style))?$/;

/** Every rule in `css` that declares an inline-start border longhand or shorthand. */
function stripeRules(css: string): string[] {
  const found: string[] = [];
  parse(css).walkRules((rule: Rule) => {
    rule.walkDecls((declaration) => {
      if (stripeProperty.test(declaration.prop)) {
        found.push(`${rule.selector} { ${declaration.prop}: ${declaration.value} }`);
      }
    });
  });
  return found;
}

const callout = load('../components/callout/callout.css');
const calloutMarkup = load('../components/callout/callout.svelte');
const navigationItem = load('../components/navigation-item/navigation-item.css');
const runStepTimeline = load('../components/run-step-timeline/run-step-timeline.css');
const statusSurface = load('./components/_status-surface.css');
const utilities = load('./utilities.css');

describe('no accent stripe remains on the listed components', () => {
  test('Callout draws no inline-start border stripe', () => {
    expect(stripeRules(callout)).toEqual([]);
  });

  test('a vertical NavigationItem marks the active row with a tint, never a stripe', () => {
    expect(stripeRules(navigationItem)).toEqual([]);
    expect(navigationItem).toMatch(
      /\[data-variant='vertical'\]\[data-active='true'\]\s*\{[^}]*background-color:\s*var\(--cinder-surface-inset\)/s,
    );
  });

  test('RunStepTimeline detail panels and lanes draw no accent stripe', () => {
    const remaining = stripeRules(runStepTimeline);
    // The dashed compensation connector is a connector drawn on a pseudo-element, not a stripe.
    expect(remaining).toEqual([
      '.cinder-run-step-timeline__item[data-cinder-compensation]::after { border-inline-start: 1px dashed var(--cinder-border-strong) }',
    ]);
  });

  test('the shared status surface no longer ships a stripe recipe', () => {
    expect(stripeRules(statusSurface)).toEqual([]);
    expect(statusSurface).not.toContain('_status-surface-stripe');
    expect(statusSurface).not.toContain('--_cinder-status-stripe-chroma');
  });

  test('Callout markup and variant inputs do not compose the stripe', () => {
    expect(calloutMarkup).not.toContain('_status-surface-stripe');
    expect(callout).not.toContain('--_cinder-status-stripe-chroma');
  });

  test('Callout keeps the same radius on every corner', () => {
    expect(callout).not.toMatch(/border-(?:start|end)-start-radius/);
  });

  test('Markdown blockquotes keep their rule', () => {
    expect(stripeRules(utilities)).toEqual([
      '.cinder-markdown-content :where(blockquote) { border-inline-start: 3px solid var(--cinder-border-strong) }',
    ]);
  });
});
