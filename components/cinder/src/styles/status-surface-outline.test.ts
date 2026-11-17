/**
 * COR-1552: Alert, Banner and Callout compose the shared soft-surface recipe, and the
 * recipe draws no visible outline. Its border is still there, so the box keeps its size,
 * but it is painted in the surface's own background in both arms.
 *
 * `alert.css.test.ts` and `status-surface-recipe.playwright.ts` keep asserting the shape
 * this one leaves alone: the border is still a `light-dark(oklch(from var(--_cinder-status-base) …))`
 * expression, and a danger border still differs from a success one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const source = readFileSync(join(import.meta.dir, 'components', '_status-surface.css'), 'utf8');

function ruleBody(selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing rule ${selector}`);
  const open = source.indexOf('{', start);
  return source.slice(open + 1, source.indexOf('}', open));
}

function declaration(body: string, property: string): string {
  const match = body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`));
  if (match?.[1] === undefined) throw new Error(`Missing ${property}`);
  return match[1].replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
}

describe('the shared soft-surface recipe draws no outline', () => {
  const surface = ruleBody('.cinder-_status-surface.cinder-_status-surface');
  const border = ruleBody('.cinder-_status-surface-border.cinder-_status-surface-border');

  test('the border-color arms equal the background-color arms', () => {
    expect(declaration(border, 'border-color')).toBe(declaration(surface, 'background-color'));
  });

  test('the border is still a status-hued light-dark expression', () => {
    expect(declaration(border, 'border-color')).toMatch(
      /^light-dark\(oklch\(from var\(--_cinder-status-base\) [\d.]+% [\d.]+ h\), oklch\(from var\(--_cinder-status-base\) [\d.]+% [\d.]+ h\)\)$/,
    );
  });

  test('forced-colors mode keeps its CanvasText border', () => {
    const forced = source.slice(source.indexOf('@media (forced-colors: active)'));
    expect(forced).toMatch(/border-color:\s*CanvasText/);
  });
});
