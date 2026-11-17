/// <reference lib="dom" />
import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { resetEscapeStack, resetScrollLock } from '../../_internal/overlay.ts';
import { emptySnippet, installDrawerDialogStubs } from './drawer-test-helpers.ts';

setupHappyDom();
installDrawerDialogStubs();
const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: Drawer } = await import('./drawer.svelte');
const drawerCss = await Bun.file(new URL('./drawer.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
  resetEscapeStack();
});

describe('Drawer closeLabel', () => {
  test('by default the close control is the X icon named "Close drawer"', () => {
    const { container } = render(Drawer, {
      props: { open: true, title: 'Panel', children: emptySnippet },
    });
    const close = requiredInstance(
      container.querySelector('.cinder-drawer__close'),
      HTMLButtonElement,
    );
    expect(close.getAttribute('aria-label')).toBe('Close drawer');
    expect(close.querySelector('svg')).not.toBeNull();
    expect(close.hasAttribute('data-cinder-close-label')).toBe(false);
  });

  test('closeLabel turns the close control into a text button named by those words', () => {
    const { container } = render(Drawer, {
      props: { open: true, title: 'Panel', closeLabel: 'Close', children: emptySnippet },
    });
    const close = requiredInstance(
      container.querySelector('.cinder-drawer__close'),
      HTMLButtonElement,
    );
    expect(close.textContent?.trim()).toBe('Close');
    expect(close.hasAttribute('aria-label')).toBe(false);
    expect(close.hasAttribute('data-cinder-close-label')).toBe(true);
    expect(close.querySelector('svg')).toBeNull();
    expect(drawerCss).toMatch(/\.cinder-drawer__close\[data-cinder-close-label\][^}]*width: auto/);
  });

  test('a non-modal drawer takes the same label and closes through it', async () => {
    const { container } = render(Drawer, {
      props: {
        open: true,
        modal: false,
        title: 'Panel',
        closeLabel: 'Close',
        children: emptySnippet,
      },
    });
    const close = requiredInstance(
      container.querySelector('.cinder-drawer__close'),
      HTMLButtonElement,
    );
    expect(close.textContent?.trim()).toBe('Close');
    await fireEvent.click(close);
    await tick();
    expect(container.querySelector('aside')).toBeNull();
  });
});
