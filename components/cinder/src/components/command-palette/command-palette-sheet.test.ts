/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { DEFAULT_TEST_VIEWPORT, setTestViewportWidth } from '../../test/viewport.ts';

setupHappyDom();

// happy-dom does not implement the dialog methods; the palette needs a `close` event from close().
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  value: function (this: HTMLDialogElement) {
    Object.defineProperty(this, 'open', { value: true, configurable: true, writable: true });
    this.setAttribute('open', '');
  },
  configurable: true,
  writable: true,
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  value: function (this: HTMLDialogElement) {
    Object.defineProperty(this, 'open', { value: false, configurable: true, writable: true });
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  },
  configurable: true,
  writable: true,
});

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/command-palette-fixture.svelte');
const { default: Palette } = await import('./command-palette.svelte');
const { resetEscapeStack, resetScrollLock } = await import('../../_internal/overlay.ts');
const { KEYBOARD_INSET_PROPERTY } = await import('../../_internal/keyboard-inset.ts');
const { createRawSnippet } = await import('svelte');

const cssText = await Bun.file(new URL('./command-palette.css', import.meta.url)).text();

const emptySnippet = createRawSnippet(() => ({ render: () => '<span></span>', setup: () => {} }));

beforeEach(() => {
  resetEscapeStack();
  resetScrollLock();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  setTestViewportWidth(DEFAULT_TEST_VIEWPORT.width);
  document.documentElement.style.removeProperty(KEYBOARD_INSET_PROPERTY);
});

describe('CommandPalette as a bottom sheet (rows 05d, 06c)', () => {
  test('stays the centred panel at desktop width', async () => {
    const { container } = render(Fixture, { initialOpen: true });
    await waitUntil(() => container.querySelector('.cinder-command-palette__panel') !== null);
    expect(container.querySelector('dialog')?.hasAttribute('data-cinder-sheet')).toBe(false);
    expect(container.querySelector('.cinder-command-palette__grabber')).toBeNull();
    expect(container.querySelector('.cinder-command-palette__close')).toBeNull();
  });

  test('below 640px it docks as a sheet with a grabber and a Close button in the search row', async () => {
    setTestViewportWidth(375);
    const { container } = render(Fixture, { initialOpen: true });
    await waitUntil(() => container.querySelector('.cinder-command-palette__panel') !== null);
    expect(container.querySelector('dialog')?.getAttribute('data-cinder-sheet')).toBe('docked');
    expect(
      container.querySelector('.cinder-command-palette__grabber')?.getAttribute('aria-hidden'),
    ).toBe('true');
    const search = container.querySelector('.cinder-command-palette__search');
    const close = search?.querySelector<HTMLButtonElement>('.cinder-command-palette__close');
    expect(close?.textContent?.trim()).toBe('Close');
  });

  test('Close shuts the palette', async () => {
    setTestViewportWidth(375);
    let closed = 0;
    const { container } = render(Fixture, {
      initialOpen: true,
      onClosed: () => {
        closed += 1;
      },
    });
    await waitUntil(() => container.querySelector('.cinder-command-palette__close') !== null);
    container.querySelector<HTMLButtonElement>('.cinder-command-palette__close')?.click();
    await waitUntil(() => closed === 1);
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  test('sheetBelow={false} keeps the centred panel on a phone', async () => {
    setTestViewportWidth(375);
    const { container } = render(Palette, {
      open: true,
      sheetBelow: false,
      items: emptySnippet,
    });
    await waitUntil(() => container.querySelector('.cinder-command-palette__panel') !== null);
    expect(container.querySelector('dialog')?.hasAttribute('data-cinder-sheet')).toBe(false);
  });

  test('closeLabel words the Close button', async () => {
    setTestViewportWidth(375);
    const { container } = render(Palette, {
      open: true,
      closeLabel: 'Done',
      items: emptySnippet,
    });
    await waitUntil(() => container.querySelector('.cinder-command-palette__close') !== null);
    expect(container.querySelector('.cinder-command-palette__close')?.textContent?.trim()).toBe(
      'Done',
    );
  });

  test('rejects a sheetBelow that is not a CSS length', () => {
    expect(() => render(Palette, { open: true, sheetBelow: 'wide', items: emptySnippet })).toThrow(
      /sheetBelow/,
    );
  });

  test('publishes the keyboard inset only while open as a sheet', async () => {
    setTestViewportWidth(375);
    const { unmount } = render(Fixture, { initialOpen: true });
    await waitUntil(
      () => document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY) !== '',
    );
    unmount();
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe('');
  });

  test('does not track the keyboard as a centred panel', async () => {
    const { container } = render(Fixture, { initialOpen: true });
    await waitUntil(() => container.querySelector('.cinder-command-palette__panel') !== null);
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe('');
  });
});

describe('command-palette.css sheet form', () => {
  test('docks to the bottom above the keyboard with the keyboard-shrunk height cap', () => {
    expect(cssText).toMatch(
      /\[data-cinder-sheet='docked'\]\s*\{[^}]*inset-block-end:\s*var\(--_cinder-keyboard-inset, 0px\);/s,
    );
    expect(cssText).toMatch(/max-height:\s*calc\(90dvh - var\(--_cinder-keyboard-inset, 0px\)\);/);
    expect(cssText).toMatch(/env\(safe-area-inset-bottom\)/);
  });

  test('makes the search field a 44px target, and rows too through command-item.css', async () => {
    expect(cssText).toMatch(
      /__search\s*\{[^}]*min-block-size:\s*var\(--cinder-touch-target-min\);/s,
    );
    const itemCss = await Bun.file(
      new URL('../command-item/command-item.css', import.meta.url),
    ).text();
    expect(itemCss).toMatch(
      /\.cinder-command-palette\[data-cinder-sheet='docked'\] \.cinder-command-item\s*\{[^}]*min-block-size:\s*var\(--cinder-touch-target-min\);/s,
    );
  });

  test('rises from the bottom, and cross-fades instead under reduced motion', () => {
    expect(cssText).toMatch(/\[data-cinder-closing\]\s*\{\s*translate:\s*0 100%;/);
    expect(cssText).toMatch(/translate:\s*none;/);
    expect(cssText).toContain(":root[data-reduced-motion='on']");
  });
});
