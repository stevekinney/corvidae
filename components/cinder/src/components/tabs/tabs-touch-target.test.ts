/**
 * COR-2448 review C: on a phone a tab is a 44px touch target without being painted taller. The
 * media query cannot be evaluated here, so this pins the shape of the CSS: a pseudo-element hit
 * region that takes no layout space, and the list padding that keeps it from being clipped.
 */
import { describe, expect, test } from 'bun:test';
import { parse } from 'postcss';

const css = await Bun.file(new URL('./tabs.css', import.meta.url)).text();

/** The declarations of the rule with `selector` inside the `(pointer: coarse)` media query. */
function coarse(selector: string): Record<string, string> {
  const declared: Record<string, string> = {};
  parse(css).walkAtRules('media', (media) => {
    if (media.params !== '(pointer: coarse)') return;
    media.walkRules((rule) => {
      if (rule.selector !== selector) return;
      rule.walkDecls((declaration) => {
        declared[declaration.prop] = declaration.value;
      });
    });
  });
  return declared;
}

describe('Tabs touch target on a coarse pointer', () => {
  test('a tab reaches the touch minimum through a positioned pseudo-element, not a taller box', () => {
    const hitArea = coarse(".cinder-tab:not([data-variant='vertical'])::before");
    expect(hitArea.position).toBe('absolute');
    expect(hitArea['inset-block-start']).toBe(
      'min(0px, calc(100% - var(--cinder-touch-target-min)))',
    );
    expect(hitArea['inset-block-end']).toBe('0');
    // The pseudo-element is not the active indicator's, which is `::after`.
    expect(css).toMatch(/\.cinder-tab\[data-cinder-active\]::after/);
    // No painted size is set on the tab from the token.
    expect(coarse('.cinder-tab')).toEqual({});
    expect(Object.keys(hitArea).filter((property) => /size|height/.test(property))).toEqual([]);
  });

  test('the list pads for the overhang, and cancels the padding in layout', () => {
    const list = coarse(".cinder-tab-list:not([data-cinder-orientation='vertical'])");
    expect(list['padding-block-start']).toBe('var(--cinder-space-3)');
    expect(list['margin-block-start']).toBe('calc(var(--cinder-space-3) * -1)');
  });
});
