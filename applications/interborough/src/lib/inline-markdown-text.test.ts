/** The line of text that draws its inline Markdown as elements. */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import InlineMarkdown from './inline-markdown.svelte';

afterEach(cleanup);

describe('InlineMarkdown', () => {
  test('draws each mark as its element and keeps the text between them', () => {
    const { container } = render(InlineMarkdown, {
      props: { text: 'Plan **the week** and *then* `run`, plainly' },
    } as never);

    expect(container.querySelector('strong')?.textContent).toBe('the week');
    expect(container.querySelector('em')?.textContent).toBe('then');
    expect(container.querySelector('code')?.textContent).toBe('run');
    expect(container.textContent).toBe('Plan the week and then run, plainly');
  });

  test('keeps an empty code span, a mark that never closes and a word-internal underscore as typed', () => {
    for (const text of ['a `` b', '2 * 3 and **open', 'snake_case_name', 'a `b']) {
      const { container } = render(InlineMarkdown, { props: { text } } as never);
      expect(container.querySelector('strong, em, code')).toBeNull();
      expect(container.textContent).toBe(text);
      cleanup();
    }
  });

  test('draws bold and emphasis written with underscores at word boundaries', () => {
    const { container } = render(InlineMarkdown, {
      props: { text: 'a __b c__ and _d_ in `**e**`' },
    } as never);

    expect(container.querySelector('strong')?.textContent).toBe('b c');
    expect(container.querySelector('em')?.textContent).toBe('d');
    expect(container.querySelector('code')?.textContent).toBe('**e**');
    expect(container.textContent).toBe('a b c and d in **e**');
  });

  test('draws markup it was given as the characters it was typed as', () => {
    const { container } = render(InlineMarkdown, {
      props: { text: '<img src=x onerror=alert(1)> [a](b)' },
    } as never);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror=alert(1)> [a](b)');
  });
});
