/// <reference lib="dom" />
import { afterEach, describe, expect, jest, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { resetEscapeStack } from '../../_internal/overlay.ts';
import type { ToastApi } from '../../_internal/toast-context.ts';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: Wrapper } = await import('../../test/fixtures/toast-fixture.svelte');
const { PHONE_VIEWPORT_BREAKPOINT } = await import('../../_internal/viewport-below.svelte.ts');
const { KEYBOARD_INSET_PROPERTY } = await import('../../_internal/keyboard-inset.ts');

const cssText = await Bun.file(new URL('./toast-region.css', import.meta.url)).text();
const sourceText = await Bun.file(new URL('./toast-region.svelte', import.meta.url)).text();

async function mountRegion(): Promise<{ api: ToastApi; container: HTMLElement }> {
  let api: ToastApi | null = null;
  const { container } = render(Wrapper, {
    onReady: (ready: ToastApi) => {
      api = ready;
    },
  });
  await waitFor(() => expect(api).not.toBeNull());
  return { api: api as unknown as ToastApi, container };
}

afterEach(() => {
  cleanup();
  if (jest.isFakeTimers()) jest.useRealTimers();
  resetEscapeStack();
  document.body.innerHTML = '';
});

describe('Undo toasts (rows 04w, 06x, 48s, 66g, 78v)', () => {
  test('an undo toast reads Undo, calls back once, and goes away', async () => {
    const { api, container } = await mountRegion();
    let undone = 0;
    api.show('Memory forgotten.', {
      undo: () => {
        undone += 1;
      },
    });
    await waitFor(() => expect(container.querySelector('.cinder-toast__action')).not.toBeNull());
    const action = container.querySelector<HTMLButtonElement>('.cinder-toast__action');
    expect(action?.textContent?.trim()).toBe('Undo');
    await fireEvent.click(action as HTMLButtonElement);
    expect(undone).toBe(1);
    await waitFor(() =>
      expect(container.querySelector('.cinder-toast')?.outerHTML ?? null).toBeNull(),
    );
  });

  test('an undo toast has no close button and no timer, so Undo is not lost to a stray click', async () => {
    jest.useFakeTimers();
    const { api, container } = await mountRegion();
    api.show('Deleted "Post the summary"', { undo: () => {} });
    await tick();
    const toast = container.querySelector('.cinder-toast');
    expect(toast?.hasAttribute('data-cinder-undo')).toBe(true);
    expect(toast?.querySelector('.cinder-toast__dismiss')).toBeNull();
    jest.advanceTimersByTime(60_000);
    await tick();
    expect(container.querySelector('.cinder-toast')).not.toBeNull();
  });

  test('another toast still dismisses itself', async () => {
    jest.useFakeTimers();
    const { api, container } = await mountRegion();
    api.show('Saved.', { variant: 'success' });
    await tick();
    expect(container.querySelector('.cinder-toast')).not.toBeNull();
    jest.advanceTimersByTime(5000);
    await tick();
    jest.advanceTimersByTime(500);
    await tick();
    expect(container.querySelector('.cinder-toast')).toBeNull();
  });

  test('dismissUndo removes every undo toast and leaves the others', async () => {
    jest.useFakeTimers();
    const { api, container } = await mountRegion();
    api.show('Memory forgotten.', { undo: () => {} });
    api.show('Reverted 1 change.', { undo: () => {} });
    api.show('Sticky note', { duration: 0 });
    await tick();
    expect(container.querySelectorAll('.cinder-toast')).toHaveLength(3);
    api.dismissUndo();
    await tick();
    jest.advanceTimersByTime(500);
    await tick();
    const left = [...container.querySelectorAll('.cinder-toast')].map((toast) => toast.textContent);
    expect(left).toHaveLength(1);
    expect(left[0]).toContain('Sticky note');
  });

  test('an explicit action wins over undo', async () => {
    const { api, container } = await mountRegion();
    api.show('Moved.', {
      duration: 0,
      action: { label: 'Show', onAction: () => {} },
      undo: () => {},
    });
    await waitFor(() => expect(container.querySelector('.cinder-toast__action')).not.toBeNull());
    expect(container.querySelector('.cinder-toast__action')?.textContent?.trim()).toBe('Show');
    expect(container.querySelector('.cinder-toast')?.hasAttribute('data-cinder-undo')).toBe(false);
  });
});

describe('Failure toasts (row 46e)', () => {
  test('a danger toast stays until dismissed, with the warning triangle and a dismiss button', async () => {
    jest.useFakeTimers();
    const { api, container } = await mountRegion();
    let retried = 0;
    api.show("Couldn't export memories", {
      variant: 'danger',
      action: {
        label: 'Try again',
        onAction: () => {
          retried += 1;
        },
      },
    });
    await tick();
    jest.advanceTimersByTime(60_000);
    await tick();
    const toast = container.querySelector('[role="alert"] .cinder-toast');
    expect(toast).not.toBeNull();
    expect(toast?.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
    expect(toast?.querySelector('.cinder-toast__action')?.textContent?.trim()).toBe('Try again');
    const dismiss = toast?.querySelector<HTMLButtonElement>('.cinder-toast__dismiss');
    expect(dismiss?.getAttribute('aria-label')).toBe("Dismiss: Couldn't export memories");
    await fireEvent.click(toast?.querySelector('.cinder-toast__action') as HTMLButtonElement);
    expect(retried).toBe(1);
  });

  test('an explicit duration still times a danger toast out', async () => {
    jest.useFakeTimers();
    const { api, container } = await mountRegion();
    api.show('Heads up', { variant: 'danger', duration: 1000 });
    await tick();
    jest.advanceTimersByTime(1000);
    await tick();
    jest.advanceTimersByTime(500);
    await tick();
    expect(container.querySelector('.cinder-toast')).toBeNull();
  });
});

describe('Region placement (rows 04w, 06x, 15g)', () => {
  test('publishes the keyboard inset while mounted', async () => {
    const { container } = await mountRegion();
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe('0px'),
    );
    expect(container.querySelector('.cinder-toast-region')).not.toBeNull();
    cleanup();
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe('');
  });

  test('sits above the docked bar and inside the bottom safe area', () => {
    expect(cssText).toMatch(
      /\[data-cinder-position\^='bottom'\]\s*\{\s*bottom:\s*calc\(\s*var\(--_cinder-keyboard-inset, 0px\) \+\s*var\(--_cinder-docked-action-bar-height, env\(safe-area-inset-bottom, 0px\)\) \+\s*var\(--cinder-space-4\)\s*\);/,
    );
  });

  test('spans the screen between two gutters on a phone, with a 44px action', () => {
    expect(cssText).toMatch(
      /\.cinder-toast-region\[data-cinder-phone\]\[data-cinder-position\]\s*\{[^}]*inset-inline:/,
    );
    expect(cssText).toMatch(
      /\.cinder-toast-region\[data-cinder-phone\] \.cinder-toast__action\s*\{[^}]*min-block-size: var\(--cinder-touch-target-min\)/,
    );
    expect(cssText).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*\.cinder-toast__action\s*\{[^}]*min-block-size: var\(--cinder-touch-target-min\)/,
    );
  });

  test('reads the same phone width as every other responsive Cinder surface', () => {
    expect(sourceText).toContain(`(width < ${PHONE_VIEWPORT_BREAKPOINT})`);
  });

  test('draws an inverse chip, and a danger toast mixes in the danger hue', () => {
    expect(cssText).toMatch(/--_cinder-toast-surface: var\(--cinder-surface-inverse\);/);
    expect(cssText).toMatch(/color: var\(--cinder-text-inverse\);/);
    expect(cssText).toMatch(
      /\[data-cinder-variant='danger'\]\s*\{\s*--_cinder-toast-surface: color-mix\(/,
    );
  });
});
