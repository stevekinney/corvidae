/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup, fireEvent, waitFor } = await import('@testing-library/svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const { default: Text } = await import('./text.svelte');
const { createRawSnippet } = await import('svelte');

const textCss = await Bun.file(new URL('./text.css', import.meta.url)).text();

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('Text', () => {
  test.each([
    ['h1', 'H1'],
    ['h2', 'H2'],
    ['h3', 'H3'],
    ['h4', 'H4'],
    ['h5', 'H5'],
    ['caption', 'P'],
    ['body', 'P'],
  ] as const)('variant %p renders a %p element', (variant, tagName) => {
    const { container } = render(Text, { variant, children: textSnippet('hello') });
    const root = container.querySelector('.cinder-text');

    expect(root?.tagName).toBe(tagName);
    expect(root?.getAttribute('data-cinder-variant')).toBe(variant);
    expect(root?.textContent).toContain('hello');
  });

  test('defaults to the body variant rendered as a paragraph', () => {
    const { container } = render(Text, { children: textSnippet('hello') });
    const root = container.querySelector('.cinder-text');

    expect(root?.tagName).toBe('P');
    expect(root?.getAttribute('data-cinder-variant')).toBe('body');
  });

  test('as overrides the element without changing the variant', () => {
    const { container } = render(Text, {
      variant: 'h1',
      as: 'span',
      children: textSnippet('hello'),
    });
    const root = container.querySelector('.cinder-text');

    expect(root?.tagName).toBe('SPAN');
    expect(root?.getAttribute('data-cinder-variant')).toBe('h1');
  });

  test('merges class and spreads rest props', () => {
    const { container } = render(Text, {
      class: 'custom',
      'data-testid': 'text',
      children: textSnippet('hello'),
    });
    const root = container.querySelector('[data-testid="text"]');

    expect(root?.classList.contains('cinder-text')).toBe(true);
    expect(root?.classList.contains('custom')).toBe(true);
  });

  test('takes its color from the container rather than a color token', () => {
    expect(textCss).toContain('color: currentColor;');
    expect(textCss).not.toMatch(/color:\s*var\(--cinder-text-(default|muted|subtle)/);
  });

  test('resets wrapping and tracking on the base so `as` cannot change a variant look', () => {
    const base = textCss.match(/\.cinder-text \{[^}]*\}/)?.[0] ?? '';
    expect(base).toContain('letter-spacing: normal;');
    expect(base).toContain('text-wrap: wrap;');
    expect(base).toContain('overflow-wrap: break-word;');
    for (const heading of ['h1', 'h2', 'h3', 'h4', 'h5']) {
      const rule = textCss.match(
        new RegExp(`data-cinder-variant='${heading}'\\] \\{[^}]*\\}`),
      )?.[0];
      expect(rule).toContain('letter-spacing: var(--cinder-tracking-tight);');
      expect(rule).toContain('text-wrap: balance;');
    }
  });
});

describe('Text clamp', () => {
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

  // happy-dom has no layout, so a test says how tall the run is and how tall its box is.
  function measure(heights: { scroll: number; client: number }) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => heights.scroll,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => heights.client,
    });
  }

  afterEach(() => {
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  });

  test('holds the run to its lines through a custom property the stylesheet clamps with', () => {
    measure({ scroll: 100, client: 100 });
    const { container } = render(Text, { clamp: 5, children: textSnippet('long reply') });
    const root = container.querySelector('.cinder-text') as HTMLElement;

    expect(root.hasAttribute('data-cinder-clamp')).toBe(true);
    expect(root.style.getPropertyValue('--_cinder-text-lines')).toBe('5');
    expect(textCss).toMatch(
      /\[data-cinder-clamp\][^}]*-webkit-line-clamp: var\(--_cinder-text-lines\)/,
    );
  });

  test('offers Show all only while the run is cut off', () => {
    measure({ scroll: 100, client: 100 });
    const { container } = render(Text, { clamp: 5, children: textSnippet('short reply') });

    expect(container.querySelector('.cinder-text__toggle')).toBeNull();
  });

  test('opens the run in place and offers Show less', async () => {
    measure({ scroll: 140, client: 100 });
    const { container } = render(Text, { clamp: 5, children: textSnippet('long reply') });
    const root = container.querySelector('.cinder-text') as HTMLElement;
    const toggle = container.querySelector('.cinder-text__toggle') as HTMLButtonElement;

    expect(toggle.textContent?.trim()).toBe('Show all');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(root.id);

    toggle.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.hasAttribute('data-cinder-clamp')).toBe(false);
    expect(toggle.textContent?.trim()).toBe('Show less');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  test('keeps the toggle in the root element it controls, never inside the clamped run', () => {
    measure({ scroll: 140, client: 100 });
    const { container } = render(Text, { clamp: 2, children: textSnippet('long reply') });
    const root = container.querySelector('.cinder-text') as HTMLElement;

    expect(root.querySelector('button')).toBeNull();
  });

  test("puts the page's own action beside Show all, after a middle dot in the stylesheet", () => {
    measure({ scroll: 140, client: 100 });
    const { container } = render(Text, {
      clamp: 5,
      children: textSnippet('long reply'),
      actions: textSnippet('Show raw payloads'),
    });
    const footer = container.querySelector('.cinder-text__footer');

    expect(footer?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Show all Show raw payloads');
    expect(footer?.querySelector('.cinder-text__toggle + .cinder-text__actions')).not.toBeNull();
    expect(textCss).toContain('.cinder-text__toggle + .cinder-text__actions::before');
  });

  test('shows the action alone when the run fits', () => {
    measure({ scroll: 100, client: 100 });
    const { container } = render(Text, {
      clamp: 5,
      children: textSnippet('short reply'),
      actions: textSnippet('Show raw payloads'),
    });

    expect(container.querySelector('.cinder-text__toggle')).toBeNull();
    expect(container.querySelector('.cinder-text__actions')?.textContent).toBe('Show raw payloads');
  });

  test('starts open when expanded is set', () => {
    measure({ scroll: 140, client: 140 });
    const { container } = render(Text, {
      clamp: 5,
      expanded: true,
      children: textSnippet('long reply'),
    });

    expect(container.querySelector('.cinder-text')?.hasAttribute('data-cinder-clamp')).toBe(false);
    expect(container.querySelector('.cinder-text__toggle')?.textContent?.trim()).toBe('Show less');
  });

  test.each([0, -2, Number.NaN])('treats clamp %p as no clamp', (clamp) => {
    const { container } = render(Text, { clamp, children: textSnippet('plain') });

    expect(container.querySelector('[data-cinder-clamp]')).toBeNull();
    expect(container.querySelector('.cinder-text__footer')).toBeNull();
  });
});

describe('Text middle truncation', () => {
  const identifier = 'payments-worker-eu-west-1b-7f3a9c2e-4d81-4b06-a9e2-1c5d0f7b3a68';

  test('splits the text so the last four characters always show', () => {
    const { container } = render(Text, { truncate: 'middle', text: identifier });
    const root = container.querySelector('.cinder-text') as HTMLElement;

    expect(root.querySelector('.cinder-text__tail')?.textContent).toBe('3a68');
    expect(root.querySelector('.cinder-text__head')?.textContent).toBe(identifier.slice(0, -4));
    expect(root.textContent).toBe(identifier);
    expect(root.getAttribute('data-cinder-truncate')).toBe('middle');
  });

  test('carries the full text as a Cinder tooltip unless the page sets one', async () => {
    const { container } = render(Text, { truncate: 'middle', text: identifier });
    const root = container.querySelector('.cinder-text') as HTMLElement;

    // Not a native `title`: that is unreachable by keyboard and touch.
    expect(root.hasAttribute('title')).toBe(false);
    expect(root.getAttribute('tabindex')).toBe('0');
    await fireEvent.focus(root);
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(identifier),
    );

    cleanup();
    const custom = render(Text, { truncate: 'middle', text: identifier, title: 'Worker id' });
    const customRoot = custom.container.querySelector('.cinder-text') as HTMLElement;
    expect(customRoot.hasAttribute('title')).toBe(false);
    await fireEvent.focus(customRoot);
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Worker id'),
    );
  });

  test('keeps a longer tail when asked and never splits a surrogate pair', () => {
    const { container } = render(Text, {
      truncate: 'middle',
      text: 'run-\u{1F600}\u{1F600}-end',
      tailLength: 5,
    });

    expect(container.querySelector('.cinder-text__tail')?.textContent).toBe('\u{1F600}-end');
  });

  test('a tail longer than the text leaves nothing to cut', () => {
    const { container } = render(Text, { truncate: 'middle', text: 'abc', tailLength: 10 });

    expect(container.querySelector('.cinder-text__head')?.textContent).toBe('');
    expect(container.querySelector('.cinder-text__tail')?.textContent).toBe('abc');
  });

  test('the head gives way with an ellipsis while the tail never shrinks', () => {
    expect(textCss).toMatch(/\.cinder-text__head \{[^}]*text-overflow: ellipsis;/);
    expect(textCss).toMatch(/\.cinder-text__tail \{[^}]*flex: none;/);
  });
});

describe('Text middle truncation fit', () => {
  const identifier = 'payments-worker-eu-west-1b-7f3a9c2e-4d81-4b06-a9e2-1c5d0f7b3a68';
  const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
  const names = ['clientWidth', 'scrollWidth', 'getBoundingClientRect'] as const;
  const originals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    for (const name of names) {
      originals.set(name, Object.getOwnPropertyDescriptor(prototype, name));
    }
  });

  afterEach(() => {
    for (const name of names) {
      const original = originals.get(name);
      if (original === undefined) delete prototype[name];
      else Object.defineProperty(prototype, name, original);
    }
  });

  /** A layout where the head's box is `box` pixels wide, its text is wider, and a character is 10px. */
  function stubLayout(box: number): void {
    const isHead = (element: HTMLElement): boolean =>
      element.classList.contains('cinder-text__head');
    Object.defineProperty(prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return isHead(this) ? box : 0;
      },
    });
    Object.defineProperty(prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return isHead(this) ? 600 : 0;
      },
    });
    Object.defineProperty(prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        return { width: Array.from(this.textContent ?? '').length * 10 };
      },
    });
  }

  test('sizes the head to the longest cut that fits, so the ellipsis sits against the tail', () => {
    stubLayout(155);
    const { container } = render(Text, { truncate: 'middle', text: identifier });
    const head = container.querySelector('.cinder-text__head') as HTMLElement;

    // 155px holds fifteen characters: fourteen of the head and the ellipsis, plus a pixel of room.
    expect(head.style.inlineSize).toBe('151px');
    expect(head.textContent).toBe(identifier.slice(0, -4));
    expect(container.querySelector('.cinder-text')?.querySelector('span[aria-hidden]')).toBeNull();
  });

  test('leaves the head alone when it fits whole', () => {
    stubLayout(155);
    Object.defineProperty(prototype, 'scrollWidth', { configurable: true, value: 100 });
    const { container } = render(Text, { truncate: 'middle', text: identifier });

    expect((container.querySelector('.cinder-text__head') as HTMLElement).style.inlineSize).toBe(
      '',
    );
  });
});

describe('Text truncate="end"', () => {
  const longName = `responsive-model-${'m'.repeat(300)}`;

  test('renders the whole text on one cut line, with the whole of it in the title', () => {
    const { container } = render(Text, { as: 'span', truncate: 'end', text: longName });
    const root = container.querySelector('.cinder-text');
    expect(root?.tagName).toBe('SPAN');
    expect(root?.getAttribute('data-cinder-truncate')).toBe('end');
    expect(root?.textContent).toBe(longName);
    expect(root?.getAttribute('title')).toBe(longName);
    expect(root?.hasAttribute('tabindex')).toBe(false);
  });

  test('keeps a title the caller set', () => {
    const { container } = render(Text, { truncate: 'end', text: longName, title: 'Model' });
    expect(container.querySelector('.cinder-text')?.getAttribute('title')).toBe('Model');
  });

  test('ends the line with an ellipsis in the typography of what holds it', () => {
    expect(textCss).toMatch(
      /\.cinder-text\[data-cinder-truncate='end'\]\s*\{[^}]*font:\s*inherit;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
    );
  });
});
