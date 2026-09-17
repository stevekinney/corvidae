/// <reference lib="dom" />
import { setupHappyDom } from '@repo/testing';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import ReviewEditor from './review-editor.svelte';

setupHappyDom();

afterEach(() => {
  cleanup();
});

describe('ReviewEditor mounted inline controls', () => {
  test('mounts the original component and exposes its editor surface', async () => {
    const { container } = render(ReviewEditor, {
      props: {
        id: 'mounted-control',
        original: 'alpha beta',
        value: 'alpha beta',
        currentUserId: 'reviewer',
      },
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const surface = container.querySelector('.review-editor-main');
    expect(surface).not.toBeNull();
    expect(container.querySelector('[data-testid="review-editor"]')).not.toBeNull();
  });

  test('dispatches keyboard events through the current component container', async () => {
    const { container } = render(ReviewEditor, {
      props: {
        id: 'keyboard-control',
        original: 'alpha beta',
        value: 'alpha beta',
        currentUserId: 'reviewer',
      },
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const root = container.querySelector('[data-testid="review-editor"]');
    if (!(root instanceof HTMLElement)) throw new Error('ReviewEditor root missing');
    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test('selectionchange leaves the popover hidden for a collapsed selection', async () => {
    const { container } = render(ReviewEditor, {
      props: {
        id: 'selection-control',
        original: 'alpha beta',
        value: 'alpha beta',
        currentUserId: 'reviewer',
      },
    });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const root = container.querySelector('[data-testid="review-editor"]');
    if (!(root instanceof HTMLElement)) throw new Error('ReviewEditor root missing');
    const range = document.createRange();
    range.setStart(root, 0);
    range.collapse(true);
    const selection = window.getSelection();
    if (!selection) throw new Error('Browser selection unavailable');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    expect(container.querySelector('[data-cinder-visible="true"]')).toBeNull();
  });
});
