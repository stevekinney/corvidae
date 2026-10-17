/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { createRawSnippet, flushSync } from 'svelte';

setupHappyDom();

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/svelte');
const { default: SelectionPopover } = await import('./selection-popover.svelte');
const { default: SelectionPopoverOpenFixture } =
  await import('../../test/fixtures/selection-popover-open-fixture.svelte');
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

describe('SelectionPopover actions focus timing', () => {
  function pointerEvent(type: string): Event {
    return new (globalThis.PointerEvent ?? Event)(type, { bubbles: true });
  }

  /** Mounts the popover, presses a pointer on the window, then waits until it is positioned. */
  async function openDuringPointerGesture(): Promise<void> {
    render(SelectionPopover, {
      props: {
        id: 'selection-quote',
        open: true,
        position: basePosition,
        actions: quoteActions(() => {}),
      },
    });
    window.dispatchEvent(pointerEvent('pointerdown'));
    const toolbar = screen.getByRole('toolbar');
    await waitFor(() => {
      expect(toolbar.getAttribute('data-cinder-position-ready')).toBe('true');
    });
  }

  test('holds focus back while a pointer is down and moves it on pointerup', async () => {
    await openDuringPointerGesture();
    // Positioned and open, but the drag-select that opened it is still in progress.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.activeElement === screen.getByRole('button', { name: 'Quote' })).toBe(false);

    window.dispatchEvent(pointerEvent('pointerup'));

    await waitFor(() => {
      expect(document.activeElement === screen.getByRole('button', { name: 'Quote' })).toBe(true);
    });
  });

  test('moves focus on pointercancel as well', async () => {
    await openDuringPointerGesture();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement === screen.getByRole('button', { name: 'Quote' })).toBe(false);

    window.dispatchEvent(pointerEvent('pointercancel'));

    await waitFor(() => {
      expect(document.activeElement === screen.getByRole('button', { name: 'Quote' })).toBe(true);
    });
  });
});

describe('SelectionPopover actions keyboard model', () => {
  test('is one Tab stop and roves between actions with Left, Right, Home and End', async () => {
    const { toolbar } = await openWithActions();
    const quote = screen.getByRole('button', { name: 'Quote' });
    const share = screen.getByRole('button', { name: 'Share' });

    await waitFor(() => {
      expect(share.tabIndex).toBe(-1);
    });
    expect(quote.tabIndex).toBe(0);
    await waitFor(() => {
      expect(document.activeElement === quote).toBe(true);
    });

    await fireEvent.keyDown(quote, { key: 'ArrowRight' });
    expect(document.activeElement === share).toBe(true);
    expect(share.tabIndex).toBe(0);
    expect(quote.tabIndex).toBe(-1);

    await fireEvent.keyDown(share, { key: 'ArrowRight' });
    expect(document.activeElement === quote).toBe(true);

    await fireEvent.keyDown(quote, { key: 'End' });
    expect(document.activeElement === share).toBe(true);

    await fireEvent.keyDown(share, { key: 'Home' });
    expect(document.activeElement === quote).toBe(true);

    await fireEvent.keyDown(quote, { key: 'ArrowLeft' });
    expect(document.activeElement === share).toBe(true);
    const tabStops = Array.from(toolbar.querySelectorAll('button')).filter(
      (button) => button.tabIndex === 0,
    );
    expect(tabStops).toHaveLength(1);
  });
});

describe('SelectionPopover actions opening without a pointer gesture', () => {
  test('moves focus to the first action when open goes false to true with no pointer events', async () => {
    const { component } = render(SelectionPopoverOpenFixture);
    await new Promise((resolve) => setTimeout(resolve, 0));

    flushSync(() => (component as unknown as { show(): void }).show());

    await waitFor(() => {
      expect(document.activeElement === screen.getByRole('button', { name: 'Quote' })).toBe(true);
    });
  });

  test('a later pointerup does not pull focus back once it has moved', async () => {
    await openWithActions();
    await waitFor(() => {
      expect(document.activeElement === screen.getByRole('button', { name: 'Quote' })).toBe(true);
    });
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    window.dispatchEvent(new (globalThis.PointerEvent ?? Event)('pointerdown', { bubbles: true }));
    window.dispatchEvent(new (globalThis.PointerEvent ?? Event)('pointerup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.activeElement === outside).toBe(true);
  });

  test('retries the opening focus when the actions render a control after open', async () => {
    let container: Element | undefined;
    const lateActions = createRawSnippet<[{ close: () => void }]>(() => ({
      render: () => `<span></span>`,
      setup: (element) => {
        container = element;
      },
    }));
    await openWithActions({ actions: lateActions });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement === document.body).toBe(true);

    const late = document.createElement('button');
    late.textContent = 'Late';
    container?.append(late);

    await waitFor(() => {
      expect(document.activeElement === late).toBe(true);
    });
  });
});

describe('SelectionPopover actions focusability changes', () => {
  async function openWithButtons() {
    const { toolbar } = await openWithActions({ actions: quoteActions(() => {}) });
    const buttons = Array.from(toolbar.querySelectorAll('button'));
    await waitFor(() => {
      expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    });
    return { toolbar, buttons };
  }

  function tabStopCount(buttons: HTMLButtonElement[]): number {
    return buttons.filter((button) => button.tabIndex === 0 && !button.disabled).length;
  }

  test('disabling the active action moves the Tab stop to an enabled one', async () => {
    const { buttons } = await openWithButtons();
    const [quote, share] = buttons as [HTMLButtonElement, HTMLButtonElement];
    expect(quote.tabIndex).toBe(0);

    quote.disabled = true;

    await waitFor(() => {
      expect(share.tabIndex).toBe(0);
    });
    expect(tabStopCount(buttons)).toBe(1);
  });

  test('enabling a disabled action keeps exactly one Tab stop', async () => {
    const { buttons } = await openWithButtons();
    const [quote, share] = buttons as [HTMLButtonElement, HTMLButtonElement];
    quote.disabled = true;
    await waitFor(() => {
      expect(share.tabIndex).toBe(0);
    });

    quote.disabled = false;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(tabStopCount(buttons)).toBe(1);
  });
});

describe('SelectionPopover editable actions', () => {
  function editableActions() {
    return createRawSnippet<[{ close: () => void }]>(() => ({
      render: () =>
        `<span><button type="button" data-testid="before">Before</button><input data-testid="editor" value="abc" /><button type="button" data-testid="after">After</button></span>`,
    }));
  }

  async function openEditable() {
    const { toolbar } = await openWithActions({ actions: editableActions() });
    const before = toolbar.querySelector<HTMLButtonElement>('[data-testid="before"]')!;
    const editor = toolbar.querySelector<HTMLInputElement>('[data-testid="editor"]')!;
    const after = toolbar.querySelector<HTMLButtonElement>('[data-testid="after"]')!;
    await waitFor(() => {
      expect(before.tabIndex === 0 && editor.tabIndex === -1).toBe(true);
    });
    editor.focus();
    return { editor, before, after };
  }

  test('Home and End stay with the editor', async () => {
    const { editor } = await openEditable();

    const home = await fireEvent.keyDown(editor, { key: 'Home' });
    const end = await fireEvent.keyDown(editor, { key: 'End' });

    expect(home && end).toBe(true);
    expect(document.activeElement === editor).toBe(true);
  });

  test('Left and Right rove only when the caret is at the matching boundary', async () => {
    const { editor, before, after } = await openEditable();

    editor.setSelectionRange(1, 1);
    await fireEvent.keyDown(editor, { key: 'ArrowRight' });
    await fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    expect(document.activeElement === editor).toBe(true);

    editor.setSelectionRange(3, 3);
    await fireEvent.keyDown(editor, { key: 'ArrowRight' });
    expect(document.activeElement === after).toBe(true);

    editor.focus();
    editor.setSelectionRange(0, 0);
    await fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    expect(document.activeElement === before).toBe(true);
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
