/**
 * A Button's layout box is its painted face on every pointer; on a coarse pointer the 44px hit
 * region is a pseudo-element that takes no layout space. Side padding is at least 1.5 times the
 * vertical padding at every size. The coarse media query cannot be evaluated here, so these pin
 * the CSS and token shapes.
 */
import { describe, expect, test } from 'bun:test';

const buttonCss = await Bun.file(new URL('./button.css', import.meta.url)).text();
const tokens = await Bun.file(new URL('../../styles/tokens-base.css', import.meta.url)).text();

const rem = (name: string): number => {
  const space = new RegExp(`--cinder-space-${name.replace('.', '-')}:\\s*([\\d.]+)rem;`).exec(
    tokens,
  );
  return Number(space?.[1]);
};

const paddingToken = (axis: 'x' | 'y', size: string): number => {
  const match = new RegExp(
    `--cinder-button-padding-${axis}-${size}:\\s*var\\(--cinder-space-([\\d-]+)\\)`,
  ).exec(tokens);
  if (match === null) throw new Error(`no ${axis} padding token for ${size}`);
  return rem(match[1] as string);
};

describe('button proportions', () => {
  test('sm side padding is space-3 and md is space-4', () => {
    expect(tokens).toContain('--cinder-button-padding-x-sm: var(--cinder-space-3);');
    expect(tokens).toContain('--cinder-button-padding-x-md: var(--cinder-space-4);');
  });

  for (const size of ['xs', 'sm', 'md', 'lg']) {
    test(`${size}: side padding is at least 1.5 times the vertical padding`, () => {
      expect(paddingToken('x', size)).toBeGreaterThanOrEqual(1.5 * paddingToken('y', size));
    });
  }
});

describe('coarse pointer hit area', () => {
  const coarse = buttonCss.slice(buttonCss.indexOf('@media (any-pointer: coarse) {'));

  test('the hit region is a positioned pseudo-element of at least 44px', () => {
    const rule = /\[data-cinder-hit-target='44'\]::before\s*\{[^}]*\}/s.exec(coarse)?.[0] ?? '';
    expect(rule).toContain('position: absolute;');
    expect(rule).toMatch(
      /inset-block:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\)/,
    );
    expect(rule).toMatch(
      /inset-inline:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\)/,
    );
    expect(coarse).toMatch(/\[data-cinder-hit-target='44'\]\s*\{\s*position:\s*relative;/);
  });

  test('the layout box keeps the painted height of each size', () => {
    for (const size of ['xs', 'sm', 'md', 'lg']) {
      expect(coarse).toMatch(
        new RegExp(
          `\\[data-cinder-size='${size}'\\]\\s*\\{\\s*min-height:\\s*var\\(--_cinder-painted-height-${size}\\);`,
        ),
      );
    }
    expect(coarse).not.toContain('min-height: var(--cinder-touch-target-min)');
    expect(coarse).not.toContain('border:');
    expect(coarse).not.toContain('border-width');
  });
});

describe('an icon passed as the button’s own child', () => {
  test('is sized by the button size step, so a bare 24px icon does not stretch the button', () => {
    // A split button's caret (the trigger drawn as a Button) keeps its own size.
    const direct = '> svg:not\\(\\.cinder-dropdown-trigger__caret\\)';
    expect(buttonCss).toMatch(new RegExp(`\\.cinder-button ${direct} \\{`));
    expect(buttonCss).toMatch(
      new RegExp(`\\[data-cinder-size='sm'\\] ${direct} \\{[^}]*0\\.875rem`),
    );
    expect(buttonCss).toMatch(
      new RegExp(`\\[data-cinder-size='xs'\\] ${direct} \\{[^}]*0\\.75rem`),
    );
    expect(buttonCss).toMatch(
      new RegExp(`\\[data-cinder-size='lg'\\] ${direct} \\{[^}]*1\\.25rem`),
    );
  });
});

describe('adjacent compact icon-only header buttons on a coarse pointer (COR-2388)', () => {
  const COMPACT =
    ".cinder-button[data-cinder-hit-target='44'][data-cinder-compact][data-cinder-icon-only]";

  test('the gap holds both 44px hit-area extensions, and the drawn size stays 24px', () => {
    const next = declarationsFor(buttonCss, `${COMPACT} + ${COMPACT}`);
    // Header actions are spaced by space-2 (8px); the margin tops the pitch up so the two
    // extensions, (44 - 24) / 2 on each side of each button, do not overlap.
    expect(next.get('margin-inline-start')).toBe(
      'calc(var(--cinder-touch-target-min) - var(--_cinder-compact-control-height) - var(--cinder-space-2))',
    );
    const gap = rem('2') * 16;
    const touch = Number(/--cinder-touch-target-min:\s*(\d+)px/.exec(tokens)?.[1]);
    const drawn = 24;
    expect(gap + (touch - drawn - gap)).toBeGreaterThanOrEqual(touch - drawn);
    expect(touch - drawn - gap).toBeGreaterThan(0);
    // The visible button keeps its drawn size.
    expect(declarationsFor(buttonCss, COMPACT).get('min-width')).toBe(
      'var(--_cinder-compact-control-height)',
    );
  });
});
