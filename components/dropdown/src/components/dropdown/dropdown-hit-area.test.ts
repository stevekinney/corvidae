/**
 * COR-2327 B2: a Dropdown trigger's layout box is a Button's painted face on a coarse pointer, and
 * its 44px hit region is a positioned pseudo-element that takes no layout space, as Button's is. A
 * fine pointer keeps the trigger's rule as it was. A trigger drawn as a Button (`.cinder-button`)
 * takes the Button's own height and hit area, so these rules leave it alone. The coarse media query
 * cannot be evaluated here, so these pin the CSS;
 * `scripts/browser-fixtures/tests/dropdown-trigger-hit-area.playwright.ts` measures it in a browser.
 */
import { describe, expect, test } from 'bun:test';

const css = await Bun.file(new URL('./dropdown.css', import.meta.url)).text();
const coarseStart = css.indexOf('@media (any-pointer: coarse) {');
const coarse = css.slice(coarseStart, css.indexOf('\n  }\n', coarseStart));
const fine = css.slice(0, coarseStart);
const OWN_FACE = String.raw`\.cinder-dropdown-trigger:not\(\.cinder-button\)`;

describe('Dropdown trigger hit area', () => {
  test('a fine pointer keeps the trigger at the md button height, with no hit-area pseudo-element', () => {
    const rule = new RegExp(`${OWN_FACE} \\{([^}]*)\\}`, 'su').exec(fine)?.[1] ?? '';
    expect(rule).toContain('min-block-size: var(--cinder-button-height-md);');
    expect(rule).not.toContain('position:');
    expect(fine).not.toMatch(/dropdown-trigger[^{]*::before/u);
  });

  test('a coarse pointer paints the trigger at the md painted height', () => {
    expect(coarseStart).toBeGreaterThan(-1);
    const rule = new RegExp(`${OWN_FACE} \\{([^}]*)\\}`, 'su').exec(coarse)?.[1] ?? '';
    expect(rule).toContain('position: relative;');
    expect(rule).toContain('min-block-size: var(--_cinder-painted-height-md);');
    expect(coarse).not.toContain('min-block-size: var(--cinder-touch-target-min)');
  });

  test('the coarse hit region is a positioned pseudo-element of at least 44px, on the trigger’s own face only', () => {
    const rule = new RegExp(`${OWN_FACE}::before \\{([^}]*)\\}`, 'su').exec(coarse)?.[1] ?? '';
    expect(rule).toContain("content: '';");
    expect(rule).toContain('position: absolute;');
    expect(rule).toMatch(
      /inset-block:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\)/u,
    );
    expect(rule).toMatch(
      /inset-inline:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\)/u,
    );
    // A Button-faced trigger keeps the Button's own rules.
    expect(coarse).not.toMatch(/\.cinder-dropdown-trigger(::before)? \{/u);
  });
});
