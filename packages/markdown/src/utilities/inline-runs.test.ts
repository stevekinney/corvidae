/**
 * The inline-runs tokenizer, under each of its profiles. The expectations of both profiles were
 * captured from the two tokenizers it replaced (a chat title's and a setting description's), and
 * a 300,000-input comparison of old against new agreed before they were deleted.
 */
import { describe, expect, test } from 'bun:test';

import {
  DESCRIPTION_INLINE_RUNS_PROFILE,
  inlineRuns,
  TITLE_INLINE_RUNS_PROFILE,
} from './inline-runs.ts';

const title = (source: string) => inlineRuns(source, TITLE_INLINE_RUNS_PROFILE);
const description = (source: string) => inlineRuns(source, DESCRIPTION_INLINE_RUNS_PROFILE);

describe('the title profile: code, strong and emphasis', () => {
  test('has no run for an empty title and one text run for a plain one', () => {
    expect(title('')).toEqual([]);
    expect(title('Plan the week')).toEqual([{ kind: 'text', text: 'Plan the week' }]);
  });

  test('reads code, bold and emphasis in order, keeping the text between them', () => {
    expect(title('a **b** c *d* e `f` g _h_')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' c ' },
      { kind: 'emphasis', text: 'd' },
      { kind: 'text', text: ' e ' },
      { kind: 'code', text: 'f' },
      { kind: 'text', text: ' g ' },
      { kind: 'emphasis', text: 'h' },
    ]);
    expect(title('__b__ and __c d__')).toEqual([
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' and ' },
      { kind: 'strong', text: 'c d' },
    ]);
  });

  test('leaves a mark that never closes, and underscores inside a word, as typed', () => {
    expect(title('2 * 3 and **open')).toEqual([{ kind: 'text', text: '2 * 3 and **open' }]);
    expect(title('snake_case_name')).toEqual([{ kind: 'text', text: 'snake_case_name' }]);
    expect(title('a `b')).toEqual([{ kind: 'text', text: 'a `b' }]);
    expect(title('** b**')).toEqual([{ kind: 'text', text: '** b**' }]);
  });

  test('keeps an empty code span as typed, and lets a span start at its second backtick', () => {
    expect(title('a `` b')).toEqual([{ kind: 'text', text: 'a `` b' }]);
    expect(title('``')).toEqual([{ kind: 'text', text: '``' }]);
    // A span needs a character inside it, so the first backtick of `` finds no partner and the
    // second one pairs with the next backtick, as the title tokenizer always read it.
    expect(title('a `` `b` c')).toEqual([
      { kind: 'text', text: 'a `' },
      { kind: 'code', text: ' ' },
      { kind: 'text', text: 'b` c' },
    ]);
  });

  test('does not read a link, an image or markup as anything but text', () => {
    const source = '[a](https://example.com) ![b](c) <script>x</script>';
    expect(title(source)).toEqual([{ kind: 'text', text: source }]);
  });

  test('keeps text in a code span exactly, marks and all', () => {
    expect(title('`**not bold**` and `a b`')).toEqual([
      { kind: 'code', text: '**not bold**' },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'a b' },
    ]);
  });
});

describe('the description profile: code only', () => {
  test('is one plain run when there is no code, and none when it is empty', () => {
    expect(description('How long records are kept.')).toEqual([
      { kind: 'text', text: 'How long records are kept.' },
    ]);
    expect(description('')).toEqual([]);
  });

  test('sets code spans apart from the text around them, without the backticks', () => {
    expect(description('Whether tasks are offered `scheduleWakeup`, or `forever`.')).toEqual([
      { kind: 'text', text: 'Whether tasks are offered ' },
      { kind: 'code', text: 'scheduleWakeup' },
      { kind: 'text', text: ', or ' },
      { kind: 'code', text: 'forever' },
      { kind: 'text', text: '.' },
    ]);
  });

  test('keeps a backtick that is never closed as text, and drops an empty span', () => {
    expect(description('a `b')).toEqual([{ kind: 'text', text: 'a `b' }]);
    expect(description('a `` b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'text', text: ' b' },
    ]);
    expect(description('``')).toEqual([]);
    expect(description('a `` `b` c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'b' },
      { kind: 'text', text: ' c' },
    ]);
  });

  test('leaves bold, emphasis and every other mark as typed', () => {
    const source = '**not bold** *nor this* _nor_ __this__ [a](b) <b>x</b> `code`';
    expect(description(source)).toEqual([
      { kind: 'text', text: '**not bold** *nor this* _nor_ __this__ [a](b) <b>x</b> ' },
      { kind: 'code', text: 'code' },
    ]);
  });
});

describe('a profile of its own', () => {
  test('reads only the marks it enables', () => {
    const strongOnly = { ...TITLE_INLINE_RUNS_PROFILE, code: false, emphasis: false };
    expect(inlineRuns('**a** *b* `c`', strongOnly)).toEqual([
      { kind: 'strong', text: 'a' },
      { kind: 'text', text: ' *b* `c`' },
    ]);
    const nothing = { ...strongOnly, strong: false };
    expect(inlineRuns('**a** *b* `c`', nothing)).toEqual([{ kind: 'text', text: '**a** *b* `c`' }]);
    expect(inlineRuns('', nothing)).toEqual([]);
  });
});
