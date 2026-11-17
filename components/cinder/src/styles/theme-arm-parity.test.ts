/**
 * `:root` and the `[data-theme]` blocks must agree.
 *
 * `:root` carries each themed token as `light-dark(a, b)`, read under the OS
 * color scheme; `[data-theme='light']` and `[data-theme='dark']` carry the
 * same token for an explicitly themed page or island. The two come from
 * different corpus fields (a recipe versus each theme's `$value`), so they can
 * disagree, and when they do a page renders differently depending on whether
 * the theme came from the OS or from an attribute. That is how dark shadows
 * glowed white at `:root` while `[data-theme='dark']` pinned them black.
 *
 * For every `:root` value containing `light-dark()` (top level or nested, as
 * shadow layers nest it), substituting each call's light arm must give the
 * light block's declaration and its dark arm the dark block's. A block may
 * also restate the whole `light-dark()` value, which resolves to the same arm
 * under that block's own `color-scheme`.
 */

import { describe, expect, test } from 'bun:test';
import { parse, type Rule } from 'postcss';

const css = await Bun.file(new URL('./tokens-base.css', import.meta.url)).text();

function declarations(selector: string): Map<string, string> {
  const values = new Map<string, string>();
  parse(css).walkRules((rule: Rule) => {
    if (rule.selector !== selector || rule.parent?.type !== 'root') return;
    rule.walkDecls((declaration) => {
      if (declaration.prop.startsWith('--'))
        values.set(declaration.prop, normalize(declaration.value));
    });
  });
  return values;
}

const normalize = (value: string): string =>
  value
    .replace(/\s+/g, ' ')
    .replace(/\(\s/g, '(')
    .replace(/\s\)/g, ')')
    .replace(/\s,/g, ',')
    .trim();

/** Replaces every `light-dark(a, b)` with one arm, innermost calls included. */
export function selectArm(value: string, arm: 'light' | 'dark'): string {
  const marker = 'light-dark(';
  for (;;) {
    const start = value.lastIndexOf(marker);
    if (start === -1) return normalize(value);
    let depth = 0;
    let comma = -1;
    let end = -1;
    for (let index = start + marker.length; index < value.length; index += 1) {
      const character = value[index];
      if (character === '(') depth += 1;
      else if (character === ')') {
        if (depth === 0) {
          end = index;
          break;
        }
        depth -= 1;
      } else if (character === ',' && depth === 0 && comma === -1) comma = index;
    }
    if (comma === -1 || end === -1) throw new Error(`malformed light-dark() in "${value}"`);
    const chosen =
      arm === 'light' ? value.slice(start + marker.length, comma) : value.slice(comma + 1, end);
    value = value.slice(0, start) + chosen.trim() + value.slice(end + 1);
  }
}

describe('light-dark() arms agree with the [data-theme] blocks', () => {
  const root = declarations(':root');
  const blocks = {
    light: declarations("[data-theme='light']"),
    dark: declarations("[data-theme='dark']"),
  } as const;

  test('selectArm handles nested and layered calls', () => {
    expect(selectArm('0 1px light-dark(red, blue), 0 2px light-dark(a(b, c), d)', 'dark')).toBe(
      '0 1px blue, 0 2px d',
    );
    expect(selectArm('light-dark(a(b, c), d)', 'light')).toBe('a(b, c)');
  });

  for (const arm of ['light', 'dark'] as const) {
    test(`[data-theme='${arm}'] matches the ${arm} arm of every :root light-dark()`, () => {
      const mismatches: string[] = [];
      for (const [property, value] of root) {
        if (!value.includes('light-dark(')) continue;
        const declared = blocks[arm].get(property);
        if (declared === undefined || declared === value) continue;
        const expected = selectArm(value, arm);
        if (declared !== expected) {
          mismatches.push(
            `${property}\n  :root ${arm} arm: ${expected}\n  block:           ${declared}`,
          );
        }
      }
      expect(mismatches, mismatches.join('\n')).toEqual([]);
    });
  }
});
