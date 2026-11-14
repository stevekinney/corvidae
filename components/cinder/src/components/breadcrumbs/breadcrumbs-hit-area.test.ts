/**
 * COR-2327 B2: the current page's popover trigger (a chat's title switcher) paints 30px and, on a
 * coarse pointer, answers a press 44px tall through a positioned pseudo-element that takes no
 * layout space. The trail's list clips its overflow, so the list gains that room inside its clip
 * with padding a matching negative margin gives back. A fine pointer changes nothing. The coarse
 * media query cannot be evaluated here, so these pin the CSS; Interborough's
 * `tests/e2e/chat-responsive.spec.ts` measures the title switcher on a touch phone.
 */
import { describe, expect, test } from 'bun:test';

const css = await Bun.file(new URL('./breadcrumbs.css', import.meta.url)).text();
const coarseStart = css.indexOf('@media (any-pointer: coarse) {');
const coarse = css.slice(coarseStart, css.indexOf('\n  }\n', coarseStart));
const fine = css.slice(0, coarseStart) + css.slice(css.indexOf('\n  }\n', coarseStart));

describe('Breadcrumbs title switcher hit area', () => {
  test('a fine pointer keeps the trigger 30px with its own clip, and no hit-area pseudo-element', () => {
    const trigger = /\.cinder-breadcrumbs__trigger \{([^}]*)\}/su.exec(fine)?.[1] ?? '';
    expect(trigger).toContain('min-block-size: 1.875rem;');
    const current = /\.cinder-breadcrumbs__current \{([^}]*)\}/su.exec(fine)?.[1] ?? '';
    expect(current).toContain('overflow: hidden;');
    expect(fine).not.toContain('.cinder-breadcrumbs__trigger::before');
    expect(fine).not.toContain('margin-block: calc(');
  });

  test('a coarse pointer extends the trigger to 44px with a positioned pseudo-element the trigger does not clip', () => {
    expect(coarseStart).toBeGreaterThan(-1);
    const trigger = /\.cinder-breadcrumbs__trigger \{([^}]*)\}/su.exec(coarse)?.[1] ?? '';
    expect(trigger).toContain('position: relative;');
    expect(trigger).toContain('overflow: visible;');
    expect(trigger).not.toContain('min-block-size');
    const hit = /\.cinder-breadcrumbs__trigger::before \{([^}]*)\}/su.exec(coarse)?.[1] ?? '';
    expect(hit).toContain('position: absolute;');
    expect(hit).toMatch(
      /inset-block:\s*min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\)/u,
    );
  });

  test('the list makes room inside its clip for the hit area and gives it back to layout', () => {
    const list = /\.cinder-breadcrumbs__list:has\([^)]*\) \{([^}]*)\}/su.exec(coarse)?.[1] ?? '';
    expect(list).toContain('padding-block: var(--_cinder-breadcrumbs-hit-overhang);');
    expect(list).toContain('margin-block: calc(var(--_cinder-breadcrumbs-hit-overhang) * -1);');
    expect(list).toMatch(/--cinder-touch-target-min\) - 1\.875rem\) \/ 2/u);
  });
});
