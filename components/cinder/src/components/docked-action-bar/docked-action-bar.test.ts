/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: DockedActionBar } = await import('./docked-action-bar.svelte');
const { default: Harness } = await import('./docked-action-bar-harness.test.svelte');
const { DOCKED_BAR_HEIGHT_PROPERTY } = await import('../../_internal/docked-bar-height.ts');
const { KEYBOARD_INSET_PROPERTY } = await import('../../_internal/keyboard-inset.ts');
const { createRawSnippet, flushSync } = await import('svelte');

const cssText = await Bun.file(new URL('./docked-action-bar.css', import.meta.url)).text();

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

function rootProperty(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('DockedActionBar', () => {
  test('renders a named group with its content and actions', () => {
    const { container } = render(DockedActionBar, {
      label: 'Run actions',
      children: textSnippet('content'),
      actions: textSnippet('buttons'),
    });
    const bar = container.querySelector('.cinder-docked-action-bar');
    expect(bar?.getAttribute('role')).toBe('group');
    expect(bar?.getAttribute('aria-label')).toBe('Run actions');
    expect(bar?.querySelector('.cinder-docked-action-bar__content')?.textContent).toBe('content');
    expect(bar?.querySelector('.cinder-docked-action-bar__actions')?.textContent).toBe('buttons');
  });

  test('defaults its name to Actions and omits the content wrapper without content', () => {
    const { container } = render(DockedActionBar, { actions: textSnippet('buttons') });
    expect(container.querySelector('.cinder-docked-action-bar')?.getAttribute('aria-label')).toBe(
      'Actions',
    );
    expect(container.querySelector('.cinder-docked-action-bar__content')).toBeNull();
  });

  test('merges a custom class', () => {
    const { container } = render(DockedActionBar, {
      class: 'my-custom-class',
      actions: textSnippet('buttons'),
    });
    const classes = container.querySelector('.cinder-docked-action-bar')?.getAttribute('class');
    expect(classes).toContain('cinder-docked-action-bar');
    expect(classes).toContain('my-custom-class');
  });

  test('draws a strip by default and a card on request', () => {
    const strip = render(DockedActionBar, { actions: textSnippet('buttons') });
    expect(
      strip.container
        .querySelector('.cinder-docked-action-bar')
        ?.getAttribute('data-cinder-variant'),
    ).toBe('strip');
    cleanup();
    const card = render(DockedActionBar, { variant: 'card', actions: textSnippet('buttons') });
    expect(
      card.container
        .querySelector('.cinder-docked-action-bar')
        ?.getAttribute('data-cinder-variant'),
    ).toBe('card');
    cleanup();
    const unknown = render(DockedActionBar, {
      variant: 'bogus' as never,
      actions: textSnippet('buttons'),
    });
    expect(
      unknown.container
        .querySelector('.cinder-docked-action-bar')
        ?.getAttribute('data-cinder-variant'),
    ).toBe('strip');
  });

  test('marks equal actions', () => {
    const { container } = render(DockedActionBar, {
      equalActions: true,
      actions: textSnippet('buttons'),
    });
    expect(
      container
        .querySelector('.cinder-docked-action-bar')
        ?.hasAttribute('data-cinder-equal-actions'),
    ).toBe(true);
  });
});

describe('DockedActionBar off state (row 56e)', () => {
  test('draws the reason under the row and describes every mutating control with it', () => {
    const { container } = render(Harness, { off: true, reason: 'Reconnecting… both are off.' });
    const reason = container.querySelector('.cinder-docked-action-bar__reason');
    expect(reason?.textContent).toBe('Reconnecting… both are off.');
    expect(reason?.closest('[role="status"]')).not.toBeNull();
    const send = container.querySelector<HTMLButtonElement>('[data-testid="send"]');
    expect(send?.getAttribute('aria-disabled')).toBe('true');
    expect(send?.getAttribute('aria-describedby')?.split(' ')).toContain(reason?.id);
    expect(
      container.querySelector('.cinder-docked-action-bar')?.hasAttribute('data-cinder-off'),
    ).toBe(true);
  });

  test('keeps an off control focusable and ignores its press', () => {
    const { container } = render(Harness, { off: true, reason: 'Off for now.' });
    const send = container.querySelector<HTMLButtonElement>('[data-testid="send"]');
    expect(send?.disabled).toBe(false);
    send?.click();
    flushSync();
    expect(container.querySelector('[data-testid="pressed"]')?.textContent).toBe('0');
  });

  test('leaves the controls live and the status empty when not off', () => {
    const { container } = render(Harness, { off: false, reason: 'Never shown.' });
    const send = container.querySelector<HTMLButtonElement>('[data-testid="send"]');
    expect(send?.getAttribute('aria-disabled')).toBeNull();
    send?.click();
    flushSync();
    expect(container.querySelector('[data-testid="pressed"]')?.textContent).toBe('1');
    expect(container.querySelector('.cinder-docked-action-bar__reason')).toBeNull();
    expect(container.querySelector('.cinder-docked-action-bar__status')?.textContent).toBe('');
  });

  test('falls back to the default reason when off without one', () => {
    const { container } = render(Harness, { off: true });
    const send = container.querySelector<HTMLButtonElement>('[data-testid="send"]');
    expect(send?.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('.cinder-docked-action-bar__reason')).toBeNull();
  });
});

describe('DockedActionBar and the page (rows 04u, 04w)', () => {
  test('publishes its height while mounted and removes it on unmount', async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => ({ height: 71.2 }) as DOMRect;
    try {
      const { unmount } = render(DockedActionBar, { actions: textSnippet('buttons') });
      await waitUntil(() => rootProperty(DOCKED_BAR_HEIGHT_PROPERTY) !== '');
      expect(rootProperty(DOCKED_BAR_HEIGHT_PROPERTY)).toBe('72px');
      unmount();
      expect(rootProperty(DOCKED_BAR_HEIGHT_PROPERTY)).toBe('');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  test('publishes the keyboard inset while mounted', async () => {
    const { unmount } = render(DockedActionBar, { actions: textSnippet('buttons') });
    await waitUntil(() => rootProperty(KEYBOARD_INSET_PROPERTY) !== '');
    expect(rootProperty(KEYBOARD_INSET_PROPERTY)).toBe('0px');
    unmount();
    expect(rootProperty(KEYBOARD_INSET_PROPERTY)).toBe('');
  });
});

describe('docked-action-bar.css', () => {
  test('sticks to the bottom above the keyboard and clears the safe area (row 04u)', () => {
    expect(cssText).toMatch(/position:\s*sticky;/);
    expect(cssText).toMatch(/inset-block-end:\s*var\(--_cinder-keyboard-inset, 0px\);/);
    expect(cssText).toMatch(/env\(safe-area-inset-bottom\)/);
  });

  test('makes every button and field 44px on touch without a cross-component custom property', () => {
    const touch = cssText.slice(cssText.indexOf('@media (pointer: coarse)'));
    expect(touch).toMatch(/\.cinder-button\[data-cinder-size\]/);
    expect(touch).toMatch(/\.cinder-input\.cinder-input/);
    expect(touch).toContain('min-height: var(--cinder-touch-target-min);');
    expect(cssText).not.toMatch(/--cinder-(?:button|control)-height/);
    // A narrow bar is 44px whatever the pointer, so a 375px bar under a mouse is too (row 26p).
    const narrow = cssText.slice(cssText.indexOf('@container (inline-size < 32rem)'));
    expect(narrow).toMatch(
      /\.cinder-button\[data-cinder-size\][^}]*min-height: var\(--cinder-touch-target-min\)/s,
    );
  });

  test('docks to the bottom of a short page: the bar pushes itself down, with no fixed space above it (row 04u)', () => {
    const rule = cssText.slice(cssText.indexOf('.cinder-docked-action-bar {'));
    const block = rule.slice(0, rule.indexOf('}'));
    expect(block).toContain('margin-block-start: auto;');
  });

  test('is a flush strip with only a top border by default, and a raised card in the card variant (row 26p)', () => {
    const rule = cssText.slice(cssText.indexOf('.cinder-docked-action-bar {'));
    const block = rule.slice(0, rule.indexOf('}'));
    expect(block).toContain('border: 0;');
    expect(block).toContain('border-block-start: 1px solid var(--cinder-border);');
    expect(block).toContain('border-radius: 0;');
    expect(block).not.toContain('box-shadow');
    const cardStart = cssText.indexOf(".cinder-docked-action-bar[data-cinder-variant='card'] {");
    const card = cssText.slice(cardStart, cssText.indexOf('}', cardStart));
    expect(card).toContain('border: 1px solid var(--cinder-border);');
    expect(card).toContain('border-radius: var(--cinder-radius-lg);');
    expect(card).toContain('box-shadow:');
  });

  test('mutes the field of an off bar with the inset fill and muted text (row 56e)', () => {
    const start = cssText.indexOf('.cinder-docked-action-bar[data-cinder-off] .cinder-input');
    expect(start).toBeGreaterThan(-1);
    const block = cssText.slice(start, cssText.indexOf('}', start));
    expect(block).toContain('background: var(--cinder-surface-inset);');
    expect(block).toContain('color: var(--cinder-text-muted);');
  });

  test('a narrow bar wraps its actions instead of overflowing, except an equal pair (row 56e)', () => {
    const narrow = cssText.slice(cssText.indexOf('@container (inline-size < 32rem)'));
    const actions = narrow.slice(narrow.indexOf('.cinder-docked-action-bar__actions {'));
    expect(actions.slice(0, actions.indexOf('}'))).toContain('flex-wrap: wrap;');
    expect(narrow).toMatch(
      /data-cinder-equal-actions\] \.cinder-docked-action-bar__actions \{\s*flex-wrap: nowrap;/,
    );
  });

  test('is a container, and puts a narrow bar actions on their own shared row', () => {
    expect(cssText).toMatch(/container-type:\s*inline-size;/);
    expect(cssText).toMatch(/@container \(inline-size < 32rem\)/);
  });
});
