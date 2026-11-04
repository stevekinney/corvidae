/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { Highlighter } from '../../utilities/highlighter.ts';

setupHappyDom();

const { cleanup, render, waitFor } = await import('@testing-library/svelte');
const { default: CodeBlock } = await import('./code-block.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const fileText = [
  '{',
  '  "name": "order-refund",',
  '  "input": { "agent": "tool-runner"',
  '    "message": "Issue the approved refund." } }',
  '}',
].join('\n');

/** A Shiki-shaped highlighter: one `<span class="line">` per line, separated by newlines. */
const shikiShaped: Highlighter = (code) =>
  `<pre class="shiki"><code>${code
    .split('\n')
    .map((line) => `<span class="line">${line.replaceAll('<', '&lt;')}</span>`)
    .join('\n')}</code></pre>`;

/** A highlighter that returns one `<code>` element and no lines, as `highlightJson` does. */
const noLines: Highlighter = (code) => `<code class="cinder-json">${code}</code>`;

describe('CodeBlock — line numbers (row 62l)', () => {
  test('numbers each plain line from one, one element per line', () => {
    const { container } = render(CodeBlock, { code: fileText, lineNumbers: true });

    expect(container.querySelector('.cinder-code-block--numbered')).not.toBeNull();
    const lines = [...container.querySelectorAll('.cinder-code-block__line')];
    expect(lines).toHaveLength(5);
    expect(lines[1]?.textContent).toBe('  "name": "order-refund",');
    expect(container.querySelector('code')?.textContent).toBe(fileText.split('\n').join(''));
  });

  test('does not number a trailing newline as a line of its own', () => {
    const { container } = render(CodeBlock, { code: 'a\nb\n', lineNumbers: true });

    expect(container.querySelectorAll('.cinder-code-block__line')).toHaveLength(2);
  });

  test('sizes the gutter to the digits of the last line number', () => {
    const many = Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n');
    const { container } = render(CodeBlock, { code: many, lineNumbers: true });

    const root = container.querySelector<HTMLElement>('.cinder-code-block');
    expect(root?.style.getPropertyValue('--_cinder-code-block-digits')).toBe('3');
  });

  test('draws no gutter variable and keeps the single text node when nothing needs lines', () => {
    const { container } = render(CodeBlock, { code: fileText });

    expect(container.querySelector('.cinder-code-block__line')).toBeNull();
    expect(container.querySelector('.cinder-code-block--numbered')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(fileText);
    expect(
      container
        .querySelector<HTMLElement>('.cinder-code-block')
        ?.style.getPropertyValue('--_cinder-code-block-digits'),
    ).toBe('');
  });

  test('numbers the lines of highlighted code and leaves the copied text alone', async () => {
    const { container } = render(CodeBlock, {
      code: fileText,
      language: 'json',
      highlighter: shikiShaped,
      lineNumbers: true,
      copyable: true,
    });

    await waitFor(() =>
      expect(container.querySelector('.cinder-code-block__highlighted')).not.toBeNull(),
    );
    const lines = [
      ...container.querySelectorAll('.cinder-code-block__highlighted .cinder-code-block__line'),
    ];
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => line.classList.contains('line'))).toBe(true);
    expect(container.querySelector('.cinder-code-block--numbered')).not.toBeNull();
  });

  test('falls back to the plain, numbered rendering when the highlighter draws no line elements', async () => {
    const { container } = render(CodeBlock, {
      code: fileText,
      language: 'json',
      highlighter: noLines,
      lineNumbers: true,
    });

    await waitFor(() =>
      expect(container.querySelectorAll('.cinder-code-block__line')).toHaveLength(5),
    );
    expect(container.querySelector('.cinder-code-block__highlighted')).toBeNull();
  });
});

describe('CodeBlock — line annotations (row 62l)', () => {
  const annotations = [
    { line: 3, message: 'Missing comma at the end of this line. The parser stopped at line 4.' },
  ];

  test('tints the line and puts the note under it, plain code', () => {
    const { container } = render(CodeBlock, { code: fileText, lineNumbers: true, annotations });

    const tinted = container.querySelector('.cinder-code-block__line--danger');
    expect(tinted?.textContent).toBe('  "input": { "agent": "tool-runner"');
    const note = tinted?.nextElementSibling;
    expect(note?.classList.contains('cinder-code-block__annotation')).toBe(true);
    expect(note?.classList.contains('cinder-code-block__annotation--danger')).toBe(true);
    expect(note?.getAttribute('role')).toBe('note');
    expect(note?.textContent?.trim()).toBe(annotations[0]?.message);
    expect(note?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // The line after the note is the next line of code, untinted.
    expect(note?.nextElementSibling?.textContent).toBe(
      '    "message": "Issue the approved refund." } }',
    );
    expect(note?.nextElementSibling?.classList.contains('cinder-code-block__line--danger')).toBe(
      false,
    );
  });

  test('annotations work without line numbers', () => {
    const { container } = render(CodeBlock, { code: fileText, annotations });

    expect(container.querySelector('.cinder-code-block--numbered')).toBeNull();
    expect(container.querySelectorAll('.cinder-code-block__annotation')).toHaveLength(1);
  });

  test('tones choose the tint, and a line past the end is ignored', () => {
    const { container } = render(CodeBlock, {
      code: fileText,
      annotations: [
        { line: 1, message: 'Heads up.', tone: 'warning' },
        { line: 2, message: 'For your information.', tone: 'info' },
        { line: 99, message: 'Nowhere.' },
      ],
    });

    expect(container.querySelector('.cinder-code-block__line--warning')).not.toBeNull();
    expect(container.querySelector('.cinder-code-block__line--info')).not.toBeNull();
    expect(container.querySelectorAll('.cinder-code-block__annotation')).toHaveLength(2);
  });

  test('keeps two notes for one line in the order given', () => {
    const { container } = render(CodeBlock, {
      code: fileText,
      annotations: [
        { line: 2, message: 'First.' },
        { line: 2, message: 'Second.' },
      ],
    });

    expect(
      [...container.querySelectorAll('.cinder-code-block__annotation')].map((note) =>
        note.textContent?.trim(),
      ),
    ).toEqual(['First.', 'Second.']);
  });

  test('decorates highlighted code the same way, and removes its notes when they change', async () => {
    const view = render(CodeBlock, {
      code: fileText,
      language: 'json',
      highlighter: shikiShaped,
      lineNumbers: true,
      annotations,
    });
    const { container } = view;

    await waitFor(() =>
      expect(
        container.querySelector('.cinder-code-block__highlighted .cinder-code-block__annotation'),
      ).not.toBeNull(),
    );
    const tinted = container.querySelector(
      '.cinder-code-block__highlighted .cinder-code-block__line--danger',
    );
    expect(tinted?.textContent).toBe('  "input": { "agent": "tool-runner"');
    expect(tinted?.nextElementSibling?.textContent?.trim()).toBe(annotations[0]?.message);

    await view.rerender({
      code: fileText,
      language: 'json',
      highlighter: shikiShaped,
      lineNumbers: true,
      annotations: [],
    });

    await waitFor(() =>
      expect(container.querySelectorAll('.cinder-code-block__annotation').length).toBe(0),
    );
    expect(container.querySelector('.cinder-code-block__line--danger')).toBeNull();
  });
});

describe('CodeBlock — wrapping and scrolling (row 05l)', () => {
  test('scrolls inside its own box by default and wraps only when asked', () => {
    const plain = render(CodeBlock, { code: fileText });
    expect(plain.container.querySelector('.cinder-code-block--wrap')).toBeNull();
    cleanup();

    const wrapped = render(CodeBlock, { code: fileText, wrap: true });
    expect(wrapped.container.querySelector('.cinder-code-block--wrap')).not.toBeNull();
  });

  test('the stylesheet paints the scrollbar, numbers the lines without copying them, and tints rows', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();

    expect(css).toMatch(
      /@supports not selector\(::-webkit-scrollbar\)\s*\{\s*\.cinder-code-block__viewport\s*\{[^}]*scrollbar-color:\s*var\(--cinder-scrollbar-thumb\)\s+var\(--cinder-scrollbar-track\)/s,
    );
    expect(css).toMatch(
      /\.cinder-code-block__viewport::-webkit-scrollbar\s*\{[^}]*inline-size:\s*var\(--cinder-scrollbar-size\)/s,
    );
    expect(css).toContain('.cinder-code-block__viewport::-webkit-scrollbar-thumb');
    expect(css).toContain("content: counter(cinder-code-line) / ''");
    expect(css).toMatch(/\.cinder-code-block__line--danger\s*\{[^}]*status-danger-background/s);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('CodeBlock — numeric tokens (row 07s)', () => {
  const key = '<span style="color:#005CC5;--shiki-dark:#79B8FF">';
  const tokens = (value: string): string =>
    `<pre class="shiki"><code><span class="line">${key}"total"</span>: ${key}${value}</span></span></code></pre>`;

  test('marks a token that holds only a number, and leaves a key, a string and a word alone', async () => {
    const highlighter: Highlighter = () =>
      `<pre class="shiki"><code><span class="line">${key}"total"</span>${key}42.0</span>${key}-1e3</span>${key}true</span>${key}"42"</span>${key}v2</span></span></code></pre>`;
    const { container } = render(CodeBlock, { code: 'x', language: 'json', highlighter });

    await waitFor(() => expect(container.querySelector('pre.shiki')).not.toBeNull());
    const marked = [...container.querySelectorAll('.cinder-code-block__number')].map(
      (token) => token.textContent,
    );
    expect(marked).toEqual(['42.0', '-1e3']);
  });

  test('marks a number whatever the line features are', async () => {
    const { container } = render(CodeBlock, {
      code: 'x',
      language: 'json',
      highlighter: () => tokens('7'),
      lineNumbers: true,
    });

    await waitFor(() =>
      expect(container.querySelector('.cinder-code-block__number')).not.toBeNull(),
    );
    expect(container.querySelector('.cinder-code-block__number')?.textContent).toBe('7');
  });

  test('the stylesheet lifts a marked number from the key blue to the warning fill in dark', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();

    expect(css).toMatch(
      /span\.cinder-code-block__number\[style\*='--shiki-dark:#79b8ff' i\]\s*\{\s*--shiki-dark:\s*var\(--cinder-status-warning-solid\)\s*!important;/,
    );
  });
});
