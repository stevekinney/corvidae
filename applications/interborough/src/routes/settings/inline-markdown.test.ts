import { describe, expect, test } from 'bun:test';

import { inlineSegments } from './inline-markdown.ts';

describe('inline Markdown', () => {
  test('is one plain run when there is no code', () => {
    expect(inlineSegments('How long records are kept.')).toEqual([
      { kind: 'text', text: 'How long records are kept.' },
    ]);
    expect(inlineSegments('')).toEqual([]);
  });

  test('sets code spans apart from the text around them, without the backticks', () => {
    expect(inlineSegments('Whether tasks are offered `scheduleWakeup`, or `forever`.')).toEqual([
      { kind: 'text', text: 'Whether tasks are offered ' },
      { kind: 'code', text: 'scheduleWakeup' },
      { kind: 'text', text: ', or ' },
      { kind: 'code', text: 'forever' },
      { kind: 'text', text: '.' },
    ]);
  });

  test('keeps a backtick that is never closed as text, and drops an empty span', () => {
    expect(inlineSegments('a `b')).toEqual([{ kind: 'text', text: 'a `b' }]);
    expect(inlineSegments('a `` b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'text', text: ' b' },
    ]);
  });
});
