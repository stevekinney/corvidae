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
});
