/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// A controllable `matchMedia`, installed before the shared phone query is first read, so a test
// can put the viewport in its phone form and back.
type Listener = (event: Event) => void;
const listeners = new Set<Listener>();
let phone = false;
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    media: query,
    get matches() {
      return phone;
    },
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
  }),
});

afterAll(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

const { cleanup, render, waitFor } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: JsonEditor } = await import('./json-editor.svelte');

afterEach(() => {
  cleanup();
  phone = false;
});

const longLine = `{\n  "description": "${'A very long line of text that goes on. '.repeat(20)}"\n}`;

function setPhone(next: boolean): void {
  phone = next;
  for (const listener of listeners) listener(new Event('change'));
  flushSync();
}

function textareaOf(view: { container: HTMLElement }): HTMLTextAreaElement {
  return requiredInstance(view.container.querySelector('textarea'), HTMLTextAreaElement);
}

async function mountedContent(view: { container: HTMLElement }): Promise<HTMLElement> {
  await waitFor(() => expect(view.container.querySelectorAll('.cm-content').length).toBe(1));
  return requiredInstance(view.container.querySelector('.cm-content'), HTMLElement);
}

describe('JsonEditor — long lines by viewport (rows 05l, 29y)', () => {
  test('scrolls sideways at 640px and above, with no wrapping', async () => {
    const view = render(JsonEditor, { id: 'wide', label: 'Wide', value: longLine });
    const content = await mountedContent(view);

    expect(content.classList.contains('cm-lineWrapping')).toBe(false);
    expect(textareaOf(view).getAttribute('wrap')).toBe('off');
  });

  test('wraps below 640px and returns to sideways scrolling when the viewport widens', async () => {
    setPhone(true);
    const view = render(JsonEditor, { id: 'narrow', label: 'Narrow', value: longLine });
    const content = await mountedContent(view);

    expect(content.classList.contains('cm-lineWrapping')).toBe(true);
    expect(textareaOf(view).getAttribute('wrap')).toBe('soft');

    setPhone(false);
    await waitFor(() => expect(content.classList.contains('cm-lineWrapping')).toBe(false));
    expect(textareaOf(view).getAttribute('wrap')).toBe('off');
  });

  test('wrap="off" never wraps, and wrap="soft" always does, on a phone or not', async () => {
    setPhone(true);
    const off = render(JsonEditor, { id: 'off', label: 'Off', value: longLine, wrap: 'off' });
    const offContent = await mountedContent(off);
    expect(offContent.classList.contains('cm-lineWrapping')).toBe(false);
    cleanup();

    setPhone(false);
    const soft = render(JsonEditor, { id: 'soft', label: 'Soft', value: longLine, wrap: 'soft' });
    const softContent = await mountedContent(soft);
    expect(softContent.classList.contains('cm-lineWrapping')).toBe(true);
  });
});
