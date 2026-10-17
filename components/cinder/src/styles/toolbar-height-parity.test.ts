/**
 * A small Button, a toolbar SegmentedControl, and a toolbar Chip share one
 * row in editor toolbars, and SegmentedControl's `density="toolbar"` documents
 * that it lines up with `size="sm"` Buttons. That held only for Chip: Button's
 * small height was its own 1.75rem while the other two pinned the 2rem
 * `control.height.sm`. Each component's declared height is resolved here
 * through the generated token stylesheet, so a drift in any one of the three,
 * or in the tokens between them, fails.
 */

import { describe, expect, test } from 'bun:test';
import { parse, type Rule } from 'postcss';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const tokens = parse(await read('./tokens-base.css'));
const rootValues = new Map<string, string>();
tokens.walkRules((rule: Rule) => {
  if (rule.selector !== ':root') return;
  rule.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--')) rootValues.set(declaration.prop, declaration.value);
  });
});

/** Follows `var()` aliases through the `:root` declarations to a literal. */
function resolve(value: string, seen = new Set<string>()): string {
  const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (!match) return value.trim();
  const name = match[1]!;
  if (seen.has(name)) throw new Error(`alias cycle at ${name}`);
  const next = rootValues.get(name);
  if (next === undefined) throw new Error(`${name} is not declared at :root`);
  return resolve(next, new Set([...seen, name]));
}

async function declaredHeight(path: string, selector: string, property: string): Promise<string> {
  let value: string | undefined;
  parse(await read(path)).walkRules((rule: Rule) => {
    if (rule.selector.replace(/\s+/g, ' ') !== selector) return;
    rule.walkDecls(property, (declaration) => {
      value = declaration.value;
    });
  });
  if (value === undefined) throw new Error(`${selector} declares no ${property} in ${path}`);
  return resolve(value);
}

describe('toolbar row heights', () => {
  test('Button sm, SegmentedControl toolbar, and Chip toolbar are the same height', async () => {
    const heights = {
      button: await declaredHeight(
        '../components/button/button.css',
        ".cinder-button[data-cinder-size='sm']",
        'min-height',
      ),
      segmentedControl: await declaredHeight(
        '../components/segmented-control/segmented-control.css',
        ".cinder-segmented-control[data-cinder-density='toolbar'] .cinder-segmented-control-option",
        'min-block-size',
      ),
      chip: await declaredHeight(
        '../components/chip/chip.css',
        ".cinder-chip[data-cinder-density='toolbar']",
        'min-block-size',
      ),
    };
    expect(heights).toEqual({ button: '2rem', segmentedControl: '2rem', chip: '2rem' });
  });

  test('the small Button height is the shared control height, not its own value', () => {
    expect(rootValues.get('--cinder-button-height-sm')).toBe('var(--cinder-control-height-sm)');
  });
});
