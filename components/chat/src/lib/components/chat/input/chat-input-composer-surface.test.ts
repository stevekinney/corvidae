/// <reference lib="dom" />
/**
 * The composer as one bordered surface: a header row for the host's agent select, the formatting
 * toolbar and the words of its shortcuts while the box has focus, attachments as tiles under a
 * count (a failed one with its reason beside it and the same cross to remove it), and a footer that
 * folds the host's controls into one when the composer is narrow and never wraps.
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
    // Each shortcut is its own element, spaced apart, never joined by a separator glyph.
    expect(
      [...(row.querySelector('.chat-input-format-hint')?.children ?? [])].map(
        (shortcut) => shortcut.textContent,
      ),
    ).toEqual(['⌘B bold', '⌘I italic', '⌘E code', '⌘⇧K link']);
    expect(row.querySelector('.chat-input-format-hint')?.textContent).not.toContain(
      String.fromCodePoint(0xb7),
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

  test('closes when a press elsewhere takes focus away only once the press is over, so the click it makes still lands', async () => {
    const { container } = render(ChatInput, { id: 'surface-press', formattingToolbar: true });
    const form = container.querySelector('form')!;
    const box = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    box.focus();
    await tick();
    expect(form.hasAttribute('data-formatting-open')).toBe(true);

    // The press goes down on a button elsewhere on the page, which takes focus from the box: the row
    // would give its height back and move that button before the click, so it stays open.
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    elsewhere.focus();
    await tick();
    expect(form.hasAttribute('data-formatting-open')).toBe(true);

    // The press is over: the click is delivered first, then the row closes.
    document.dispatchEvent(new Event('pointerup', { bubbles: true }));
    expect(form.hasAttribute('data-formatting-open')).toBe(true);
    await waitUntil(() => !form.hasAttribute('data-formatting-open'));
    expect(form.hasAttribute('data-formatting-open')).toBe(false);
    elsewhere.remove();
  });

  test('opens when the text box takes focus, not when a header control does, and stays while focus moves inside the composer', async () => {
    // The row opens above the text and the composer grows upward, so a header control that opened
    // it would move out from under the pointer before mouseup and its click would be lost.
    const header = createRawSnippet(() => ({
      render: () => '<button type="button" data-testid="agent-select">Assistant</button>',
    }));
    const { container, getByTestId } = render(ChatInput, {
      id: 'surface-focus',
      formattingToolbar: true,
      header,
    });
    const form = container.querySelector('form.chat-input')!;
    const select = getByTestId('agent-select');
    const editor = container.querySelector('textarea')!;

    await fireEvent.focusIn(select);
    expect(form.hasAttribute('data-formatting-open')).toBe(false);

    await fireEvent.focusIn(editor);
    expect(form.hasAttribute('data-formatting-open')).toBe(true);

    // Focus moving to the header's control within the composer keeps the row, so nothing moves.
    await fireEvent.focusOut(editor, { relatedTarget: select });
    await fireEvent.focusIn(select);
    expect(form.hasAttribute('data-formatting-open')).toBe(true);

    await fireEvent.focusOut(select, { relatedTarget: document.body });
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

  test('a capped attachment list is no scroll box, and on a phone each file is a full-width row (C#4)', async () => {
    const source = await Bun.file(new URL('./chat-input.svelte', import.meta.url)).text();
    expect(source).toMatch(
      /\.chat-input-attachments\[data-expanded\]\s*\{[^}]*max-block-size: 12rem;[^}]*overflow-y: auto;/,
    );
    expect(source).not.toContain('mask-image');
    expect(source).toMatch(
      /@container \(max-inline-size: 30rem\)\s*\{\s*\.chat-input-attachments\s*\{\s*align-items: stretch;/,
    );
    // The name wraps there instead of being cut to its first letter.
    expect(source).toMatch(
      /:global\(\.chat-attachment-preview-name\)\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/,
    );
  });

  test('Attach and Send are at least 44px on both sides on a phone-width composer and a touch screen', async () => {
    const source = await Bun.file(new URL('./chat-input.svelte', import.meta.url)).text();
    const touchSized =
      /\.chat-input-footer :global\(\.cinder-button\) \{\s*min-block-size: var\(--cinder-touch-target-min\);\s*min-inline-size: var\(--cinder-touch-target-min\);/g;
    expect(source.match(touchSized)).toHaveLength(2);
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

  test('an attached file is a removable tile with its type badge, name and size', async () => {
    const { target, instance } = mountInput();
    instance.addFiles([png('refund-photo.png')]);
    await tick();

    const chip = target.querySelector('.chat-attachment-preview')!;
    expect(chip.textContent?.replace(/\s+/g, ' ').trim()).toBe('PNG refund-photo.png 240 KB');
    const filename = chip.querySelector<HTMLElement>('.chat-attachment-preview-name');
    expect(filename?.textContent).toBe('refund-photo.png');
    expect(filename?.getAttribute('title')).toBe('refund-photo.png');
    expect(chip.querySelector('button[aria-label="Remove refund-photo.png"]')).not.toBeNull();
    expect(target.querySelector('[data-attachment-error]')).toBeNull();
    unmount(instance);
  });

  test('the attachment shelf sits above the text and before the controls', async () => {
    const { target, instance } = mountInput();
    instance.addFiles([png('refund-photo.png')]);
    await tick();

    const list = target.querySelector('[aria-label="Attached files"]')!;
    expect(
      list.compareDocumentPosition(target.querySelector('textarea')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      list.compareDocumentPosition(target.querySelector('.chat-input-footer')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount(instance);
  });

  test('renders host-provided attachment labels in visible and accessible controls', async () => {
    const { target, instance } = mountInput({
      labels: {
        attachedFiles: 'Angehängte Dateien',
        moreAttachments: (count: number) => `${count} weitere unten`,
        retryAttachment: 'Erneut versuchen',
        retryAttachmentAccessible: (name: string) => `Erneut versuchen: ${name}`,
        removeAttachment: 'Entfernen',
        removeAttachmentAccessible: (name: string) => `Entfernen: ${name}`,
        attachmentBlockingReason: () => 'Bitte Dateien erneut versuchen oder entfernen',
      },
    });
    instance.addFiles(Array.from({ length: 4 }, (_, index) => png(`foto-${index}.png`)));
    await tick();

    expect(target.querySelector('[aria-label="Angehängte Dateien"]')).not.toBeNull();
    expect(target.querySelector('.chat-input-attachment-more')?.textContent?.trim()).toBe(
      '1 weitere unten',
    );
    expect(target.querySelector('button[aria-label="Entfernen: foto-1.png"]')).not.toBeNull();
    unmount(instance);
  });

  test('renders host-provided composer labels', () => {
    const { target, instance } = mountInput({
      labels: {
        composer: 'Nachricht verfassen',
        sendMessage: 'Nachricht senden',
      },
    });

    expect(target.querySelector('form')?.getAttribute('aria-label')).toBe('Nachricht verfassen');
    expect(target.querySelector('[data-chat-send]')?.getAttribute('aria-label')).toBe(
      'Nachricht senden',
    );
    unmount(instance);
  });

  test('a refused file keeps its tile, with the reason beside it and only the cross to remove it', async () => {
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
    // A file the composer refused cannot be retried; it is removed with the same cross as any tile.
    expect(item.querySelector('button[aria-label="Retry photo.png"]')).toBeNull();
    const remove = item.querySelector<HTMLButtonElement>('button[aria-label="Remove photo.png"]')!;
    expect(remove.classList.contains('chat-input-attachment-remove')).toBe(true);

    await fireEvent.click(remove);
    expect(target.querySelector('[aria-label="Attached files"]')).toBeNull();
    unmount(instance);
  });

  test('a failed file turns Send off, keeps its reason in the shelf, and Send names it', async () => {
    const submissions: unknown[] = [];
    const { target, instance } = mountInput({
      maxFileSize: 100,
      onsubmit: (message: { content: unknown }) => submissions.push(message.content),
    });
    instance.addFiles([png('photo.png')]);
    await tick();
    const editor = target.querySelector<HTMLTextAreaElement>('textarea')!;
    await fireEvent.input(editor, { target: { value: 'Please refund order 4471.' } });
    await tick();

    const send = target.querySelector<HTMLButtonElement>('[data-chat-send]')!;
    expect(send.disabled).toBe(true);
    const reason = target.querySelector<HTMLElement>('.chat-input-attachment-reason')!;
    expect(reason.textContent?.trim()).toBe('Retry or remove 1 file to send');
    expect(send.getAttribute('aria-describedby')?.split(' ')).toContain(reason.id);
    expect(target.querySelector('.chat-input-attachment-shelf')?.contains(reason)).toBe(true);

    await fireEvent.keyDown(editor, { key: 'Enter' });
    await tick();
    expect(submissions).toEqual([]);

    // Removing the file clears the reason, and the message sends.
    await fireEvent.click(
      target.querySelector<HTMLButtonElement>('[aria-label="Remove photo.png"]')!,
    );
    await tick();
    expect(target.querySelector('.chat-input-attachment-reason')).toBeNull();
    expect(send.disabled).toBe(false);
    unmount(instance);
  });

  test('the count over the tiles names the files, and the shelf says what blocks Send (C#16)', async () => {
    const { target, instance } = mountInput({ maxFileSize: 1024 });
    instance.addFiles([png('small.png', 10), png('big.png'), png('bigger.png')]);
    await tick();

    const summary = target.querySelector('[data-chat-attachment-summary]')!;
    expect(summary.textContent?.trim()).toBe('3 files 2 files need attention');
    expect(summary.textContent).not.toContain(String.fromCodePoint(0xb7));
    expect(target.querySelector('.chat-input-attachment-reason')?.textContent?.trim()).toBe(
      'Retry or remove 2 files to send',
    );
    expect(target.textContent).toContain('2 files need attention');
    unmount(instance);
  });

  test('a long list is capped, with a count of the rest under it that opens the whole list', async () => {
    const { target, instance } = mountInput();
    instance.addFiles(
      Array.from({ length: 14 }, (_, index) => png(`page-${String(index + 1)}.png`, 10)),
    );
    await tick();

    const list = target.querySelector<HTMLElement>('[aria-label="Attached files"]')!;
    expect(list.hasAttribute('data-expanded')).toBe(false);
    // Exactly the tiles shown are drawn, so the count under them is the rest of the files (C#4).
    expect(list.querySelectorAll('li')).toHaveLength(3);
    const more = target.querySelector<HTMLButtonElement>('.chat-input-attachment-more')!;
    expect(more.textContent?.trim()).toBe('11 more below');
    expect(more.getAttribute('aria-controls')).toBe(list.id);

    await fireEvent.click(more);
    await tick();

    expect(list.querySelectorAll('li')).toHaveLength(14);
    expect(list.hasAttribute('data-expanded')).toBe(true);
    expect(target.querySelector('.chat-input-attachment-more')).toBeNull();
    // Every file can still be removed, and Send stays a control of the composer.
    expect(target.querySelector('[aria-label="Remove page-14.png"]')).not.toBeNull();
    expect(target.querySelector('[data-chat-send]')).not.toBeNull();
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
