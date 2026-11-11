/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { resetScrollLock } from '../../_internal/overlay.ts';
import { DEFAULT_TEST_VIEWPORT, setTestViewportWidth } from '../../test/viewport.ts';
import { emptySnippet, installModalDialogStubs } from './modal-test-helpers.ts';

setupHappyDom();
installModalDialogStubs();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Modal } = await import('./modal.svelte');
const { default: ConfirmDialog } = await import('../confirm-dialog/confirm-dialog.svelte');
const { KEYBOARD_INSET_PROPERTY } = await import('../../_internal/keyboard-inset.ts');

const modalCss = await Bun.file(new URL('./modal.css', import.meta.url)).text();
const confirmCss = await Bun.file(
  new URL('../confirm-dialog/confirm-dialog.css', import.meta.url),
).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
  setTestViewportWidth(DEFAULT_TEST_VIEWPORT.width);
  document.documentElement.style.removeProperty(KEYBOARD_INSET_PROPERTY);
});

describe('Modal sheetBelow (row 05d)', () => {
  test('is a centred card by default, even on a phone', async () => {
    setTestViewportWidth(375);
    const { container } = render(Modal, { open: true, title: 'Title', children: emptySnippet });
    await waitUntil(() => container.querySelector('.cinder-modal__panel') !== null);
    expect(container.querySelector('dialog')?.hasAttribute('data-cinder-sheet')).toBe(false);
    expect(container.querySelector('.cinder-modal__grabber')).toBeNull();
  });

  test('docks with a grabber below the breakpoint', async () => {
    setTestViewportWidth(375);
    const { container } = render(Modal, {
      open: true,
      title: 'Title',
      sheetBelow: '640px',
      children: emptySnippet,
    });
    await waitUntil(() => container.querySelector('.cinder-modal__panel') !== null);
    expect(container.querySelector('dialog')?.getAttribute('data-cinder-sheet')).toBe('docked');
    expect(container.querySelector('.cinder-modal__grabber')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  test('stays a card at and above the breakpoint', async () => {
    const { container } = render(Modal, {
      open: true,
      title: 'Title',
      sheetBelow: '640px',
      children: emptySnippet,
    });
    await waitUntil(() => container.querySelector('.cinder-modal__panel') !== null);
    expect(container.querySelector('dialog')?.hasAttribute('data-cinder-sheet')).toBe(false);
  });

  test('a chromeless modal never docks', async () => {
    setTestViewportWidth(375);
    const { container } = render(Modal, {
      open: true,
      chrome: 'none',
      'aria-label': 'Photo',
      sheetBelow: '640px',
      children: emptySnippet,
    });
    await waitUntil(() => container.querySelector('.cinder-modal__panel') !== null);
    expect(container.querySelector('dialog')?.hasAttribute('data-cinder-sheet')).toBe(false);
  });

  test('rejects a sheetBelow that is not a CSS length', () => {
    expect(() =>
      render(Modal, { open: true, title: 'Title', sheetBelow: 'wide', children: emptySnippet }),
    ).toThrow(/sheetBelow/);
  });

  test('publishes the keyboard inset only while open as a sheet', async () => {
    setTestViewportWidth(375);
    const { unmount } = render(Modal, {
      open: true,
      title: 'Title',
      sheetBelow: '640px',
      children: emptySnippet,
    });
    await waitUntil(
      () => document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY) !== '',
    );
    unmount();
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe('');
  });
});

describe('ConfirmDialog as a sheet (row 05d)', () => {
  test('is a sheet on a phone by default, Cancel first in the DOM and focus order', async () => {
    setTestViewportWidth(375);
    const { container } = render(ConfirmDialog, {
      open: true,
      title: 'Delete Order checker?',
      confirmLabel: 'Delete agent',
      destructive: true,
      typeToConfirm: 'order-checker',
      onConfirm: () => {},
    });
    await waitUntil(() => container.querySelector('.cinder-modal__footer') !== null);
    expect(container.querySelector('dialog')?.getAttribute('data-cinder-sheet')).toBe('docked');
    const buttons = [...(container.querySelectorAll('.cinder-modal__footer button') ?? [])];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Cancel', 'Delete agent']);
  });

  test('sheetBelow={false} keeps the centred dialog on a phone', async () => {
    setTestViewportWidth(375);
    const { container } = render(ConfirmDialog, {
      open: true,
      title: 'Discard?',
      confirmLabel: 'Discard',
      sheetBelow: false,
      onConfirm: () => {},
    });
    await waitUntil(() => container.querySelector('.cinder-modal__footer') !== null);
    expect(container.querySelector('dialog')?.hasAttribute('data-cinder-sheet')).toBe(false);
  });

  test('is the centred dialog on a desktop', async () => {
    const { container } = render(ConfirmDialog, {
      open: true,
      title: 'Discard?',
      confirmLabel: 'Discard',
      onConfirm: () => {},
    });
    await waitUntil(() => container.querySelector('.cinder-modal__footer') !== null);
    expect(container.querySelector('dialog')?.hasAttribute('data-cinder-sheet')).toBe(false);
  });
});

describe('modal.css and confirm-dialog.css sheet form', () => {
  test('docks above the keyboard with a keyboard-shrunk cap', () => {
    expect(modalCss).toMatch(
      /\.cinder-modal\[data-cinder-sheet='docked'\]\s*\{[^}]*inset-block-end:\s*var\(--_cinder-keyboard-inset, 0px\);/s,
    );
    expect(modalCss).toMatch(/max-height:\s*calc\(90dvh - var\(--_cinder-keyboard-inset, 0px\)\);/);
  });

  test('shapes the sheet: 20px top radius, square bottom, upward shadow, 32px under the last row', () => {
    const start = modalCss.indexOf(
      ".cinder-modal[data-cinder-sheet='docked'] .cinder-modal__panel {",
    );
    const rule = modalCss.slice(start, modalCss.indexOf('}', start));
    expect(rule).toContain('border-radius: 1.25rem 1.25rem 0 0;');
    expect(rule).toMatch(/box-shadow:\s*0 -/);
    expect(rule).toContain(
      'padding-block-end: max(var(--cinder-space-8), env(safe-area-inset-bottom));',
    );
  });

  test('stacks the footer at full width and 44px with the confirmation on top', () => {
    const footer = modalCss.slice(
      modalCss.indexOf(".cinder-modal[data-cinder-sheet='docked'] .cinder-modal__footer {"),
    );
    expect(footer).toContain('flex-direction: column-reverse;');
    expect(modalCss).toMatch(
      /__footer \.cinder-button\[data-cinder-size\],\s*[^{]*__body \.cinder-input\.cinder-input\s*\{\s*min-height:\s*var\(--cinder-touch-target-min\);/,
    );
    expect(modalCss).toMatch(/__footer > \*\s*\{\s*inline-size:\s*100%;/);
    expect(modalCss).toMatch(/env\(safe-area-inset-bottom\)/);
  });

  test('cross-fades instead of sliding under reduced motion', () => {
    expect(modalCss).toContain(":root[data-reduced-motion='on']");
    expect(modalCss).toMatch(/\[data-cinder-closing\] \{\s*translate: none;/);
  });

  test('the confirm sheet drops the corner close button', () => {
    expect(confirmCss).toMatch(
      /\[data-cinder-sheet='docked'\]\.cinder-confirm-dialog \.cinder-modal__close\s*\{\s*display:\s*none;/,
    );
  });
});
