/// <reference lib="dom" />
import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { parse } from 'postcss';
import {
  flushOverflowFadeAnimationFrames,
  installOverflowFadeTestEnvironment,
  OverflowFadeResizeObserver,
  setScrollMeasurements,
} from '../../test/overflow-fade-test-helpers.ts';
import { installDrawerDialogStubs, textSnippet } from './drawer-test-helpers.ts';

setupHappyDom();
installDrawerDialogStubs();
const { cleanup, render } = await import('@testing-library/svelte');
const { default: Drawer } = await import('./drawer.svelte');

const css = await Bun.file(new URL('./drawer.css', import.meta.url)).text();

/** The value of `property` in the rule whose selector list holds exactly `selector`. */
function declared(selector: string, property: string): string | undefined {
  let value: string | undefined;
  parse(css).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls(property, (declaration) => {
      value = declaration.value;
    });
  });
  return value;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// COR-2448 AC4: a short confirmation has no header or footer rule; scrolling content keeps both.
describe('Drawer header and footer rules (COR-2448 AC4)', () => {
  const scrollingPanel =
    '.cinder-drawer__panel:has(> .cinder-drawer__body[data-cinder-scrollable])';

  test('the header and footer rules are transparent unless the body scrolls', () => {
    expect(declared('.cinder-drawer__header', 'border-block-end-color')).toBe('transparent');
    expect(declared('.cinder-drawer__footer', 'border-block-start-color')).toBe('transparent');
    expect(declared(`${scrollingPanel} .cinder-drawer__header`, 'border-block-end-color')).toBe(
      'var(--cinder-border-muted)',
    );
    expect(declared(`${scrollingPanel} .cinder-drawer__footer`, 'border-block-start-color')).toBe(
      'var(--cinder-border-muted)',
    );
  });

  test('a two-sentence body is not marked scrollable, a body taller than its box is', () => {
    const cleanupOverflowFade = installOverflowFadeTestEnvironment();
    try {
      const { container } = render(Drawer, {
        props: {
          open: true,
          title: 'Restart',
          children: textSnippet('Restart the worker. Running jobs finish first.'),
        },
      });
      const body = requiredInstance(container.querySelector('.cinder-drawer__body'), HTMLElement);

      setScrollMeasurements(body, { clientHeight: 100, scrollHeight: 100, scrollTop: 0 });
      OverflowFadeResizeObserver.instances[0]?.trigger();
      flushOverflowFadeAnimationFrames();
      expect(body.hasAttribute('data-cinder-scrollable')).toBe(false);
      expect(body.hasAttribute('data-cinder-overflows')).toBe(false);
      // The body is a tab stop only while it scrolls (a keyboard has no other way to scroll it).
      expect(body.getAttribute('tabindex')).toBe('-1');

      // A box with no size at all (0 and 0, as in happy-dom) does not scroll either.
      setScrollMeasurements(body, { clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
      OverflowFadeResizeObserver.instances[0]?.trigger();
      flushOverflowFadeAnimationFrames();
      expect(body.hasAttribute('data-cinder-scrollable')).toBe(false);
      expect(body.getAttribute('tabindex')).toBe('-1');

      setScrollMeasurements(body, { clientHeight: 100, scrollHeight: 400, scrollTop: 300 });
      OverflowFadeResizeObserver.instances[0]?.trigger();
      flushOverflowFadeAnimationFrames();
      expect(body.hasAttribute('data-cinder-scrollable')).toBe(true);
      expect(body.getAttribute('tabindex')).toBe('0');
    } finally {
      cleanupOverflowFade();
    }
  });
});
