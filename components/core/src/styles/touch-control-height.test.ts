/**
 * COR-2010 (B02, rows 04h and 08g): control size follows the pointer.
 *
 * A fine pointer keeps `--cinder-control-height-sm` / `-md` at 28px / 32px at every width (xs 24px,
 * lg 40px); under `(pointer: coarse)` every step becomes `--cinder-touch-target-min` (44px) and a
 * list-row minimum of 44px applies. These pin the CSS shape, because the media query cannot be evaluated here.
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
    expect(tokens).toContain('--cinder-control-height-xs: 1.5rem;');
    expect(tokens).toContain('--cinder-control-height-lg: 2.5rem;');
    expect(tokens).toContain('--cinder-list-row-min-height: 0px;');
    // No width query touches a control height: the size is the pointer's, not the viewport's.
    expect(foundation).not.toMatch(/@media[^{]*width[^{]*\{[^}]*--cinder-control-height/);
  });

  test('a coarse pointer makes every step, xs to lg, the 44px touch target', () => {
    const block = coarseBlock();
    expect(block).toContain('--cinder-control-height-xs: var(--cinder-touch-target-min);');
    expect(block).toContain('--cinder-control-height-lg: var(--cinder-touch-target-min);');
    expect(block).toContain('--cinder-control-height-sm: var(--cinder-touch-target-min);');
    expect(block).toContain('--cinder-control-height-md: var(--cinder-touch-target-min);');
    expect(tokens).toContain('--cinder-touch-target-min: 44px;');
  });

  test('a coarse pointer gives list rows a 44px minimum', () => {
    const block = coarseBlock();
    expect(block).toContain('--cinder-list-row-min-height: var(--cinder-touch-target-min);');
    expect(stackedListItem).toContain('min-block-size: var(--cinder-list-row-min-height);');
  });

  test('the override reaches Button through its alias, which resolves on the same :root', () => {
    expect(tokens).toContain('--cinder-button-height-sm: var(--cinder-control-height-sm);');
    expect(tokens).toContain('--cinder-button-height-md: var(--cinder-control-height-md);');
    expect(coarseBlock()).toMatch(/:root\s*\{/);
  });
});

/**
 * COR-2312: Button, the toggle Chip, SegmentedControl and the toolbar controls take every height
 * from a `--cinder-control-height-*` step, never a pixel literal, so the coarse-pointer block
 * above lifts each of them to the 44px touch target.
 */
describe('filled controls size from the control-height steps', () => {
  const component = (name: string) =>
    Bun.file(new URL(`../components/${name}/${name}.css`, import.meta.url)).text();
  // A control's height, not a rule's thickness: the tablist underline is a 2px `block-size`.
  const HEIGHT_LITERAL = /(?:^|[;{\s])(?:min-height|height|min-block-size):\s*[\d.]+px\b/m;

  test('no pixel literal sets a height in Button, Chip or SegmentedControl', async () => {
    for (const name of ['button', 'chip', 'segmented-control']) {
      expect(HEIGHT_LITERAL.test(await component(name)), name).toBe(false);
    }
  });

  test('a coarse pointer makes each of them 44px through the step it reads', async () => {
    const block = coarseBlock();
    const button = await component('button');
    for (const size of ['xs', 'sm', 'md', 'lg'] as const) {
      expect(button).toContain(`min-height: var(--cinder-button-height-${size});`);
      expect(tokens).toContain(
        `--cinder-button-height-${size}: var(--cinder-control-height-${size});`,
      );
      expect(block).toContain(`--cinder-control-height-${size}: var(--cinder-touch-target-min);`);
    }

    const chip = await component('chip');
    expect(chip).toMatch(
      /button\.cinder-chip \{[^}]*min-block-size: var\(--cinder-control-height-xs\);/,
    );
    expect(chip).toMatch(
      /\.cinder-chip\[data-cinder-density='toolbar'\] \{[^}]*min-block-size: var\(--cinder-control-height-sm\);/,
    );

    const segmented = await component('segmented-control');
    expect(segmented).toContain(
      '--_cinder-segmented-control-height: var(--cinder-control-height-md);',
    );
    expect(segmented).toContain(
      '--_cinder-segmented-control-height: var(--cinder-control-height-sm);',
    );
    expect(segmented).toContain(
      '--_cinder-segmented-control-height: var(--cinder-control-height-lg);',
    );
    // The track is the 1px padding around its options and no border, so a coarse step of 44px
    // gives a 44px track.
    expect(segmented).toContain(
      'min-block-size: calc(var(--_cinder-segmented-control-height) - 2px);',
    );
    expect(tokens).toContain('--cinder-touch-target-min: 44px;');
  });
});
