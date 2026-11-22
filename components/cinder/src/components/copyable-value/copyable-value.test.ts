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
 * The value as drawn: the text of every part, without the control. The root's own `textContent`
 * also holds the control's tooltip, which is not part of the value.
 */
function shown(container: HTMLElement): string {
  const copy = rootOf(container).cloneNode(true) as HTMLElement;
  for (const control of copy.querySelectorAll('.cinder-copyable-value__control')) control.remove();
  return copy.textContent ?? '';
}

/** The parts of the value, outermost first, each as the pieces it holds (one when it has no dots). */
function partsOf(container: HTMLElement): string[][] {
  return Array.from(
    rootOf(container).querySelectorAll<HTMLElement>(':scope > .cinder-copyable-value__part'),
  ).map((part) => {
    const pieces = Array.from(
      part.querySelectorAll<HTMLElement>(':scope > .cinder-copyable-value__piece'),
    );
    const own = (element: HTMLElement) => {
      const copy = element.cloneNode(true) as HTMLElement;
      for (const control of copy.querySelectorAll('.cinder-copyable-value__control'))
        control.remove();
      return copy.textContent ?? '';
    };
    return pieces.length === 0 ? [own(part)] : pieces.map(own);
  });
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
    // The stretch sits inside the value's last part, so a line can never end between the last
    // character and the control, nor leave the character and the control alone on a row below the
    // rest of the part.
    const parts = rootOf(container).querySelectorAll(':scope > .cinder-copyable-value__part');
    expect(end.closest('.cinder-copyable-value__part')).toBe(parts[parts.length - 1]!);
    // Nothing follows the stretch but Svelte's own anchors, which are comments and empty text, and
    // draw nothing.
    for (let node = end.nextSibling; node !== null; node = node.nextSibling) {
      expect(node.nodeType === Node.COMMENT_NODE || (node.textContent ?? '') === '').toBe(true);
    }
  });

  test('puts no whitespace anywhere between the parts or before the control, where a line could break', () => {
    const { container } = render(CopyableValue, { props: { value: ADDRESS } });
    const root = rootOf(container);
    const end = endOf(container);
    const control = end.querySelector('.cinder-copyable-value__control');
    expect(control).toBeTruthy();
    expect(end.firstChild?.nextSibling).toBe(control);
    expect(end.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    // Every text node in the value holds a character: a space or a line break between two boxes
    // would be a place to break that the value does not own.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        (node.parentElement as HTMLElement).closest('.cinder-copyable-value__control')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      expect(/^\s+$/.test(node.textContent ?? '')).toBe(false);
    }
    expect(root.querySelectorAll('wbr')).toHaveLength(0);
  });

  test('breaks the A2A address by part first and by dot only inside a part, so no host or extension splits first', () => {
    const value = 'http://127.0.0.1:7433/.well-known/agent-card.json';
    const { container } = render(CopyableValue, { props: { value } });
    expect(partsOf(container)).toEqual([
      ['http://'],
      ['127.', '0.', '0.', '1:'],
      ['7433/'],
      ['.well-known/'],
      ['agent-card.', 'json'],
    ]);
    expect(shown(container)).toBe(value);
  });

  test('breaks the MCP address after its colon and each slash, with the host whole', () => {
    const value = 'http://127.0.0.1:7234/bureau/mcp';
    const { container } = render(CopyableValue, { props: { value } });
    expect(partsOf(container).map((pieces) => pieces.join(''))).toEqual([
      'http://',
      '127.0.0.1:',
      '7234/',
      'bureau/',
      'mcp',
    ]);
    expect(shown(container)).toBe(value);
  });

  test('draws each part and piece as a box that breaks inside itself only when it is longer than the line', () => {
    const box =
      /\.cinder-copyable-value__part,\s*\.cinder-copyable-value__piece \{([^}]*)\}/.exec(
        css,
      )?.[1] ?? '';
    expect(box).toContain('display: inline-block;');
    expect(box).toContain('max-inline-size: 100%;');
    expect(box).toContain('overflow-wrap: anywhere;');
    expect(css).toMatch(/\.cinder-copyable-value \{[^}]*overflow-wrap: anywhere;/);
  });

  test('a value with no punctuation to break at is one box, and copies unchanged', async () => {
    const { container, getByRole } = render(CopyableValue, { props: { value: 'abcdefgh' } });
    expect(partsOf(container)).toEqual([['abcdefgh']]);
    expect(container.querySelectorAll('.cinder-copyable-value__piece')).toHaveLength(0);
    expect(shown(container)).toBe('abcdefgh');
    await fireEvent.click(getByRole('button'));
    await waitFor(() => expect(written).toEqual(['abcdefgh']));
  });

  test('copies the value whole, whatever break opportunities it draws', async () => {
    const value = 'http://127.0.0.1:7234/bureau/mcp?x=1&y=2';
    const { getByRole } = render(CopyableValue, { props: { value } });
    await fireEvent.click(getByRole('button'));
    await waitFor(() => expect(written).toEqual([value]));
  });

  test('draws its control quiet and bare, as CodeBlock does, not as CopyButton’s bordered chip', () => {
    const rule =
      /\.cinder-copyable-value \.cinder-copyable-value__control \.cinder-copy-button \{([^}]*)\}/.exec(
        css,
      )?.[1] ?? '';
    expect(rule).toContain('border: 1px solid transparent;');
    expect(rule).toContain('background: transparent;');
    expect(rule).toContain('color: var(--cinder-text-muted);');
    expect(rule).toContain('inline-size: 1.5rem;');
    // The hover wash and the copied colour are written at the same specificity, so they win.
    expect(css).toMatch(
      /\.cinder-copyable-value \.cinder-copyable-value__control \.cinder-copy-button:hover \{[^}]*background: var\(--cinder-surface-hover\);/,
    );
    expect(css).toMatch(
      /\.cinder-copy-button\[data-cinder-copied\] \{[^}]*color: var\(--cinder-status-success-text\);/,
    );
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

  // COR-2548: after "The API is at" the address broke between two of its parts ("127.0.0.1:" and
  // "7399/api") though it fits a row, because each part was a box and the value itself was not.
  test('the whole value is one box that moves to the next row whole when it fits one', () => {
    const flat = css.replace(/\s+/g, ' ');
    expect(flat).toMatch(
      /\.cinder-copyable-value \{[^}]*display: inline-block;[^}]*max-inline-size: 100%;/,
    );
    const { container } = render(CopyableValue, { props: { value: ADDRESS } });
    // Every part, and the control, sit inside the one root box.
    const root = rootOf(container);
    expect(root.querySelectorAll(':scope > .cinder-copyable-value__part').length).toBeGreaterThan(
      1,
    );
    expect(root.querySelector('button')).not.toBeNull();
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
