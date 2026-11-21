/// <reference lib="dom" />
/**
 * Where a wrapping CodeBlock may break (COR-2548). A browser offers no break after a slash or a
 * colon, so a URL wider than the line was cut wherever the line ended (`…/bureau/m` and `cp`). A
 * wrapping block puts a `<wbr>` after each slash, dot, colon and hyphen that ends a part, in plain
 * code and in highlighted code, and adds no character to what is shown and copied.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { Highlighter } from '../../utilities/highlighter.ts';
import { breakPoints, splitWords } from './code-block-lines.ts';

setupHappyDom();

const { cleanup, render, waitFor } = await import('@testing-library/svelte');
const { default: CodeBlock } = await import('./code-block.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const ENDPOINT = 'http://127.0.0.1:7405/bureau/mcp';

/** A Shiki-shaped highlighter: one `<span class="line">` per line, each token its own span. */
const shikiShaped: Highlighter = (code) =>
  `<pre class="shiki"><code>${code
    .split('\n')
    .map(
      (line) =>
        `<span class="line">${line
          .split(/(?<= )/)
          .map((token) => `<span style="color:#032f62">${token.replaceAll('<', '&lt;')}</span>`)
          .join('')}</span>`,
    )
    .join('\n')}</code></pre>`;

describe('breakPoints', () => {
  test('cuts a URL after its runs of punctuation, and joins back to the URL', () => {
    expect(breakPoints(ENDPOINT)).toEqual([
      'http://',
      '127.',
      '0.',
      '0.',
      '1:',
      '7405/',
      'bureau/',
      'mcp',
    ]);
    expect(breakPoints(ENDPOINT).join('')).toBe(ENDPOINT);
  });

  test('never cuts inside a word, whatever the text is', () => {
    for (const text of ['bureau', 'interborough', '7405', 'mcpServers', 'a', '']) {
      expect(breakPoints(text)).toEqual([text]);
    }
  });

  test('keeps a leading dot, an ellipsis, a minus sign and a flag with what follows', () => {
    expect(breakPoints('/.well-known/agent-card.json')).toEqual([
      '/.well-',
      'known/',
      'agent-',
      'card.',
      'json',
    ]);
    expect(breakPoints('wait...')).toEqual(['wait...']);
    expect(breakPoints('x -1 --notify')).toEqual(['x -1 --notify']);
  });

  test('breaks after a quote only where it closes a word', () => {
    expect(breakPoints('"url": "http://a/b"')).toEqual(['"url": "http://', 'a/', 'b"']);
  });

  test('adds and drops no character, for any text', () => {
    for (const text of [
      '"url": "http://127.0.0.1:7405/bureau/mcp",',
      'claude mcp add --transport http interborough http://x.test/a-b/c',
      '  ../a//b::c--d..e  ',
      'tab\tand.dot ./ and /',
    ]) {
      expect(breakPoints(text).join('')).toBe(text);
    }
  });
});

describe('splitWords', () => {
  test('boxes a word that has places to break and leaves the rest, joining back to the text', () => {
    // A dot that ends a word is no place to break: nothing follows it to move to the next row.
    const text = `claude  mcp add ${ENDPOINT}\tdone.`;
    const runs = splitWords(text);
    expect(runs.map((run) => run.text).join('')).toBe(text);
    expect(runs.filter((run) => run.pieces.length > 1).map((run) => run.text)).toEqual([ENDPOINT]);
    // Whitespace is a run of its own and never a place inside a word.
    expect(runs.filter((run) => /^\s+$/.test(run.text)).map((run) => run.text)).toEqual([
      '  ',
      ' ',
      ' ',
      '\t',
    ]);
  });
});

describe('CodeBlock — break opportunities in a wrapping block', () => {
  const command = `claude mcp add --transport http interborough ${ENDPOINT}`;

  test('plain code gets a <wbr> after each part of the URL and keeps its text', () => {
    const { container } = render(CodeBlock, { code: command, wrap: true });
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe(command);
    expect(code?.querySelectorAll('wbr')).toHaveLength(breakPoints(ENDPOINT).length - 1);
    // A flag is one box, with no break opportunity inside it.
    expect(code?.querySelector('.cinder-code-block__flag wbr')).toBeNull();
    expect(code?.querySelector('.cinder-code-block__flag')?.textContent).toBe('--transport');
    // The URL is one box that moves to the next row whole when it fits one; the other words, which
    // have nowhere to break, are plain text.
    const words = [...(code?.querySelectorAll('.cinder-code-block__word') ?? [])];
    expect(words.map((word) => word.textContent)).toEqual([ENDPOINT]);
    expect(words[0]?.querySelectorAll('wbr')).toHaveLength(breakPoints(ENDPOINT).length - 1);
  });

  test('plain code that does not wrap has no break opportunity', () => {
    const { container } = render(CodeBlock, { code: command });
    expect(container.querySelector('wbr')).toBeNull();
  });

  test('a streaming wrapping block keeps its caret last and its text as written', () => {
    const { container } = render(CodeBlock, { code: command, wrap: true, streaming: true });
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe(command);
    expect(code?.lastElementChild?.className).toContain('cinder-code-block__caret');
  });

  test('highlighted code gets a <wbr> in each token, and its text is unchanged', async () => {
    const code = `{\n  "url": "${ENDPOINT}"\n}`;
    const { container } = render(CodeBlock, {
      code,
      language: 'json',
      wrap: true,
      highlighter: shikiShaped,
    });
    await waitFor(() =>
      expect(container.querySelector('.cinder-code-block__highlighted')).not.toBeNull(),
    );
    await waitFor(() =>
      expect(container.querySelector('.cinder-code-block__highlighted wbr')).not.toBeNull(),
    );
    const highlighted = container.querySelector('.cinder-code-block__highlighted');
    expect(highlighted?.querySelectorAll('wbr')).toHaveLength(breakPoints(ENDPOINT).length - 1);
    expect(highlighted?.textContent).toBe(code);
    // The token holding the URL still holds the whole URL, with the break opportunities inside it.
    const token = [...(highlighted?.querySelectorAll('span[style^="color"]') ?? [])].find(
      (candidate) => candidate.textContent?.includes('bureau'),
    );
    expect(token?.textContent).toBe(`"${ENDPOINT}"`);
    expect(token?.querySelector('.cinder-code-block__word')?.textContent).toBe(`"${ENDPOINT}"`);
  });

  test('highlighted code of a block that does not wrap has no break opportunity', async () => {
    const { container } = render(CodeBlock, {
      code: ENDPOINT,
      language: 'json',
      highlighter: shikiShaped,
    });
    await waitFor(() =>
      expect(container.querySelector('.cinder-code-block__highlighted')).not.toBeNull(),
    );
    expect(container.querySelector('wbr')).toBeNull();
  });

  test('a note under a line keeps its words whole', async () => {
    const { container } = render(CodeBlock, {
      code: 'a/b/c',
      wrap: true,
      annotations: [{ line: 1, message: 'See https://example.test/a/b for this.', tone: 'info' }],
    });
    expect(container.querySelector('small wbr')).toBeNull();
  });
});
