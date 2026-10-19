/**
 * COR-1490 — session input delivered to a run reaches the client that started it. The input is not
 * an event of its own (the run took it into the conversation at a step boundary), so a run that
 * delivered one ends with the thread as a `MESSAGES_SNAPSHOT`: the row the client holds for the
 * input, under the id it was sent with, is named, and the thread is in the order the run took it.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import {
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { FrameReader, typesOf } from './ag-ui-stream.test-support.ts';

async function withHarness<T>(
  options: Parameters<typeof openHarness>[0],
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await openHarness(options);
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

describe('a run that delivered session input', () => {
  it('ends with the thread as a snapshot that names the input, in the order the run took it', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('First.'), say('Answer.')] },
      async ({ handler, bureau, generate }) => {
        const stream = new FrameReader(await handler(startRequest(runAgentInput())));
        await stream.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const admitted = await bureau.submitSessionInput('thread-1', {
          id: 'follow-up-1',
          principal: 'anonymous:local',
          deliveryMode: 'steer',
          payload: 'One more thing',
        });
        expect(admitted.outcome).toBe('admitted');
        generate.release('hold');
        await stream.rest();

        const types = typesOf(stream.received);
        const snapshot = stream.received
          .map((frame) => frame.event)
          .findLast((event) => event.type === EventType.MESSAGES_SNAPSHOT);
        expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
        expect(types.at(-2)).toBe(EventType.MESSAGES_SNAPSHOT);
        expect(
          snapshot?.type === EventType.MESSAGES_SNAPSHOT
            ? snapshot.messages.map((message) => [message.id === 'follow-up-1', message.role])
            : [],
        ).toEqual([
          [false, 'user'],
          [false, 'assistant'],
          [true, 'user'],
          [false, 'assistant'],
        ]);
      },
    );
  });

  it('is not the case for a run that took none: its stream carries no snapshot', async () => {
    await withHarness({ script: [say('Done.')] }, async ({ handler, bureau }) => {
      const stream = new FrameReader(await handler(startRequest(runAgentInput())));
      await stream.rest();
      await waitForCondition(() => bureau.listRuns()[0]?.status === 'completed', 'the run ended');

      expect(typesOf(stream.received)).not.toContain(EventType.MESSAGES_SNAPSHOT);
    });
  });
});
