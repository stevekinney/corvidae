import { describe, expect, test } from 'bun:test';

import { readServerSentEventStream } from './sse-reader.ts';

function streamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

describe('readServerSentEventStream', () => {
  test('delivers the same multiline event when a network chunk ends on CR', async () => {
    const chunks = [
      'id: 5\r\nevent: workflow:completed\r\ndata: first\r',
      '\ndata: second\r\n\r\n',
    ];
    const split = await Array.fromAsync(readServerSentEventStream(streamResponse(chunks)));
    const whole = await Array.fromAsync(
      readServerSentEventStream(streamResponse([chunks.join('')])),
    );
    expect(split).toEqual(whole);
    expect(whole).toEqual([{ id: '5', event: 'workflow:completed', data: 'first\nsecond' }]);
  });

  test('yields frames split arbitrarily across chunk boundaries', async () => {
    const response = streamResponse(['event: a\ndata: 1\n\nev', 'ent: b\ndata: 2\n\n']);
    const frames = [];
    for await (const frame of readServerSentEventStream(response)) frames.push(frame);
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  test('stops immediately when the body is null', async () => {
    const response = new Response(null);
    const frames = [];
    for await (const frame of readServerSentEventStream(response)) frames.push(frame);
    expect(frames).toEqual([]);
  });

  test('stops when the signal is already aborted', async () => {
    const response = streamResponse(['data: never-seen\n\n']);
    const controller = new AbortController();
    controller.abort();
    const frames = [];
    for await (const frame of readServerSentEventStream(response, controller.signal)) {
      frames.push(frame);
    }
    expect(frames).toEqual([]);
  });

  test('stops mid-stream once the signal aborts, without reading further frames', async () => {
    const response = streamResponse(['data: one\n\ndata: two\n\ndata: three\n\n']);
    const controller = new AbortController();
    const frames = [];
    for await (const frame of readServerSentEventStream(response, controller.signal)) {
      frames.push(frame);
      if (frame.data === 'one') controller.abort();
    }
    expect(frames).toEqual([{ data: 'one' }]);
  });
});
