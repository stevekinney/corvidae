/// <reference lib="dom" />
import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetEscapeStack, resetScrollLock } from '../../_internal/overlay.ts';
import { emptySnippet, installDrawerDialogStubs } from './drawer-test-helpers.ts';

setupHappyDom();
installDrawerDialogStubs();
const { cleanup, render } = await import('@testing-library/svelte');
const { default: Drawer } = await import('./drawer.svelte');
const { applyReducedMotionPreference } =
  await import('../../utilities/use-reduced-motion.svelte.ts');
const { KEYBOARD_INSET_PROPERTY } = await import('../../_internal/keyboard-inset.ts');

type FadeRecord = {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
  finish: () => void;
};

const fades: FadeRecord[] = [];
const originalAnimate = HTMLElement.prototype.animate;

function installAnimateDouble(): void {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const listeners: Array<() => void> = [];
      const record: FadeRecord = {
        element: this,
        keyframes,
        options,
        cancelled: false,
        finish: () => {
          for (const listener of listeners) listener();
        },
      };
      fades.push(record);
      return {
        addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
        cancel: () => {
          record.cancelled = true;
        },
      };
    },
  });
}

beforeEach(() => {
  fades.length = 0;
  installAnimateDouble();
  applyReducedMotionPreference(document.documentElement, 'on');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
  resetEscapeStack();
  applyReducedMotionPreference(document.documentElement, 'system');
  document.documentElement.style.removeProperty(KEYBOARD_INSET_PROPERTY);
});
afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: originalAnimate,
  });
});

describe('Drawer under reduced motion (row 05d)', () => {
  test('cross-fades in instead of sliding', async () => {
    const { container } = render(Drawer, {
      props: { open: true, placement: 'bottom', title: 'Sheet', children: emptySnippet },
    });
    await waitUntil(() => fades.length > 0);
    const [fade] = fades;
    expect(fade?.element).toBe(container.querySelector('.cinder-drawer__panel') ?? undefined);
    expect(fade?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  test('keeps the panel mounted until the fade-out finishes, then closes', async () => {
    let openValue = true;
    let exitCount = 0;
    const { container } = render(Drawer, {
      props: {
        get open() {
          return openValue;
        },
        set open(value: boolean) {
          openValue = value;
        },
        placement: 'bottom',
        title: 'Sheet',
        children: emptySnippet,
        onExitComplete: () => {
          exitCount += 1;
        },
      },
    });
    await waitUntil(() => fades.length > 0);
    const close = container.querySelector<HTMLButtonElement>('.cinder-drawer__close');
    close?.click();
    await waitUntil(() => fades.some((fade) => fade.keyframes[1]?.['opacity'] === 0));
    const fadeOut = fades.find((fade) => fade.keyframes[1]?.['opacity'] === 0);
    expect(fadeOut?.options.fill).toBe('forwards');
    // The panel is still there, closing, while the fade plays.
    const panel = container.querySelector('.cinder-drawer__panel');
    expect(panel?.hasAttribute('data-cinder-closing')).toBe(true);
    expect(exitCount).toBe(0);
    fadeOut?.finish();
    await waitUntil(() => exitCount === 1);
    expect(container.querySelector('.cinder-drawer__panel')).toBeNull();
  });

  test('does not play a fade when motion is allowed', async () => {
    applyReducedMotionPreference(document.documentElement, 'off');
    render(Drawer, {
      props: { open: true, placement: 'bottom', title: 'Sheet', children: emptySnippet },
    });
    expect(fades).toHaveLength(0);
  });
});

describe('Drawer and the on-screen keyboard (row 05j)', () => {
  test('a bottom drawer publishes the keyboard inset while open and clears it on close', async () => {
    const { unmount } = render(Drawer, {
      props: { open: true, placement: 'bottom', title: 'Sheet', children: emptySnippet },
    });
    await waitUntil(
      () => document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY) !== '',
    );
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe('0px');
    unmount();
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe('');
  });

  test('a side drawer does not track the keyboard', async () => {
    render(Drawer, {
      props: { open: true, placement: 'right', title: 'Panel', children: emptySnippet },
    });
    await Promise.resolve();
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe('');
  });
});
