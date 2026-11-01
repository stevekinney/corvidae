/** The inline Markdown of a title: three marks, drawn as runs, and nothing else. */
import { describe, expect, test } from 'bun:test';

import { inlineRuns } from './inline-markdown.ts';

describe('inlineRuns', () => {
  test('has no run for an empty title and one text run for a plain one', () => {
    expect(inlineRuns('')).toEqual([]);
    expect(inlineRuns('Plan the week')).toEqual([{ kind: 'text', text: 'Plan the week' }]);
  });

  test('reads code, bold and emphasis in order, keeping the text between them', () => {
    expect(inlineRuns('a **b** c *d* e `f` g _h_')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' c ' },
      { kind: 'emphasis', text: 'd' },
      { kind: 'text', text: ' e ' },
      { kind: 'code', text: 'f' },
      { kind: 'text', text: ' g ' },
      { kind: 'emphasis', text: 'h' },
    ]);
  });

  test('leaves a mark that never closes, and underscores inside a word, as typed', () => {
    expect(inlineRuns('2 * 3 and **open')).toEqual([{ kind: 'text', text: '2 * 3 and **open' }]);
    expect(inlineRuns('snake_case_name')).toEqual([{ kind: 'text', text: 'snake_case_name' }]);
  });

  test('does not read a link, an image or markup as anything but text', () => {
    const source = '[a](https://example.com) ![b](c) <script>x</script>';
    expect(inlineRuns(source)).toEqual([{ kind: 'text', text: source }]);
  });
});
