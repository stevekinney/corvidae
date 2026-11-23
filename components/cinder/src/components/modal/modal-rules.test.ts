/// <reference lib="dom" />
import {
  flushOverflowFadeAnimationFrames,
  installOverflowFadeTestEnvironment,
  OverflowFadeResizeObserver,
  setScrollMeasurements,
} from '@lostgradient/component-tooling/test/overflow-fade-test-helpers.ts';
import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { parse } from 'postcss';
import { resetScrollLock } from '../../_internal/overlay.ts';
import { installModalDialogStubs, textSnippet } from './modal-test-helpers.ts';

setupHappyDom();
installModalDialogStubs();
const { cleanup, render } = await import('@testing-library/svelte');
const { default: Modal } = await import('./modal.svelte');

const css = await Bun.file(new URL('./modal.css', import.meta.url)).text();

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
  resetScrollLock();
});

describe('Modal body that renders nothing (COR-2547)', () => {
  test('an empty body takes no room, so no padded band sits between the title and the footer', () => {
    expect(declared('.cinder-modal__body:empty', 'display')).toBe('none');
  });
});

describe('Modal close control touch target (COR-2403)', () => {
  test('keeps its 36px painted face and reaches 44px out of flow only on a coarse pointer', () => {
    expect(declared('.cinder-modal__close', 'width')).toBe('2.25rem');
    expect(declared('.cinder-modal__close', 'height')).toBe('2.25rem');
    expect(declared('.cinder-modal__close', 'inset-block-start')).toBe('var(--cinder-space-2)');
    expect(declared('.cinder-modal__close', 'inset-inline-end')).toBe('var(--cinder-space-2)');
    expect(declared('.cinder-modal__panel', 'overflow')).toBe('hidden');

    const coarse = css.slice(css.indexOf('@media (any-pointer: coarse)'));
    const hitArea = /\.cinder-modal__close::before\s*\{([^}]*)\}/.exec(coarse)?.[1] ?? '';
    expect(hitArea).toMatch(/content:\s*'';/);
    expect(hitArea).toMatch(/position:\s*absolute;/);
    expect(hitArea).toContain('var(--cinder-touch-target-min)');
    expect(hitArea).toContain(
      'inset-inline: min(0px, calc((100% - var(--cinder-touch-target-min)) / 2));',
    );
    expect(hitArea).toContain(
      'inset-block: min(0px, calc((100% - var(--cinder-touch-target-min)) / 2));',
    );
  });

  test('renders the accessible close button in the default modal chrome', () => {
    const { container } = render(Modal, {
      props: { open: true, title: 'Restart', children: textSnippet('Restart the worker.') },
    });
    const close = requiredInstance(
      container.querySelector('.cinder-modal__close'),
      HTMLButtonElement,
    );
    expect(close.getAttribute('aria-label')).toBe('Close');
  });
});

// A short confirmation has nothing to separate from: the header and footer rules appear only
// while the body scrolls (COR-2448 AC4).
describe('Modal header and footer rules (COR-2448 AC4)', () => {
  const scrollingPanel = '.cinder-modal__panel:has(> .cinder-modal__body[data-cinder-scrollable])';

  test('the header and footer rules are transparent unless the body scrolls', () => {
    expect(declared('.cinder-modal__header', 'border-block-end-color')).toBe('transparent');
    expect(declared('.cinder-modal__footer', 'border-block-start-color')).toBe('transparent');
    expect(declared(`${scrollingPanel} .cinder-modal__header`, 'border-block-end-color')).toBe(
      'var(--cinder-border-muted)',
    );
    expect(declared(`${scrollingPanel} .cinder-modal__footer`, 'border-block-start-color')).toBe(
      'var(--cinder-border-muted)',
    );
  });

  // COR-2448 review B: without the rule the title must not float away from its body. The header's
  // 12px under the title and the body's 12px above it are one 24px gap, and the title has the
  // same 12px above it, so it is centred over the rule when the rule is drawn. No padding follows
  // `data-cinder-scrollable` (that attribute is measured from the body's overflow, so padding that
  // followed it could flip whether the body scrolls).
  test('the title sits 12px above the body padding and 12px below the top, unconditionally', () => {
    expect(declared('.cinder-modal__header', 'padding-block')).toBe('var(--cinder-space-3)');
    expect(declared('.cinder-modal__body', 'padding')).toBe(
      'var(--cinder-space-3) var(--cinder-space-5) var(--cinder-space-4)',
    );
    parse(css).walkRules((rule) => {
      if (!rule.selector.includes('data-cinder-scrollable')) return;
      rule.walkDecls(/^padding/, (declaration) => {
        throw new Error(`${rule.selector} declares ${declaration.prop}`);
      });
    });
  });

  test('a two-sentence body is not marked scrollable, a body taller than its box is', () => {
    const cleanupOverflowFade = installOverflowFadeTestEnvironment();
    try {
      const { container } = render(Modal, {
        props: {
          open: true,
          title: 'Restart',
          children: textSnippet('Restart the worker. Running jobs finish first.'),
        },
      });
      const body = requiredInstance(container.querySelector('.cinder-modal__body'), HTMLElement);

      setScrollMeasurements(body, { clientHeight: 100, scrollHeight: 100, scrollTop: 0 });
      OverflowFadeResizeObserver.instances[0]?.trigger();
      flushOverflowFadeAnimationFrames();
      expect(body.hasAttribute('data-cinder-scrollable')).toBe(false);

      setScrollMeasurements(body, { clientHeight: 100, scrollHeight: 400, scrollTop: 0 });
      OverflowFadeResizeObserver.instances[0]?.trigger();
      flushOverflowFadeAnimationFrames();
      expect(body.hasAttribute('data-cinder-scrollable')).toBe(true);

      // Scrolled to the end it still scrolls, so the rules stay.
      setScrollMeasurements(body, { clientHeight: 100, scrollHeight: 400, scrollTop: 300 });
      body.dispatchEvent(new Event('scroll'));
      flushOverflowFadeAnimationFrames();
      expect(body.hasAttribute('data-cinder-scrollable')).toBe(true);
    } finally {
      cleanupOverflowFade();
    }
  });
});
