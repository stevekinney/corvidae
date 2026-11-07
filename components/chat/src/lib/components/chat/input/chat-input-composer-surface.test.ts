/// <reference lib="dom" />
/**
 * The composer as one bordered surface: a header row for the host's agent select, the formatting
 * toolbar and the words of its shortcuts while the box has focus, attachments as chips (a failed
 * one with its reason beside it and Remove), and a footer that folds the host's controls into one
 * when the composer is narrow and never wraps.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRawSnippet, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { COMPOSER_FOLD_WIDTH } from './composer-controls.ts';

setupHappyDom();

const { fireEvent, cleanup, render } = await import('@testing-library/svelte');
const { default: ChatInput } = await import('./chat-input.svelte');
const { default: FoldFixture } = await import('./chat-input-fold-fixture.svelte');

type ObserverCallback = (entries: ResizeObserverEntry[]) => void;
const observers: Array<{ callback: ObserverCallback; element: Element }> = [];
class FakeResizeObserver {
  readonly #callback: ObserverCallback;
  constructor(callback: ObserverCallback) {
    this.#callback = callback;
  }
  observe(element: Element): void {
    observers.push({ callback: this.#callback, element });
  }
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = globalThis.ResizeObserver;
let composerWidth = 900;
const originalRectangle = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  observers.length = 0;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { width: composerWidth, height: 0 } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  globalThis.ResizeObserver = originalResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = originalRectangle;
});

/** Tells every observer the composer is now `width` pixels wide. */
async function resizeTo(width: number): Promise<void> {
  composerWidth = width;
  for (const { callback } of observers) callback([]);
  await tick();
}

describe('the header row', () => {
  test('draws the host snippet inside the border, above the text', () => {
    const header = createRawSnippet(() => ({
      render: () => '<span data-testid="agent-select">Assistant</span>',
    }));
    const { container } = render(ChatInput, { id: 'surface-header', header });

    const form = container.querySelector('form.chat-input')!;
    const row = form.querySelector('.chat-input-header')!;
    expect(row.querySelector('[data-testid="agent-select"]')).not.toBeNull();
    expect(
      row.compareDocumentPosition(form.querySelector('textarea')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('draws no row without a header snippet', () => {
    const { container } = render(ChatInput, { id: 'surface-no-header' });
    expect(container.querySelector('.chat-input-header')).toBeNull();
  });
});

describe('the formatting row', () => {
  test('holds the toolbar and the words of the shortcuts, above the text', () => {
    const { container } = render(ChatInput, { id: 'surface-format', formattingToolbar: true });

    const row = container.querySelector('.chat-input-format')!;
    expect(row.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Formatting');
    expect(row.querySelector('.chat-input-format-hint')?.textContent).toBe(
      '⌘B bold · ⌘I italic · ⌘E code · ⌘⇧K link',
    );
    expect(row.querySelector('.chat-input-format-hint')?.getAttribute('aria-hidden')).toBe('true');
    // The toolbar left the footer: it is not beside attach and Send any more.
    expect(container.querySelector('.chat-input-footer [role="toolbar"]')).toBeNull();
    expect(
      row.compareDocumentPosition(container.querySelector('textarea')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('the link button names Cmd or Ctrl with Shift and K', () => {
    const { getByRole } = render(ChatInput, { id: 'surface-link', formattingToolbar: true });
    expect(getByRole('button', { name: 'Link' }).getAttribute('aria-keyshortcuts')).toBe(
      'Meta+Shift+K Control+Shift+K',
    );
  });

  test('is drawn only once the box or the row has focus, and stays while focus is in the composer', async () => {
    const source = await Bun.file(new URL('./chat-input.svelte', import.meta.url)).text();
    expect(source).toMatch(/\.chat-input-format\s*\{[^}]*display:\s*none;/);
    expect(source).toMatch(
      /\.chat-input\[data-formatting-open\] \.chat-input-format\s*\{\s*display:\s*flex;/,
    );
  });

  test('opens for the box, not for a control the host puts in the composer, so that control stays where a click found it', async () => {
    const { container, getByRole } = render(ChatInput, {
      id: 'surface-open',
      formattingToolbar: true,
      header: createRawSnippet(() => ({
        render: () => '<button type="button" data-testid="host-control">Agent</button>',
      })),
    });
    const form = container.querySelector('form')!;
    const control = container.querySelector<HTMLElement>('[data-testid="host-control"]')!;
    const box = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(form.hasAttribute('data-formatting-open')).toBe(false);

    // The host's control takes focus: the row stays closed, so nothing moves under the pointer.
    control.focus();
    await tick();
    expect(form.hasAttribute('data-formatting-open')).toBe(false);

    // The box takes focus: the row opens, and stays open while focus moves on inside the composer.
    box.focus();
    await tick();
    expect(form.hasAttribute('data-formatting-open')).toBe(true);
    control.focus();
    await tick();
    expect(form.hasAttribute('data-formatting-open')).toBe(true);
    getByRole('button', { name: 'Bold' }).focus();
    await tick();
    expect(form.hasAttribute('data-formatting-open')).toBe(true);

    // Focus leaves the composer: the row closes.
    box.blur();
    control.blur();
    getByRole('button', { name: 'Bold' }).blur();
    await tick();
    expect(form.hasAttribute('data-formatting-open')).toBe(false);
  });

  test('draws no row unless the toolbar is on', () => {
    const { container } = render(ChatInput, { id: 'surface-no-format' });
    expect(container.querySelector('.chat-input-format')).toBeNull();
  });
});

describe('the controls snippet is told when the composer is narrow', () => {
  function mountWithControls(): { target: HTMLElement } {
    const target = document.createElement('div');
    document.body.append(target);
    mount(FoldFixture, { target, props: { id: 'surface-fold' } });
    return { target };
  }

  const reading = (target: HTMLElement) =>
    target.querySelector('[data-testid="controls"]')?.textContent;

  test('a wide composer gets the full row', async () => {
    composerWidth = COMPOSER_FOLD_WIDTH * 16 + 100;
    const { target } = mountWithControls();
    await tick();
    expect(reading(target)).toBe('full');
  });

  test('a narrow composer is folded, and one that widens again is not', async () => {
    composerWidth = 340;
    const { target } = mountWithControls();
    await tick();
    expect(reading(target)).toBe('folded');

    await resizeTo(COMPOSER_FOLD_WIDTH * 16 + 1);
    expect(reading(target)).toBe('full');

    await resizeTo(COMPOSER_FOLD_WIDTH * 16 - 1);
    expect(reading(target)).toBe('folded');
  });

  test('the footer never wraps and its controls are touch-sized on a phone-width composer', async () => {
    const source = await Bun.file(new URL('./chat-input.svelte', import.meta.url)).text();
    expect(source).toMatch(/\.chat-input-footer-left\s*\{[^}]*flex-wrap:\s*nowrap;/);
    expect(source).toMatch(
      /@container \(max-inline-size: 28rem\)\s*\{\s*\.chat-input-footer :global\(\.cinder-button\)\s*\{\s*min-block-size: var\(--cinder-touch-target-min\);/,
    );
  });
});

describe('attachments', () => {
  const png = (name: string, bytes = 240 * 1024) =>
    new File([new Uint8Array(bytes)], name, { type: 'image/png' });

  function mountInput(props: Record<string, unknown> = {}) {
    const target = document.createElement('div');
    document.body.append(target);
    const instance = mount(ChatInput, { target, props: { id: 'surface-files', ...props } });
    return { target, instance };
  }

  test('an attached file is a removable chip with its name and size', async () => {
    const { target, instance } = mountInput();
    instance.addFiles([png('refund-photo.png')]);
    await tick();

    const chip = target.querySelector('.chat-attachment-preview')!;
    expect(chip.textContent?.replace(/\s+/g, ' ').trim()).toBe('refund-photo.png 240 KB');
    expect(chip.querySelector('button[aria-label="Remove refund-photo.png"]')).not.toBeNull();
    expect(target.querySelector('[data-attachment-error]')).toBeNull();
    unmount(instance);
  });

  test('chips sit between the text and the controls', async () => {
    const { target, instance } = mountInput();
    instance.addFiles([png('refund-photo.png')]);
    await tick();

    const list = target.querySelector('[aria-label="Attached files"]')!;
    expect(
      target.querySelector('textarea')!.compareDocumentPosition(list) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      list.compareDocumentPosition(target.querySelector('.chat-input-footer')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount(instance);
  });

  test('a failed file keeps its chip, with the reason beside it and a Remove link', async () => {
    const { target, instance } = mountInput({
      maxFileSize: 100,
      formatAttachmentError: () => 'Can’t attach: 240 KB is over the 100 B limit.',
    });
    instance.addFiles([png('photo.png')]);
    await tick();

    const item = target.querySelector('[data-attachment-state="error"]')!;
    expect(item.querySelector('.chat-attachment-preview')?.textContent).toContain('photo.png');
    expect(item.querySelector('[data-attachment-error]')?.textContent).toBe(
      'Can’t attach: 240 KB is over the 100 B limit.',
    );
    const remove = item.querySelector<HTMLButtonElement>('button')!;
    expect(remove.textContent?.trim()).toBe('Remove');
    expect(remove.getAttribute('aria-label')).toBe('Remove photo.png');

    await fireEvent.click(remove);
    expect(target.querySelector('[aria-label="Attached files"]')).toBeNull();
    unmount(instance);
  });

  test('typed text keeps Send enabled beside a failed file, and the failed file is left out', async () => {
    const submissions: Array<{ content: unknown; attachments: number }> = [];
    const { target, instance } = mountInput({
      maxFileSize: 100,
      onsubmit: (message: { content: unknown }, attachments: unknown[]) =>
        submissions.push({ content: message.content, attachments: attachments.length }),
    });
    instance.addFiles([png('photo.png')]);
    await tick();
    const editor = target.querySelector<HTMLTextAreaElement>('textarea')!;
    await fireEvent.input(editor, { target: { value: 'Please refund order 4471.' } });

    const send = target.querySelector<HTMLButtonElement>('[data-chat-send]')!;
    expect(send.disabled).toBe(false);
    await fireEvent.keyDown(editor, { key: 'Enter' });
    await tick();

    expect(submissions).toEqual([{ content: 'Please refund order 4471.', attachments: 0 }]);
    unmount(instance);
  });

  test('the announcement of a message sent beside a failed file names the file', async () => {
    const { target, instance } = mountInput({ maxFileSize: 100 });
    instance.addFiles([png('scan.tiff'), png('photo.png')]);
    await tick();
    const editor = target.querySelector<HTMLTextAreaElement>('textarea')!;
    await fireEvent.input(editor, { target: { value: 'hello' } });
    await fireEvent.keyDown(editor, { key: 'Enter' });
    await tick();

    const live = (): string =>
      [...target.querySelectorAll('[aria-live="polite"]')]
        .map((node) => node.textContent)
        .join(' ');
    await waitUntil(() => live().includes('Message sent without scan.tiff, photo.png'), {
      message: 'the announcement names the files that were left out',
    });
    unmount(instance);
  });
});

describe('the compact composer', () => {
  test('is marked compact, and Send becomes Stop with the field disabled while a reply streams', () => {
    const idle = render(ChatInput, {
      props: {
        id: 'compact',
        compact: true,
        placeholder: 'Send a test message',
        onsubmit: () => {},
      },
    } as never);
    const form = idle.container.querySelector('form.chat-input');
    expect(form?.hasAttribute('data-compact')).toBe(true);
    expect(idle.container.querySelector('textarea')?.getAttribute('placeholder')).toBe(
      'Send a test message',
    );
    expect(idle.container.querySelector('.chat-input-send')?.hasAttribute('data-stop')).toBe(false);
    idle.unmount();

    const streaming = render(ChatInput, {
      props: {
        id: 'compact-streaming',
        compact: true,
        sending: true,
        disabled: true,
        onstop: () => {},
        onsubmit: () => {},
      },
    } as never);
    expect(streaming.container.querySelector('.chat-input-send')?.hasAttribute('data-stop')).toBe(
      true,
    );
    expect(streaming.container.querySelector('textarea')?.disabled).toBe(true);
  });

  test('a composer that is not compact carries no such mark', () => {
    const { container } = render(ChatInput, {
      props: { id: 'regular', onsubmit: () => {} },
    } as never);
    expect(container.querySelector('form.chat-input')?.hasAttribute('data-compact')).toBe(false);
  });
});
