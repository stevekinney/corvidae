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

async function mountRegion(
  position: 'bottom-right' | 'docked-bottom-right' = 'bottom-right',
): Promise<{ api: ToastApi; container: HTMLElement }> {
  let api: ToastApi | null = null;
  const { container } = render(Wrapper, {
    position,
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

  test('reserves room at the bottom of the page while an Undo toast stays, and none for a toast that leaves on its own (COR-2429)', async () => {
    const root = document.documentElement;
    const reserve = () => root.style.getPropertyValue('--cinder-toast-reserve-padding');
    const { api, container } = await mountRegion();

    api.show('Saved.', { variant: 'success' });
    await tick();
    expect(reserve()).toBe('');

    const id = api.show('Forgot “The user prefers aisle seats.”.', { undo: () => {} });
    await waitFor(() => expect(reserve()).toMatch(/px$/));

    api.dismiss(id);
    await waitFor(() =>
      expect(container.querySelector('[data-cinder-undo]')?.outerHTML ?? null).toBeNull(),
    );
    await waitFor(() => expect(reserve()).toBe(''));
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
    const { api, container } = await mountRegion('docked-bottom-right');
    api.show('Memory forgotten.', { undo: () => {} });
    api.show('Reverted 1 change.', { undo: () => {} });
    api.show('Sticky note', { duration: 0 });
    await tick();
    expect(container.querySelectorAll('.cinder-toast')).toHaveLength(1);
    expect(container.querySelector('.cinder-toast-undo-actions__toggle')?.textContent).toContain(
      '2 Undo actions available',
    );
    api.dismissUndo();
    await tick();
    jest.advanceTimersByTime(500);
    await tick();
    const left = [...container.querySelectorAll('.cinder-toast')].map((toast) => toast.textContent);
    expect(left).toHaveLength(1);
    expect(left[0]).toContain('Sticky note');
  });

  test('many Undo actions collapse to one reachable recovery control until opened', async () => {
    const { api, container } = await mountRegion('docked-bottom-right');
    const restored: string[] = [];
    for (const label of ['first', 'second', 'third']) {
      api.show(`Deleted ${label}.`, { undo: () => restored.push(label) });
    }
    const toggle = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        '.cinder-toast-undo-actions__toggle',
      );
      expect(button?.textContent).toContain('3 Undo actions available');
      return button as HTMLButtonElement;
    });
    expect(container.querySelectorAll('[data-cinder-undo]')).toHaveLength(0);
    await fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelectorAll('[data-cinder-undo]')).toHaveLength(3));
    const first = [...container.querySelectorAll<HTMLButtonElement>('.cinder-toast__action')].find(
      (button) => button.closest('.cinder-toast')?.textContent?.includes('Deleted first.'),
    );
    await fireEvent.click(first as HTMLButtonElement);
    expect(restored).toEqual(['first']);
  });

  test('a fixed-position region keeps each active Undo action visible', async () => {
    const { api, container } = await mountRegion();
    api.show('Deleted first.', { undo: () => {} });
    api.show('Deleted second.', { undo: () => {} });
    await waitFor(() => {
      expect(container.querySelectorAll('[data-cinder-undo]')).toHaveLength(2);
      expect(container.querySelector('.cinder-toast-undo-actions__toggle')).toBeNull();
    });
  });

  test('a new Undo group starts collapsed after an expanded group clears, independently per channel', async () => {
    const { api, container } = await mountRegion('docked-bottom-right');
    const polite = container.querySelector<HTMLElement>('[role="status"]') as HTMLElement;
    const assertive = container.querySelector<HTMLElement>('[role="alert"]') as HTMLElement;

    api.show('Deleted first.', { undo: () => {} });
    api.show('Deleted second.', { undo: () => {} });
    const politeToggle = await waitFor(() => {
      const toggle = polite.querySelector<HTMLButtonElement>('.cinder-toast-undo-actions__toggle');
      expect(toggle?.textContent).toContain('2 Undo actions available');
      return toggle as HTMLButtonElement;
    });
    await fireEvent.click(politeToggle);
    await waitFor(() => expect(polite.querySelectorAll('[data-cinder-undo]')).toHaveLength(2));

    api.show('Danger first.', { variant: 'danger', undo: () => {} });
    api.show('Danger second.', { variant: 'danger', undo: () => {} });
    await waitFor(() => {
      expect(assertive.querySelector('.cinder-toast-undo-actions__toggle')?.textContent).toContain(
        '2 Undo actions available',
      );
    });

    for (const action of polite.querySelectorAll<HTMLButtonElement>('.cinder-toast__action')) {
      await fireEvent.click(action);
    }
    await waitFor(() => expect(polite.querySelector('[data-cinder-undo]')).toBeNull());

    api.show('Deleted third.', { undo: () => {} });
    api.show('Deleted fourth.', { undo: () => {} });
    await waitFor(() => {
      expect(polite.querySelector('.cinder-toast-undo-actions__toggle')?.textContent).toContain(
        '2 Undo actions available',
      );
      expect(polite.querySelectorAll('[data-cinder-undo]')).toHaveLength(0);
      expect(assertive.querySelectorAll('[data-cinder-undo]')).toHaveLength(0);
    });
  });

  test('onClose is called once, after the action, however the toast closes', async () => {
    jest.useFakeTimers();
    const { api, container } = await mountRegion('docked-bottom-right');
    const closed: string[] = [];
    const order: string[] = [];
    api.show('Timed.', { duration: 1000, onClose: () => closed.push('timer') });
    api.show('Undone.', {
      undo: () => order.push('undo'),
      onClose: () => {
        order.push('close');
        closed.push('undo');
      },
    });
    const left = api.show('Left.', { undo: () => {}, onClose: () => closed.push('left') });
    api.show('Dismissed.', { duration: 0, onClose: () => closed.push('dismissed') });
    await tick();

    // Nothing has closed yet, however long an Undo toast waits.
    expect(closed).toEqual([]);
    jest.advanceTimersByTime(1000);
    await tick();
    expect(closed).toEqual(['timer']);

    await fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '.cinder-toast-undo-actions__toggle',
      ) as HTMLButtonElement,
    );
    const undo = [...container.querySelectorAll<HTMLButtonElement>('.cinder-toast__action')].find(
      (button) => button.closest('.cinder-toast')?.textContent?.includes('Undone.'),
    );
    await fireEvent.click(undo as HTMLButtonElement);
    expect(order).toEqual(['undo', 'close']);

    const close = [...container.querySelectorAll<HTMLButtonElement>('.cinder-toast__dismiss')].find(
      (button) => button.closest('.cinder-toast')?.textContent?.includes('Dismissed.'),
    );
    await fireEvent.click(close as HTMLButtonElement);
    api.dismissUndo();
    api.dismiss(left);
    await tick();
    expect(closed).toEqual(['timer', 'undo', 'dismissed', 'left']);
  });

  test('onClose is called for a toast pushed out of the stack and for every toast when the region unmounts', async () => {
    const { api } = await mountRegion();
    const closed: string[] = [];
    for (const name of ['one', 'two', 'three', 'four', 'five', 'six']) {
      api.show(name, { duration: 0, onClose: () => closed.push(name) });
    }
    await tick();
    // The region keeps a bounded stack: the oldest went first.
    expect(closed[0]).toBe('one');
    const pushedOut = closed.length;
    cleanup();
    expect(closed).toHaveLength(6);
    expect(new Set(closed).size).toBe(6);
    expect(pushedOut).toBeLessThan(6);
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
      /\.cinder-toast-region\[data-cinder-phone\] \.cinder-toast__action::before\s*\{[^}]*var\(--cinder-touch-target-min\)/,
    );
    expect(cssText).toMatch(
      /@media \(any-pointer: coarse\)\s*\{[\s\S]*?\.cinder-toast__action::before\s*\{[^}]*var\(--cinder-touch-target-min\)/,
    );
    expect(cssText).toMatch(
      /\.cinder-toast__action::before\s*\{[^}]*var\(--cinder-control-height-xs\)/,
    );
    expect(cssText).not.toMatch(/\.cinder-toast__action\s*\{[^}]*min-block-size:/);
  });

  test('keeps retained recovery actions reachable in a viewport-bounded channel', () => {
    expect(cssText).toMatch(/\.cinder-toast-region\s*\{[^}]*max-block-size: min\(\s*50dvb,/);
    expect(cssText).toMatch(
      /\[data-cinder-position\^='bottom'\]\s*\{[^}]*max-block-size: min\(\s*50dvb,[\s\S]*?--_cinder-keyboard-inset[\s\S]*?--_cinder-docked-action-bar-height[\s\S]*?\);/,
    );
    expect(cssText).toMatch(
      /\.cinder-toast-region__channel\s*\{[^}]*flex: 0 1 auto;[^}]*min-block-size: 0;[^}]*pointer-events: auto;/,
    );
    expect(cssText).toMatch(
      /\.cinder-toast-region__channel\[data-cinder-overflowing\]\s*\{[^}]*overflow-y: auto;[^}]*scroll-padding-block: var\(--cinder-space-1\);/,
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
