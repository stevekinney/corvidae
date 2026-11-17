/// <reference lib="dom" />
/**
 * COR-2171: CopyableValue is a value in monospace that breaks anywhere when its place is narrow,
 * followed by a copy control that stays on the value's last line.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: CopyableValue } = await import('./copyable-value.svelte');

const css = await Bun.file(new URL('./copyable-value.css', import.meta.url)).text();

const ADDRESS = 'https://example.com/triggers/nightly-digest';

let originalClipboard: Clipboard | undefined;
let written: string[] = [];

beforeEach(() => {
  originalClipboard = globalThis.navigator.clipboard;
  written = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: originalClipboard,
  });
});

function rootOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('.cinder-copyable-value');
  if (!root) throw new Error('copyable value root not rendered');
  return root;
}

function endOf(container: HTMLElement): HTMLElement {
  const end = container.querySelector<HTMLElement>('.cinder-copyable-value__end');
  if (!end) throw new Error('copyable value end not rendered');
  return end;
}

/**
 * The value as drawn: the text before the last character, then the last character. The root's own
 * `textContent` also holds the control's tooltip, which is not part of the value.
 */
function shown(container: HTMLElement): string {
  return `${rootOf(container).firstChild?.textContent ?? ''}${endOf(container).firstChild?.textContent ?? ''}`;
}

describe('CopyableValue', () => {
  test('shows the value whole, though the last character is set apart', () => {
    const { container } = render(CopyableValue, { props: { value: ADDRESS } });
    expect(shown(container)).toBe(ADDRESS);
    expect(rootOf(container).textContent).toContain(ADDRESS);
  });

  test('keeps the copy control in the stretch that holds the value’s last character', () => {
    const { container } = render(CopyableValue, { props: { value: ADDRESS } });
    const end = endOf(container);
    expect(end.firstChild?.textContent).toBe('t');
    expect(end.querySelector('button.cinder-copy-button')).toBeTruthy();
    // Everything before the last character sits outside the stretch, so the value can break there.
    expect(rootOf(container).firstChild?.textContent).toBe(ADDRESS.slice(0, -1));
    expect(end.parentElement).toBe(rootOf(container));
  });

  test('puts no whitespace anywhere between the value and the control, where a line could break', () => {
    const { container } = render(CopyableValue, { props: { value: ADDRESS } });
    const root = rootOf(container);
    const end = endOf(container);
    const control = end.querySelector('.cinder-copyable-value__control');
    expect(control).toBeTruthy();
    // The head text, the stretch, the last character and the control are neighbours with nothing between.
    expect(root.firstChild?.nextSibling).toBe(end);
    expect(end.firstChild?.nextSibling).toBe(control);
    expect(root.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(end.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });

  test('breaks the value anywhere, and never between its last character and the control', () => {
    expect(css).toMatch(/\.cinder-copyable-value \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.cinder-copyable-value__end \{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.cinder-copyable-value \{[^}]*font-family: var\(--cinder-font-mono\);/);
  });

  test('splits by code point, so a value ending in an astral character stays whole', () => {
    const value = 'abc\u{1F600}';
    const { container } = render(CopyableValue, { props: { value } });
    expect(endOf(container).firstChild?.textContent).toBe('\u{1F600}');
    expect(shown(container)).toBe(value);
  });

  test('an empty value renders the control alone', () => {
    const { container } = render(CopyableValue, { props: { value: '' } });
    expect(shown(container)).toBe('');
    expect(container.querySelector('button.cinder-copy-button')).toBeTruthy();
  });

  test('a one-character value has the whole value beside the control', () => {
    const { container } = render(CopyableValue, { props: { value: 'x' } });
    expect(endOf(container).firstChild?.textContent).toBe('x');
    expect(shown(container)).toBe('x');
  });

  test('the control is named by label, and copies the value', async () => {
    const { container, getByRole } = render(CopyableValue, {
      props: { value: ADDRESS, label: 'Copy the address', copiedLabel: 'Address copied' },
    });
    const button = getByRole('button', { name: 'Copy the address' });
    expect(container.contains(button)).toBe(true);
    await fireEvent.click(button);
    await waitFor(() => expect(written).toEqual([ADDRESS]));
    await waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toBe('Address copied'),
    );
  });

  test('the control is named "Copy to clipboard" until the page names it', () => {
    const { getByRole } = render(CopyableValue, { props: { value: ADDRESS } });
    expect(getByRole('button', { name: 'Copy to clipboard' })).toBeTruthy();
  });

  test('other attributes land on the outer element, and class merges', () => {
    const { container } = render(CopyableValue, {
      props: { value: ADDRESS, 'data-testid': 'address', class: 'mine' },
    });
    const root = container.querySelector('[data-testid="address"]');
    expect(root).toBe(rootOf(container));
    expect(root?.classList.contains('mine')).toBe(true);
  });
});
