/**
 * COR-2450: a warning banner read beige beside a warning badge and a warning band. The shared
 * status-surface recipe painted it `oklch(from <warning solid> 94.5% 0.026 h)`, about
 * oklch(94.5% 0.026 77), while badges and bands paint `--cinder-status-warning-background`,
 * oklch(96.8% 0.035 88). In light, all three now paint that one token. The dark arm keeps the
 * recipe's value. happy-dom does not resolve `light-dark()` or `var()`, so the declarations are
 * pinned against the CSS source; `status-surface-recipe.playwright.ts` compares the painted colors
 * in a browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parse } from 'postcss';

import { declarationsFor } from '../../test/css.ts';

const COMPONENTS = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(COMPONENTS, path), 'utf8');

const banner = read('banner/banner.css');
const badge = read('badge/badge.css');
const stackedListItem = read('stacked-list-item/stacked-list-item.css');
const recipe = readFileSync(
  join(import.meta.dir, '..', '..', 'styles', 'components', '_status-surface.css'),
  'utf8',
);

const WARNING_TINT = 'var(--cinder-status-warning-background)';
const BANNER_WARNING = ".cinder-banner.cinder-_status-surface[data-cinder-variant='warning']";

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

describe('COR-2450: the warning banner shares the warning tint of badges and bands', () => {
  const warning = declarationsFor(banner, BANNER_WARNING);
  const ground = arms(warning.get('--_cinder-banner-warning-ground'));

  test('in light, the banner ground is the warning tint', () => {
    expect(ground.light).toBe(WARNING_TINT);
    expect(normalise(warning.get('background-color'))).toBe('var(--_cinder-banner-warning-ground)');
  });

  test('the banner border is its ground, so it draws no outline', () => {
    expect(normalise(warning.get('border-color'))).toBe(normalise(warning.get('background-color')));
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

  test('in dark, the banner ground is the shared recipe, unchanged', () => {
    const shared = arms(
      declarationsFor(recipe, '.cinder-_status-surface.cinder-_status-surface').get(
        'background-color',
      ),
    );
    expect(ground.dark).toBe(shared.dark);
  });

  test('the forced-colors reset repeats the warning selector, so system colors still win', () => {
    const reset = new Map<string, string>();
    parse(banner).walkAtRules('media', (atRule) => {
      if (atRule.params !== '(forced-colors: active)') return;
      atRule.walkRules((rule) => {
        if (normalise(rule.selector) !== BANNER_WARNING) return;
        rule.walkDecls((declaration) => {
          reset.set(declaration.prop, declaration.value);
        });
      });
    });
    expect(reset.get('background-color')).toBe('Canvas');
    expect(reset.get('border-color')).toBe('CanvasText');
  });
});
