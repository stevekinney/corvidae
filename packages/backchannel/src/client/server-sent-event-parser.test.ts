import { describe, expect, it } from 'bun:test';

import { parseServerSentEventChunk } from './server-sent-event-parser.ts';

describe('parseServerSentEventChunk', () => {
  it('yields no frame for a block of only comments', () => {
    expect(parseServerSentEventChunk(': keep-alive\n\n')).toEqual({ frames: [], remainder: '' });
  });

  it('parses multiline data, comments, ids, and named events', () => {
    const parsed = parseServerSentEventChunk(
      ': ignored\nid: 7\nevent: workflow:started\ndata: first\ndata: second\n\n',
    );

    expect(parsed.frames).toEqual([
      {
        id: '7',
        event: 'workflow:started',
        data: 'first\nsecond',
      },
    ]);
    expect(parsed.remainder).toBe('');
  });

  it('carries an unfinished frame to the next chunk', () => {
    const first = parseServerSentEventChunk('id: 1\ndata: {"a":');
    expect(first.frames).toEqual([]);
    const second = parseServerSentEventChunk('1}\n\n', first.remainder);
    expect(second.frames).toEqual([{ id: '1', data: '{"a":1}' }]);
    expect(second.remainder).toBe('');
  });

  it('reads CRLF and CR line endings as newlines', () => {
    const parsed = parseServerSentEventChunk('data: a\r\n\r\ndata: b\r\r');
    expect(parsed.frames).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('preserves frames and the unfinished remainder at every chunk boundary', () => {
    function parseChunks(chunks: readonly string[]) {
      const frames = [];
      let remainder = '';
      for (const chunk of chunks) {
        const parsed = parseServerSentEventChunk(chunk, remainder);
        frames.push(...parsed.frames);
        remainder = parsed.remainder;
      }
      return { frames, remainder };
    }

    for (const ending of ['\n', '\r\n', '\r']) {
      const complete = [
        '',
        ': comment',
        'id: 7',
        'event: named',
        'data: one',
        'data: two',
        '',
        'data: another',
        '',
        '',
      ].join(ending);
      const input = complete + 'data: unfin';
      expect(parseChunks([input])).toEqual({
        frames: [{ id: '7', event: 'named', data: 'one\ntwo' }, { data: 'another' }],
        remainder: 'data: unfin',
      });
      for (const example of [complete, input, input + ending]) {
        const whole = parseChunks([example]);
        for (let offset = 0; offset <= example.length; offset += 1) {
          expect(parseChunks([example.slice(0, offset), '', example.slice(offset)])).toEqual(whole);
        }
        expect(parseChunks(example.split(''))).toEqual(whole);
      }
      expect(parseChunks([...input.split(''), 'ished' + ending + ending]).frames.at(-1)).toEqual({
        data: 'unfinished',
      });
    }
  });
});
