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

  test('draws markup it was given as the characters it was typed as', () => {
    const { container } = render(InlineMarkdown, {
      props: { text: '<img src=x onerror=alert(1)> [a](b)' },
    } as never);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror=alert(1)> [a](b)');
  });
});
