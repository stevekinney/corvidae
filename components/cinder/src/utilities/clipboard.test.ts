/// <reference lib="dom" />
import { describe, expect, mock, test } from 'bun:test';
import { setupClipboardTests } from './clipboard-test-support.ts';
import { copyToClipboard } from './clipboard.ts';

setupClipboardTests();

describe('copyToClipboard', () => {
  test('writes plain text and HTML as one ClipboardItem', async () => {
    const write = mock(async (_items: ClipboardItem[]) => undefined);
    const writeText = mock(async () => undefined);
    const OriginalClipboardItem = globalThis.ClipboardItem;
    class TestClipboardItem {
      constructor(readonly values: Record<string, Blob>) {}
    }
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: TestClipboardItem,
    });
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText },
    });

    try {
      expect(await copyToClipboard('Hello', { html: '<strong>Hello</strong>' })).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      const [writtenItems] = write.mock.calls[0]!;
      const item = writtenItems[0];
      if (!(item instanceof TestClipboardItem))
        throw new Error('Expected the captured clipboard item');
      expect(await item.values['text/plain']?.text()).toBe('Hello');
      expect(await item.values['text/html']?.text()).toBe('<strong>Hello</strong>');
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'ClipboardItem', {
        configurable: true,
        value: OriginalClipboardItem,
      });
    }
  });

  test('falls back to writeText when a rich clipboard write is denied', async () => {
    const writeText = mock(async () => undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { write: mock(async () => Promise.reject(new Error('denied'))), writeText },
    });

    expect(await copyToClipboard('Fallback', { html: '<b>Fallback</b>' })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('Fallback');
  });

  test('copies plain text natively and does not reach the legacy path', async () => {
    const writeText = mock(async (_text: string) => undefined);
    const execCommand = mock(() => true);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    document.execCommand = execCommand;

    expect(await copyToClipboard('run-1')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('run-1');
    expect(execCommand).not.toHaveBeenCalled();
  });

  test('copies plain text through the legacy path when the clipboard API is unavailable', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const selected: string[] = [];
    document.execCommand = mock(() => {
      selected.push(document.querySelector('textarea')?.value ?? '');
      return true;
    });

    expect(await copyToClipboard('~/code/plugin')).toBe(true);
    expect(selected).toEqual(['~/code/plugin']);
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('returns false when the native write rejects and the legacy path reports failure', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mock(async () => Promise.reject(new Error('denied'))) },
    });
    document.execCommand = mock(() => false);

    expect(await copyToClipboard('nope')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('returns false when the native write rejects and the legacy path throws', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mock(async () => Promise.reject(new Error('denied'))) },
    });
    document.execCommand = mock(() => {
      throw new Error('not allowed');
    });

    expect(await copyToClipboard('nope')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('marks the legacy fallback textarea as hidden from assistive technology', async () => {
    const appendedTextareas: HTMLTextAreaElement[] = [];
    const appendChild = document.body.appendChild.bind(document.body);

    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mock(async () => Promise.reject(new Error('denied'))) },
    });

    document.body.appendChild = <T extends Node>(node: T): T => {
      if (node instanceof HTMLTextAreaElement) appendedTextareas.push(node);
      return appendChild(node);
    };

    document.execCommand = mock(() => true);

    expect(await copyToClipboard('secret-token')).toBe(true);
    expect(appendedTextareas).toHaveLength(1);
    expect(appendedTextareas[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(appendedTextareas[0]?.getAttribute('tabindex')).toBe('-1');
  });
});
