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
  const coarse = buttonCss.slice(buttonCss.indexOf('@media (pointer: coarse) {'));

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
