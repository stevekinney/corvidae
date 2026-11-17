/**
 * COR-2450: a warning banner, alert or callout read beige beside a warning badge and a warning
 * band. The shared status-surface recipe painted them `oklch(from <warning solid> 94.5% 0.026 h)`,
 * about oklch(94.5% 0.026 77), while badges and bands paint `--cinder-status-warning-background`,
 * oklch(96.8% 0.035 88). In light, all of them now paint that one token: the recipe names it as
 * the light ground of every warning surface. The dark arm keeps the recipe's value. happy-dom does not resolve
 * `light-dark()` or `var()`, so the declarations are pinned against the CSS source;
 * `status-surface-recipe.playwright.ts` compares the painted colors in a browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { cinderComponentFile } from '@lostgradient/component-tooling/scripts/discover-component-directories.ts';
import { declarationsFor } from '@lostgradient/component-tooling/test/css.ts';

// A component's stylesheet, in whichever Cinder package holds the component.
const read = (path: string): string => readFileSync(cinderComponentFile(path), 'utf8');

const badge = read('badge/badge.css');
const stackedListItem = read('stacked-list-item/stacked-list-item.css');
const recipe = readFileSync(
  join(import.meta.dir, '..', '..', 'styles', 'components', '_status-surface.css'),
  'utf8',
);

const WARNING_TINT = 'var(--cinder-status-warning-background)';
const GROUND_INPUT = '--_cinder-status-ground-light';

function normalise(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
}

/** The two arms of a `light-dark(light, dark)` value, split at its top-level comma. */
function arms(value: string | undefined): { light: string; dark: string } {
  const text = normalise(value);
  const match = text.match(/^light-dark\((.*)\)$/);
  if (match?.[1] === undefined) throw new Error(`Not a light-dark() value: ${text}`);
  const inner = match[1];
  let depth = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      return { light: inner.slice(0, index).trim(), dark: inner.slice(index + 1).trim() };
    }
  }
  throw new Error(`No top-level comma in ${text}`);
}

describe('COR-2450: warning Banner, Alert and Callout share the warning tint of badges and bands', () => {
  test('the recipe names the warning tint as the light ground of every warning surface', () => {
    const warning = declarationsFor(
      recipe,
      ".cinder-_status-surface[data-cinder-variant='warning']",
    );
    expect(normalise(warning.get(GROUND_INPUT))).toBe(WARNING_TINT);
    // No other status names a ground, so info, success and danger keep the synthesized tint.
    expect(recipe.match(new RegExp(`${GROUND_INPUT}:`, 'g'))?.length).toBe(2);
  });

  test('Banner, Alert and Callout each compose the recipe and mark their variant on the same element', () => {
    for (const component of ['banner', 'alert', 'callout']) {
      const markup = read(`${component}/${component}.svelte`);
      expect(markup, component).toContain("'cinder-_status-surface'");
      expect(markup, component).toContain("'cinder-_status-surface-border'");
      expect(markup, component).toMatch(/data-cinder-variant=\{/);
    }
  });

  test('no composer names its own ground, so the three cannot split again', () => {
    for (const component of ['banner', 'alert', 'callout']) {
      expect(read(`${component}/${component}.css`), component).not.toContain(GROUND_INPUT);
    }
  });

  test('the recipe paints the ground, in light only, as background and border', () => {
    const surface = arms(
      declarationsFor(recipe, '.cinder-_status-surface.cinder-_status-surface').get(
        'background-color',
      ),
    );
    const border = arms(
      declarationsFor(recipe, '.cinder-_status-surface-border.cinder-_status-surface-border').get(
        'border-color',
      ),
    );
    expect(surface.light.startsWith(`var(${GROUND_INPUT}, `)).toBe(true);
    expect(surface.dark).not.toContain(GROUND_INPUT);
    expect(border).toEqual(surface);
  });

  test('every status surface resets the ground at zero specificity, so a nested one never inherits it', () => {
    const reset = declarationsFor(recipe, ':where(.cinder-_status-surface)');
    expect(reset.get(GROUND_INPUT)).toBe('initial');
  });

  test('a warning badge paints the same tint', () => {
    expect(
      normalise(
        declarationsFor(badge, ".cinder-badge[data-cinder-variant='warning']").get('background'),
      ),
    ).toBe(WARNING_TINT);
  });

  test('a warning band paints the same tint', () => {
    expect(
      normalise(
        declarationsFor(
          stackedListItem,
          '.cinder-stacked-list-item--tone-warning .cinder-stacked-list-item__band-surface',
        ).get('background'),
      ),
    ).toBe(WARNING_TINT);
  });
});
