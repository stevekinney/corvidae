import { describe, expect, test } from 'bun:test';
import { parse } from 'postcss';

const drawerCss = await Bun.file(new URL('./drawer.css', import.meta.url)).text();

/**
 * The last value any rule with this exact selector gives the property, outside the media queries
 * (reduced motion and forced colors), which restate a few properties for their own case.
 */
function declared(selector: string, property: string, css = drawerCss): string | undefined {
  let value: string | undefined;
  parse(css).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    if (rule.parent?.type === 'atrule' && 'name' in rule.parent && rule.parent.name === 'media') {
      return;
    }
    rule.walkDecls(property, (declaration) => {
      value = declaration.value;
    });
  });
  return value;
}

/** The inline (second) value of a rule's two-value `padding` shorthand. */
function inlinePadding(selector: string, css = drawerCss): string | undefined {
  return declared(selector, 'padding', css)?.split(/\s+(?![^(]*\))/)[1];
}

// s4#8: the title sat 4px left of the body text, and the body's end inset was wider than its start
// (a reserved scrollbar gutter). Header, body and footer share one inline inset now, in the drawer
// and in the modal, and neither body reserves a gutter.
describe('one inline inset for header, body and footer (s4#8)', () => {
  test('the drawer header, body and footer pad their inline edges alike', () => {
    const insets = ['.cinder-drawer__header', '.cinder-drawer__body', '.cinder-drawer__footer'].map(
      (selector) => inlinePadding(selector),
    );
    expect(insets).toEqual([
      'var(--cinder-space-5)',
      'var(--cinder-space-5)',
      'var(--cinder-space-5)',
    ]);
    expect(declared('.cinder-drawer__body', 'scrollbar-gutter')).toBe('auto');
  });

  test('the modal header starts, and its body and footer pad, at the same inset', async () => {
    const modalCss = await Bun.file(new URL('../modal/modal.css', import.meta.url)).text();
    expect(declared('.cinder-modal__header', 'padding-inline-start', modalCss)).toBe(
      'var(--cinder-space-5)',
    );
    expect(inlinePadding('.cinder-modal__body', modalCss)).toBe('var(--cinder-space-5)');
    expect(inlinePadding('.cinder-modal__footer', modalCss)).toBe('var(--cinder-space-5)');
    expect(declared('.cinder-modal__body', 'scrollbar-gutter', modalCss)).toBe('auto');
  });
});

describe('drawer.css footer bar (COR-2322 AC2)', () => {
  const bottomFooter =
    ".cinder-drawer__panel[data-cinder-placement='bottom'] .cinder-drawer__footer";

  test('a bottom sheet footer is a bar on the sheet surface with no hard rule above it', () => {
    expect(declared('.cinder-drawer__footer', 'background')).toBe('var(--cinder-surface)');
    expect(declared(bottomFooter, 'border-block-start')).toBe('none');
    expect(declared(bottomFooter, 'position')).toBe('relative');
    // It restates no background, so the non-modal rule's transparent surface still wins.
    expect(declared(bottomFooter, 'background')).toBeUndefined();
  });

  test('a side drawer keeps its footer rule and its padding', () => {
    expect(declared('.cinder-drawer__footer', 'border-block-start')).toBe(
      '1px solid var(--cinder-border-muted)',
    );
    expect(declared('.cinder-drawer__footer', 'padding-block-end')).toBeUndefined();
    expect(declared('.cinder-drawer__footer::before', 'content')).toBeUndefined();
  });

  test('keeps clear of the bottom safe area', () => {
    expect(declared(bottomFooter, 'padding-block-end')).toBe(
      'max(var(--cinder-space-3), env(safe-area-inset-bottom))',
    );
  });

  test('draws a 24px fade above the bar that never takes a click', () => {
    const fade = `${bottomFooter}::before`;
    expect(declared(fade, 'position')).toBe('absolute');
    expect(declared(fade, 'inset-block-end')).toBe('100%');
    expect(declared(fade, 'block-size')).toBe('var(--cinder-space-6)');
    expect(declared(fade, 'pointer-events')).toBe('none');
    const background = declared(fade, 'background') ?? '';
    expect(background).toContain('linear-gradient');
    expect(background).toContain('var(--_cinder-drawer-footer-fade-color, var(--cinder-surface))');
  });

  test('a non-modal drawer fades into its inset surface', () => {
    expect(
      declared(
        ".cinder-drawer[data-cinder-modal='false'] .cinder-drawer__footer",
        '--_cinder-drawer-footer-fade-color',
      ),
    ).toBe('var(--cinder-surface-inset)');
  });
});

describe('drawer.css content never shrinks (COR-2322 AC3)', () => {
  test('children of the scrolling body keep their height', () => {
    expect(declared('.cinder-drawer__body > *', 'flex-shrink')).toBe('0');
  });
});

describe('drawer.css detents (COR-2322 AC1)', () => {
  test('each detent sets the sheet height, all under the keyboard-aware 90dvh cap', () => {
    expect(declared(".cinder-drawer__panel[data-cinder-detent='peek']", 'height')).toBe(
      'var(--_cinder-drawer-peek-height)',
    );
    expect(declared(".cinder-drawer__panel[data-cinder-detent='medium']", 'height')).toBe('50dvh');
    expect(declared(".cinder-drawer__panel[data-cinder-detent='large']", 'height')).toBe(
      'calc(90dvh - var(--_cinder-keyboard-inset, 0px))',
    );
    expect(drawerCss).toMatch(
      /\.cinder-drawer__panel\[data-cinder-placement='bottom'\]\s*\{[^}]*max-height:\s*calc\(90dvh - var\(--_cinder-keyboard-inset, 0px\)\);/s,
    );
  });

  test('the peek height is the 12px grabber band, the 56px bar and the bottom safe area', () => {
    const value = declared(
      ".cinder-drawer__panel[data-cinder-detent='peek']",
      '--_cinder-drawer-peek-height',
    );
    expect(value).toContain('var(--cinder-space-3)');
    expect(value).toContain('3.5rem');
    expect(value).toContain('env(safe-area-inset-bottom)');
  });

  test('the height transitions between detents and stops transitioning while dragging', () => {
    expect(
      declared(
        '.cinder-drawer__panel[data-cinder-detent]:not([data-cinder-closing])',
        'transition',
      ),
    ).toContain('height var(--cinder-duration-normal) var(--cinder-ease-standard)');
    // The dragging rule must outrank the detent transition rule (0,3,0), so it names the detent too.
    expect(
      declared('.cinder-drawer__panel[data-cinder-detent][data-cinder-dragging]', 'transition'),
    ).toBe('none');
  });

  test('a peeking sheet hides its header, body and footer and keeps the bar', () => {
    let hidden = false;
    parse(drawerCss).walkRules((rule) => {
      if (!rule.selector.includes('[data-cinder-peek]')) return;
      rule.walkDecls('display', (declaration) => {
        if (declaration.value === 'none') hidden = true;
      });
    });
    expect(hidden).toBe(true);
    expect(declared('.cinder-drawer__peek', 'flex')).toBe('1');
  });

  test('a non-modal peek bar is transparent over the inset panel', () => {
    expect(
      declared(".cinder-drawer[data-cinder-modal='false'] .cinder-drawer__peek", 'background'),
    ).toBe('transparent');
  });

  test('the grabber is a grab target that does not pan the page', () => {
    expect(declared('.cinder-drawer__drag-handle[data-cinder-resizable]', 'cursor')).toBe('grab');
    expect(declared('.cinder-drawer__drag-handle[data-cinder-resizable]', 'touch-action')).toBe(
      'none',
    );
  });

  test('the resize grabber and the peek bar paint their focus ring inside their band', () => {
    for (const selector of [
      '.cinder-drawer__drag-handle[data-cinder-resizable]:focus-visible',
      'button.cinder-drawer__peek:focus-visible',
    ]) {
      expect(declared(selector, 'outline'), selector).toBe(
        'var(--cinder-ring-width) solid transparent',
      );
      expect(declared(selector, 'box-shadow'), selector).toBe(
        'inset 0 0 0 var(--cinder-ring-width) var(--cinder-ring-color)',
      );
    }
  });
});

describe('drawer.css header bar (COR-2322 AC7)', () => {
  test('is three columns: close, title, action', () => {
    const bar = '.cinder-drawer__header[data-cinder-bar]';
    expect(declared(bar, 'display')).toBe('grid');
    expect(declared(bar, 'grid-template-columns')).toBe('1fr auto 1fr');
    expect(declared(`${bar} .cinder-drawer__close`, 'grid-area')).toBe('lead');
    expect(declared(`${bar} .cinder-drawer__title`, 'grid-area')).toBe('title');
    expect(declared('.cinder-drawer__action', 'grid-area')).toBe('end');
  });

  test('the title is a 14px semibold label, not a page heading', () => {
    const title = '.cinder-drawer__header[data-cinder-bar] .cinder-drawer__title';
    // 14px is the base step; `--cinder-text-sm` is 13px.
    expect(declared(title, 'font-size')).toBe('var(--cinder-text-base)');
    expect(declared(title, 'font-weight')).toBe('var(--cinder-font-semibold)');
    expect(declared(title, 'text-align')).toBe('center');
  });
});
