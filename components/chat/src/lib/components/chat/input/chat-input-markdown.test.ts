/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: ChatInput } = await import('./chat-input.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function composer(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor');
  if (!textarea) throw new Error('Missing composer textarea');
  return textarea;
}

async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await fireEvent.input(textarea, { target: { value } });
  await tick();
}

describe('ChatInput — Markdown in place', () => {
  test('styles the Markdown it will send in a backdrop behind the textarea', async () => {
    const { container } = render(ChatInput, { id: 'markdown-backdrop' });
    const textarea = composer(container);
    await type(textarea, 'Hello *world* and `code`\n- a list item');

    const backdrop = container.querySelector('.chat-input-markdown');
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop?.textContent?.replace('​', '')).toBe(textarea.value);
    expect(container.querySelector('.chat-input-markdown-emphasis')?.textContent).toBe('world');
    expect(container.querySelector('.chat-input-markdown-code')?.textContent).toBe('code');
    expect(container.querySelector('.chat-input-markdown-list-marker')?.textContent).toBe('- ');
    expect(container.querySelectorAll('.chat-input-markdown-marker')).toHaveLength(4);
    expect(textarea.classList.contains('chat-input-editor-styled')).toBe(true);
  });

  test('sends the Markdown text unchanged', async () => {
    const sent: string[] = [];
    const { container } = render(ChatInput, {
      id: 'markdown-send',
      onsubmit: (message) => sent.push(String(message.content)),
    });
    const textarea = composer(container);
    await type(textarea, '**Bold** and [a link](https://x.test)');
    await fireEvent.keyDown(textarea, { key: 'Enter' });
    await tick();

    expect(sent).toEqual(['**Bold** and [a link](https://x.test)']);
  });

  test('markdownStyling={false} renders the plain textarea', () => {
    const { container } = render(ChatInput, { id: 'markdown-off', markdownStyling: false });

    expect(container.querySelector('.chat-input-markdown')).toBeNull();
    expect(composer(container).classList.contains('chat-input-editor-styled')).toBe(false);
  });

  test('Cmd+B, Cmd+I, Cmd+E, and Cmd+K format the selection', async () => {
    const { container } = render(ChatInput, { id: 'markdown-shortcuts' });
    const textarea = composer(container);

    const cases = [
      { key: 'b', expected: 'say **hi**' },
      { key: 'i', expected: 'say *hi*' },
      { key: 'e', expected: 'say `hi`' },
      { key: 'k', expected: 'say [hi](url)' },
    ];
    for (const { key, expected } of cases) {
      await type(textarea, 'say hi');
      textarea.setSelectionRange(4, 6);
      const notPrevented = await fireEvent.keyDown(textarea, { key, metaKey: true });
      await tick();
      expect(notPrevented).toBe(false);
      expect(textarea.value).toBe(expected);
    }
    // The link leaves its URL placeholder selected, ready to paste over.
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe('url');
  });

  test('Ctrl+B pressed again on the bolded selection unwraps it', async () => {
    const { container } = render(ChatInput, { id: 'markdown-unwrap' });
    const textarea = composer(container);
    await type(textarea, 'say hi');
    textarea.setSelectionRange(4, 6);
    await fireEvent.keyDown(textarea, { key: 'b', ctrlKey: true });
    await tick();
    await fireEvent.keyDown(textarea, { key: 'b', ctrlKey: true });
    await tick();

    expect(textarea.value).toBe('say hi');
  });

  test('a host keydown handler that prevents default keeps the shortcut', async () => {
    const { container } = render(ChatInput, {
      id: 'markdown-host-first',
      oncomposerkeydown: (event) => event.preventDefault(),
    });
    const textarea = composer(container);
    await type(textarea, 'say hi');
    textarea.setSelectionRange(4, 6);
    await fireEvent.keyDown(textarea, { key: 'b', metaKey: true });
    await tick();

    expect(textarea.value).toBe('say hi');
  });

  test('the formatting toolbar applies the same commands', async () => {
    const { container, getByRole } = render(ChatInput, {
      id: 'markdown-toolbar',
      formattingToolbar: true,
    });
    const toolbar = getByRole('toolbar', { name: 'Formatting' });
    const labels = Array.from(toolbar.querySelectorAll('button'), (button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Bold', 'Italic', 'Code', 'Link', 'List']);

    const textarea = composer(container);
    await type(textarea, 'one');
    textarea.setSelectionRange(0, 3);
    await fireEvent.click(getByRole('button', { name: 'List' }));
    await tick();

    expect(textarea.value).toBe('- one');
  });

  test('a toolbar snippet receives the format command', async () => {
    const { createRawSnippet } = await import('svelte');
    let format: ((value: 'bold') => void) | undefined;
    const toolbar = createRawSnippet((context: () => { format: (value: 'bold') => void }) => ({
      render: () => '<span data-testid="custom-toolbar"></span>',
      setup: () => {
        format = context().format;
      },
    }));
    const { container, getByTestId } = render(ChatInput, { id: 'markdown-slot', toolbar });
    const textarea = composer(container);
    await type(textarea, 'hi');
    textarea.setSelectionRange(0, 2);

    expect(getByTestId('custom-toolbar')).not.toBeNull();
    format?.('bold');
    await tick();
    expect(textarea.value).toBe('**hi**');
  });
});

describe('ChatInput — status line', () => {
  test('shows waiting, reconnecting with its attempt, and queued', async () => {
    const { container, rerender } = render(ChatInput, {
      id: 'status-line',
      status: { kind: 'waiting', steers: true },
    });
    const line = () => container.querySelector('.chat-input-status');

    expect(line()?.textContent).toBe('Waiting for your approval · a message now steers the run');
    expect(line()?.getAttribute('data-chat-composer-status')).toBe('waiting');

    await rerender({ id: 'status-line', status: { kind: 'reconnecting', attempt: 3 } });
    expect(line()?.textContent).toBe('Reconnecting… attempt 3');

    await rerender({ id: 'status-line', status: { kind: 'queued', count: 2 } });
    expect(line()?.textContent).toBe('2 follow-ups queued · they send when the run is ready');

    await rerender({ id: 'status-line', status: undefined });
    expect(line()).toBeNull();
  });
});
