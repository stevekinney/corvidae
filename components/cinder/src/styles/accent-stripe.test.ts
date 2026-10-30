/**
 * COR-1821: a status surface is a tint and an icon inside one edge, and a selected row is a tint
 * only. No accent stripe, which is a thicker or saturated `border-inline-start`, remains on
 * Callout, on a vertical NavigationItem, on RunStepTimeline's detail panels and lanes, on
 * CapabilityGate's callout presentation, on NavigationBar's mobile active row, or on the
 * JsonSchemaEditor's invalid property row. A selection that loses its tint under
 * `forced-colors: active` keeps a system-colour cue, so it is never invisible.
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
const capabilityGate = load('../components/capability-gate/capability-gate.css');
const jsonSchemaEditor = load('../components/json-schema-editor/json-schema-editor.css');
const navigationBar = load('../components/navigation-bar/navigation-bar.css');
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

  test('a vertical NavigationItem keeps a visible active cue under forced colors', () => {
    expect(navigationItem).toMatch(
      /@media \(forced-colors: active\)\s*\{[^@]*?\.cinder-navigation-item\[data-variant='vertical'\]\[data-active='true'\]\s*\{[^}]*background-color:\s*SelectedItem;[^}]*color:\s*SelectedItemText/s,
    );
  });

  test('NavigationBar mobile active rows are a tint with a forced-colors cue, never a stripe', () => {
    expect(stripeRules(navigationBar)).toEqual([]);
    expect(navigationBar).toMatch(
      /\.cinder-navigation-item\[data-variant='mobile'\]\[data-active='true'\]\s*\{[^}]*background-color:\s*var\(--cinder-surface-inset\)/s,
    );
    expect(navigationBar).toMatch(
      /@media \(forced-colors: active\)\s*\{[^@]*?\.cinder-navigation-item\[data-variant='mobile'\]\[data-active='true'\]\s*\{[^}]*background-color:\s*SelectedItem;[^}]*color:\s*SelectedItemText/s,
    );
  });

  test('CapabilityGate draws no inline-start stripe in any presentation', () => {
    expect(stripeRules(capabilityGate)).toEqual([]);
  });

  test('the JsonSchemaEditor invalid property row is tinted, never striped', () => {
    expect(stripeRules(jsonSchemaEditor)).toEqual([]);
    expect(jsonSchemaEditor).toMatch(
      /\.cinder-jse-property-row\[data-cinder-invalid\][^{]*\{[^}]*background-color:\s*var\(--cinder-status-danger-background\)/s,
    );
  });

  test('Callout and RunStepTimeline selections stay visible under forced colors', () => {
    expect(callout).toMatch(
      /@media \(forced-colors: active\)\s*\{\s*\.cinder-callout\s*\{\s*border:\s*1px solid CanvasText/s,
    );
    expect(runStepTimeline).toMatch(
      /@media \(forced-colors: active\)[\s\S]*?\[data-cinder-selected\] \.cinder-run-step-timeline__event\s*\{[^}]*outline:\s*1px solid Highlight/,
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
