/**
 * COR-2010 (B02, rows 04h and 08g): control size follows the pointer.
 *
 * A fine pointer keeps `--cinder-control-height-sm` / `-md` at 28px / 32px at every width; under
 * `(pointer: coarse)` both become `--cinder-touch-target-min` (44px) and a list-row minimum of
 * 44px applies. These pin the CSS shape, because the media query cannot be evaluated here.
 */
import { describe, expect, test } from 'bun:test';

const foundation = await Bun.file(new URL('./foundation.css', import.meta.url)).text();
const tokens = await Bun.file(new URL('./tokens-base.css', import.meta.url)).text();
const stackedListItem = await Bun.file(
  new URL('../components/stacked-list-item/stacked-list-item.css', import.meta.url),
).text();

/** The body of the one `@media (pointer: coarse)` block in foundation.css. */
function coarseBlock(): string {
  const start = foundation.indexOf('@media (pointer: coarse)');
  expect(start, 'foundation.css has a (pointer: coarse) block').toBeGreaterThan(-1);
  expect(foundation.indexOf('@media (pointer: coarse)', start + 1), 'only one block').toBe(-1);
  const open = foundation.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < foundation.length; index += 1) {
    if (foundation[index] === '{') depth += 1;
    if (foundation[index] === '}') {
      depth -= 1;
      if (depth === 0) return foundation.slice(open + 1, index);
    }
  }
  throw new Error('unterminated (pointer: coarse) block');
}

describe('control heights keyed to the pointer', () => {
  test('a fine pointer keeps 28px and 32px, whatever the width', () => {
    expect(tokens).toContain('--cinder-control-height-sm: 1.75rem;');
    expect(tokens).toContain('--cinder-control-height-md: 2rem;');
    expect(tokens).toContain('--cinder-list-row-min-height: 0px;');
    // No width query touches a control height: the size is the pointer's, not the viewport's.
    expect(foundation).not.toMatch(/@media[^{]*width[^{]*\{[^}]*--cinder-control-height/);
  });

  test('a coarse pointer makes the sm and md steps the 44px touch target', () => {
    const block = coarseBlock();
    expect(block).toContain('--cinder-control-height-sm: var(--cinder-touch-target-min);');
    expect(block).toContain('--cinder-control-height-md: var(--cinder-touch-target-min);');
    expect(tokens).toContain('--cinder-touch-target-min: 44px;');
  });

  test('a coarse pointer gives list rows a 44px minimum, and no other step moves', () => {
    const block = coarseBlock();
    expect(block).toContain('--cinder-list-row-min-height: var(--cinder-touch-target-min);');
    expect(block).not.toContain('--cinder-control-height-xs');
    expect(block).not.toContain('--cinder-control-height-lg');
    expect(stackedListItem).toContain('min-block-size: var(--cinder-list-row-min-height);');
  });

  test('the override reaches Button through its alias, which resolves on the same :root', () => {
    expect(tokens).toContain('--cinder-button-height-sm: var(--cinder-control-height-sm);');
    expect(tokens).toContain('--cinder-button-height-md: var(--cinder-control-height-md);');
    expect(coarseBlock()).toMatch(/:root\s*\{/);
  });
});
