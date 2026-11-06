import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, test } from 'bun:test';

import { readFirstJsonlRecord } from './cli-jsonl.test-support.ts';

function streamFrom(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

test('JSONL framing waits for complete multibyte records and rejects malformed or truncated input', async () => {
  const encoded = new TextEncoder().encode(
    '{"id":"compiled-1","event":{"kind":"task.status","status":"running","label":"😀"}}\n',
  );
  const reader = streamFrom([encoded.slice(0, -4), encoded.slice(-4)]).getReader();
  const result = await readFirstJsonlRecord(
    reader,
    (record) =>
      typeof record === 'object' &&
      record !== null &&
      JSON.stringify(record).includes('"status":"running"'),
  );
  expect(result.record).toEqual({
    id: 'compiled-1',
    event: { kind: 'task.status', status: 'running', label: '😀' },
  });

  const malformed = readFirstJsonlRecord(streamFrom(['not-json\n']).getReader(), () => true);
  expect(await rejectionOf(malformed)).toMatchObject({
    message: 'JSONL stream emitted a malformed record',
  });
  const truncated = readFirstJsonlRecord(streamFrom(['{"id":"truncated"']).getReader(), () => true);
  expect(await rejectionOf(truncated)).toMatchObject({
    message: 'JSONL stream ended before the expected record',
  });
});
