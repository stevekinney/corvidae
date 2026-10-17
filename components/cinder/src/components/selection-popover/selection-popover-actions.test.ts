/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { createRawSnippet } from 'svelte';

setupHappyDom();

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/svelte');
const { default: SelectionPopover } = await import('./selection-popover.svelte');
const { resetEscapeStack } = await import('../../_internal/overlay.ts');

afterEach(() => {
  cleanup();
  resetEscapeStack();
  document.body.replaceChildren();
});

/** A quote-style action row: a "Quote" button and a "Share" button, wired to the supplied handlers. */
function quoteActions(onQuote: () => void) {
  return createRawSnippet<[{ close: () => void }]>((api) => ({
    render: () =>
      `<span><button type="button" data-testid="quote">Quote</button><button type="button" data-testid="share">Share</button></span>`,
    setup: (element) => {
      const quote = element.querySelector('[data-testid="quote"]');
      const share = element.querySelector('[data-testid="share"]');
      quote?.addEventListener('click', () => {
        onQuote();
        api().close();
      });
      share?.addEventListener('click', () => {});
    },
  }));
}

const basePosition = { x: 120, y: 80, height: 20 } as const;

async function openWithActions(props: Record<string, unknown> = {}) {
  const result = render(SelectionPopover, {
    props: {
      id: 'selection-quote',
      open: true,
      position: basePosition,
      actions: quoteActions(() => {}),
      ...props,
    },
  });
  const toolbar = screen.getByRole('toolbar');
  await waitFor(() => {
    expect(toolbar.getAttribute('data-cinder-position-ready')).toBe('true');
  });
  return { ...result, toolbar };
}

describe('SelectionPopover actions snippet', () => {
  test('replaces the built-in comment button and composer', async () => {
    await openWithActions();

    expect(screen.getByRole('button', { name: 'Quote' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Add comment' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('moves focus to the first action when the popover opens', async () => {
    await openWithActions();

    await waitFor(() => {
      expect(document.activeElement === screen.getByRole('button', { name: 'Quote' })).toBe(true);
    });
  });

  test('does not call onExpand or onCommentSubmit and Enter and Space do not expand', async () => {
    let expandCalls = 0;
    let submitCalls = 0;
    const { toolbar } = await openWithActions({
      onExpand: () => {
        expandCalls += 1;
      },
      onCommentSubmit: () => {
        submitCalls += 1;
      },
    });

    const quote = screen.getByRole('button', { name: 'Quote' });
    const enter = await fireEvent.keyDown(quote, { key: 'Enter' });
    const space = await fireEvent.keyDown(quote, { key: ' ' });
    await fireEvent.keyDown(toolbar, { key: 'Enter' });
    await fireEvent.keyDown(toolbar, { key: ' ' });

    // Not prevented: the native button activation must stay intact.
    expect(enter).toBe(true);
    expect(space).toBe(true);
    expect(expandCalls).toBe(0);
    expect(submitCalls).toBe(0);
    expect(toolbar.hasAttribute('data-cinder-expanded')).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('Escape calls onClose', async () => {
    let closeCalls = 0;
    const { toolbar } = await openWithActions({
      onClose: () => {
        closeCalls += 1;
      },
    });

    await fireEvent.keyDown(toolbar, { key: 'Escape' });

    expect(closeCalls).toBe(1);
  });

  test('a pointerdown outside calls onClose', async () => {
    let closeCalls = 0;
    await openWithActions({
      onClose: () => {
        closeCalls += 1;
      },
    });

    const outside = document.createElement('button');
    document.body.append(outside);
    outside.dispatchEvent(new (globalThis.PointerEvent ?? Event)('pointerdown', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeCalls).toBe(1);
  });

  test('calling close from an action closes through the same exit path', async () => {
    let closeCalls = 0;
    let quoted = 0;
    await openWithActions({
      actions: quoteActions(() => {
        quoted += 1;
      }),
      onClose: () => {
        closeCalls += 1;
      },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Quote' }));

    expect(quoted).toBe(1);
    expect(closeCalls).toBe(1);
  });

  test('close restores focus to the element that had it before opening', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Surface';
    document.body.append(trigger);
    trigger.focus();

    await openWithActions();
    await waitFor(() => {
      expect(document.activeElement === screen.getByRole('button', { name: 'Quote' })).toBe(true);
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Quote' }));

    expect(document.activeElement).toBe(trigger);
  });
});

describe('SelectionPopover label', () => {
  test('defaults the toolbar name to "Selection actions"', () => {
    render(SelectionPopover, {
      props: { id: 'selection-comment', open: true, position: basePosition },
    });

    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).not.toBeNull();
  });

  test('label sets the toolbar accessible name', () => {
    render(SelectionPopover, {
      props: {
        id: 'selection-comment',
        open: true,
        position: basePosition,
        label: 'Quote selection',
      },
    });

    expect(screen.getByRole('toolbar', { name: 'Quote selection' })).not.toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).toBeNull();
  });

  test('label applies in actions mode too', async () => {
    await openWithActions({ label: 'Quote selection' });

    expect(screen.getByRole('toolbar', { name: 'Quote selection' })).not.toBeNull();
  });
});
