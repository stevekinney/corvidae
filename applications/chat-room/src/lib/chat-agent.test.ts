import { describe, expect, test } from 'bun:test';
import type { StreamingGenerateFunction } from './chat-agent-test-helpers';
import { legacyFrames, ofType, runAndCollect } from './chat-agent-test-helpers';

const helloThereGenerate: StreamingGenerateFunction = async ({ streaming }) => {
  streaming.update('Hello ');
  streaming.update('Hello there!');
  return { content: 'Hello there!', toolCalls: [] };
};

const doneGenerate: StreamingGenerateFunction = async ({ streaming }) => {
  streaming.update('done');
  return {
    content: 'done',
    toolCalls: [],
    usage: { prompt: 3, completion: 1, total: 4 },
  };
};

describe('pumpChatRun: completed success', () => {
  test('streams text deltas and resolves ok:true with the final content', async () => {
    // `streaming.update(text)` takes the FULL accumulated text so far, not a
    // delta — `withEnhancedStreaming` diffs each call against the previous one
    // internally to compute the `stream:text-delta` event's `content` field
    // (see `node_modules/@corvidae/operative/dist/streaming-*.js`). So the
    // second call below is the whole string again, and the SECOND `text` frame
    // this test asserts is only the new suffix ("there!"), not a repeat of the
    // first.
    const { frames, envelope } = await runAndCollect(helloThereGenerate);

    expect(legacyFrames(frames)).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there!' },
    ]);
    expect(envelope).toEqual({ ok: true, status: 'completed', content: 'Hello there!' });
  });

  test('mirrors every text delta as a typed stream:text-delta frame with the accumulated text', async () => {
    const { frames } = await runAndCollect(helloThereGenerate);

    expect(
      ofType(frames, 'stream:text-delta').map(({ content, accumulated }) => ({
        content,
        accumulated,
      })),
    ).toEqual([
      { content: 'Hello ', accumulated: 'Hello ' },
      { content: 'there!', accumulated: 'Hello there!' },
    ]);
    // The legacy `text` frame is written first so a client that renders only
    // the legacy vocabulary sees the delta at the earliest sequence number.
    const firstText = frames.findIndex((frame) => frame.type === 'text');
    const firstDelta = frames.findIndex((frame) => frame.type === 'stream:text-delta');
    expect(firstText).toBeLessThan(firstDelta);
    // Block lifecycle and completion events ride along, field for field.
    expect(ofType(frames, 'stream:block-start')).toHaveLength(1);
    expect(ofType(frames, 'stream:block-complete')).toHaveLength(1);
    expect(ofType(frames, 'stream:complete')[0]?.state.textContent).toBe('Hello there!');
  });

  test('closes with exactly one run.completed frame carrying the final conversation', async () => {
    const { frames } = await runAndCollect(doneGenerate);

    const completed = ofType(frames, 'run.completed');
    expect(completed).toHaveLength(1);
    const [frame] = completed;
    expect(frame?.content).toBe('done');
    expect(frame?.finishReason).toBe('stop-condition');
    expect(frame?.usage).toEqual({ prompt: 3, completion: 1, total: 4 });
    // The conversation is the plain `ConversationHistory` snapshot, not the
    // `Conversation` class instance Operative hands back, and it already
    // contains the assistant reply.
    const history = frame?.conversation;
    expect(history?.ids).toHaveLength(2);
    const lastId = history?.ids.at(-1) ?? '';
    expect(history?.messages[lastId]?.role).toBe('assistant');
  });
});
