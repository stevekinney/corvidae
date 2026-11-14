/**
 * COR-2285 — an archived chat takes no new turn, through either door that starts one: an AG-UI
 * start is refused with `THREAD_ARCHIVED` for the owner (another principal is told no more than a
 * missing thread says), and `startIdleTurn`, Interborough's `POST /api/chats/{chat}/messages`, is
 * refused with a `ContextArchivedError`. Nothing is stored, and the chat takes turns again once it
 * is unarchived.
 */
import { EventType } from '@ag-ui/core';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { ContextArchivedError } from '../bureau-errors.ts';
import { waitForTaskState } from '../test';
import {
  as,
  authentication,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { startIdleTurn } from './ag-ui-thread-admission.ts';
import { readAgUiStream } from './ag-ui-stream.test-support.ts';

const THREAD = 'thread-1';

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

const firstMessage = { id: 'user-1', role: 'user' as const, content: 'hello' };
const secondMessage = { id: 'user-2', role: 'user' as const, content: 'one more thing' };

async function starts(
  harness: Pick<Harness, 'handler'>,
  runId: string,
  messages: ReadonlyArray<typeof firstMessage>,
  key = 'alice-key',
) {
  return readAgUiStream(
    await harness.handler(
      startRequest(runAgentInput({ threadId: THREAD, runId, messages: [...messages] }), as(key)),
    ),
  );
}

function expectRefusal(frames: Awaited<ReturnType<typeof starts>>, code: string) {
  expect(frames).toHaveLength(1);
  expect(frames[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code });
}

describe('a start on an archived chat', () => {
  it('is refused with THREAD_ARCHIVED and stores nothing, and goes through once unarchived', async () => {
    await withHarness(
      { script: [say('First.'), say('Second.')], authentication },
      async (harness) => {
        const first = await starts(harness, 'run-1', [firstMessage]);
        expect(first.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
        expect(await harness.bureau.contexts.archive(THREAD)).toMatchObject({ changed: true });
        const before = await harness.bureau.contexts.get(THREAD);

        const refused = await starts(harness, 'run-2', [firstMessage, secondMessage]);

        expectRefusal(refused, 'THREAD_ARCHIVED');
        expect(refused[0]!.event).toMatchObject({ message: `Thread "${THREAD}" is archived` });
        const after = await harness.bureau.contexts.get(THREAD);
        expect(after?.revision).toBe(before?.revision);
        expect(after?.conversationHistory.ids).toEqual(before?.conversationHistory.ids);

        await harness.bureau.contexts.unarchive(THREAD);
        const resumed = await starts(harness, 'run-2', [firstMessage, secondMessage]);
        expect(resumed.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
      },
    );
  });

  it('still attaches a retried start to the run it started before the archive', async () => {
    await withHarness({ script: [say('First.')], authentication }, async (harness) => {
      await starts(harness, 'run-1', [firstMessage]);
      await harness.bureau.contexts.archive(THREAD);

      const retried = await starts(harness, 'run-1', [firstMessage]);

      expect(retried.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
    });
  });

  it('is answered THREAD_NOT_FOUND for another owner, which learns nothing', async () => {
    await withHarness({ script: [say('First.')], authentication }, async (harness) => {
      await starts(harness, 'run-1', [firstMessage]);
      await harness.bureau.contexts.archive(THREAD);

      expectRefusal(
        await starts(harness, 'run-bob', [firstMessage, secondMessage], 'bob-key'),
        'THREAD_NOT_FOUND',
      );
    });
  });
});

describe('a message to an archived chat through another door', () => {
  it('is refused with a ContextArchivedError, and starts no run', async () => {
    await withHarness(
      { script: [say('First.'), say('Second.')], authentication },
      async (harness) => {
        await starts(harness, 'run-1', [firstMessage]);
        await harness.bureau.contexts.archive(THREAD);
        const before = await harness.bureau.contexts.get(THREAD);

        const refusal = await rejectionOf(
          startIdleTurn(harness.bureau, {
            threadId: THREAD,
            input: 'Refund the shipping too.',
            principal: 'api-key:alice',
          }),
        );

        expect(refusal).toBeInstanceOf(ContextArchivedError);
        expect((await harness.bureau.contexts.get(THREAD))?.revision).toBe(before?.revision);

        await harness.bureau.contexts.unarchive(THREAD);
        const second = await startIdleTurn(harness.bureau, {
          threadId: THREAD,
          input: 'Refund the shipping too.',
          principal: 'api-key:alice',
        });
        await waitForTaskState(harness.bureau, second.id);
      },
    );
  });
});
