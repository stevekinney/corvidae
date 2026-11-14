/**
 * COR-2327 B2: a Dropdown trigger's layout box is a Button's painted face on a coarse pointer, and
 * its 44px hit region is a positioned pseudo-element that takes no layout space, as Button's is. A
 * fine pointer keeps the trigger's rule as it was. The coarse media query cannot be evaluated here,
 * so these pin the CSS; `scripts/browser-fixtures/tests/dropdown-trigger-hit-area.playwright.ts`
 * measures it in a browser.
 */
import { describe, expect, test } from 'bun:test';

const css = await Bun.file(new URL('./dropdown.css', import.meta.url)).text();
const coarseStart = css.indexOf('@media (any-pointer: coarse) {');
const coarse = css.slice(coarseStart, css.indexOf('\n  }\n', coarseStart));
const fine = css.slice(0, coarseStart);

describe('Dropdown trigger hit area', () => {
  test('a fine pointer keeps the trigger at the md button height, with no hit-area pseudo-element', () => {
    const rule = /\.cinder-dropdown-trigger \{([^}]*)\}/su.exec(fine)?.[1] ?? '';
    expect(rule).toContain('min-block-size: var(--cinder-button-height-md);');
    expect(rule).not.toContain('position:');
    expect(fine).not.toContain('.cinder-dropdown-trigger::before');
  });

  test('a coarse pointer paints the trigger at the md painted height', () => {
    expect(coarseStart).toBeGreaterThan(-1);
    const rule = /\.cinder-dropdown-trigger \{([^}]*)\}/su.exec(coarse)?.[1] ?? '';
    expect(rule).toContain('position: relative;');
    expect(rule).toContain('min-block-size: var(--_cinder-painted-height-md);');
    expect(coarse).not.toContain('min-block-size: var(--cinder-touch-target-min)');
  });

  test('the coarse hit region is a positioned pseudo-element of at least 44px', () => {
    const rule = /\.cinder-dropdown-trigger::before \{([^}]*)\}/su.exec(coarse)?.[1] ?? '';
    expect(rule).toContain("content: '';");
    expect(rule).toContain('position: absolute;');
    expect(rule).toMatch(
      /inset-block:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\)/u,
    );
    expect(rule).toMatch(
      /inset-inline:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\)/u,
    );
  });
});
