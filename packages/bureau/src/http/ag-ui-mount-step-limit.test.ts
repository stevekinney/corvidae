/**
 * COR-1627 — a run that stops at its step limit is a failure, so its AG-UI stream ends with
 * `RUN_ERROR` (code `MAXIMUM_STEPS`) and never with a success. The answer an `onMaximumSteps`
 * handler leaves still streams first, as its own row. A peer that follows the run ends the same
 * way, whether it reads the end from the run's history or from the workflow's status. Every wait
 * is on a condition or a frame, never a delay.
 */
import { EventType } from '@ag-ui/core';
import { AgentRunError } from '@lostgradient/operative';
import { describe, expect, it, spyOn } from 'bun:test';

import {
  attachRunRequest,
  attachThreadRequest,
  type Harness,
  type HarnessOptions,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { bureauMetadata, FrameReader, typesOf } from './ag-ui-stream.test-support.ts';

const THREAD = 't';
const MESSAGE = 'Agent run exceeded maximumSteps (2).';

const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});
const hold = (barrier: string) => ({ kind: 'block' as const, barrier });

/** A run that never stops on its own, so it ends at its second step. */
const STEP_LIMIT: Pick<HarnessOptions, 'stopWhen' | 'maximumSteps'> = {
  stopWhen: () => false,
  maximumSteps: 2,
};

/**
 * Runs `body` over a harness on SQLite with a short claim renewal interval. A run that another
 * Bureau settles makes its holder's engine lose its claim, which Weft reports as a process
 * warning; that is part of the scenario, so it is captured, and any other warning fails the test.
 */
async function withPeers<T>(
  options: Omit<HarnessOptions, 'storage'>,
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const warnings: unknown[] = [];
  const emitWarning = spyOn(process, 'emitWarning').mockImplementation((warning) => {
    warnings.push(warning);
  });
  let result: T;
  try {
    const harness = await openHarness({
      storage: 'sqlite',
      durableOwnership: OWNERSHIP,
      ...options,
    });
    try {
      result = await body(harness);
    } finally {
      await harness.dispose();
    }
  } finally {
    emitWarning.mockRestore();
  }
  for (const warning of warnings) {
    expect((warning as Error).name).toBe('WeftWorkflowClaimLostWarning');
  }
  return result;
}

/** Starts a run on `THREAD` through `handler`, and reads its stream to its first frame. */
async function startOn(
  handler: Harness['handler'],
): Promise<{ readonly reader: FrameReader; readonly nativeRunId: string }> {
  const reader = new FrameReader(
    await handler(
      startRequest(
        runAgentInput({
          threadId: THREAD,
          runId: 'client-run-1',
          messages: [{ id: 'user-1', role: 'user', content: 'hello' }],
        }),
      ),
    ),
  );
  const first = await reader.next();
  return { reader, nativeRunId: String(bureauMetadata(first!.event)['runId']) };
}

describe('the stream of a run that stops at its step limit', () => {
  it('ends with RUN_ERROR, code MAXIMUM_STEPS, and never RUN_FINISHED', async () => {
    await withPeers({ ...STEP_LIMIT, script: [say('one'), say('two')] }, async (harness) => {
      const started = await startOn(harness.handler);
      const rest = await started.reader.rest();
      const frames = [...started.reader.received];

      expect(typesOf(frames)).not.toContain(EventType.RUN_FINISHED);
      expect(typesOf(rest).at(-1)).toBe(EventType.RUN_ERROR);
      expect(frames.at(-1)!.event).toMatchObject({
        type: EventType.RUN_ERROR,
        code: 'MAXIMUM_STEPS',
        message: MESSAGE,
      });
      expect(harness.bureau.listRuns()[0]!.status).toBe('error');
    });
  });

  it('streams the onMaximumSteps answer as its own row before RUN_ERROR', async () => {
    await withPeers(
      {
        ...STEP_LIMIT,
        script: [say('one'), say('two')],
        onMaximumSteps: async () => 'Out of steps.',
      },
      async (harness) => {
        const started = await startOn(harness.handler);
        await started.reader.rest();
        const frames = started.reader.received;

        const tail = frames.slice(-4).map((frame) => frame.event);
        expect(tail.map((event) => event.type)).toEqual([
          EventType.TEXT_MESSAGE_START,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_END,
          EventType.RUN_ERROR,
        ]);
        expect(tail[1]).toMatchObject({
          messageId: `${started.nativeRunId}:step:2`,
          delta: 'Out of steps.',
        });
        expect(tail[3]).toMatchObject({ code: 'MAXIMUM_STEPS', message: MESSAGE });
      },
    );
  });

  it('ends with RUN_ERROR, not RUN_FINISHED, for a thrown error that only carries the step-limit code', async () => {
    const thrown = new AgentRunError('Not a step limit.', {
      kind: 'policy',
      code: 'MAXIMUM_STEPS',
    });
    await withPeers(
      { ...STEP_LIMIT, script: [{ kind: 'fail', error: thrown }] },
      async (harness) => {
        const started = await startOn(harness.handler);
        await started.reader.rest();
        const frames = started.reader.received;

        expect(typesOf(frames)).not.toContain(EventType.RUN_FINISHED);
        expect(frames.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          message: 'Not a step limit.',
        });
      },
    );
  });

  it('ends an attach that followed the run to its limit the same way', async () => {
    await withPeers(
      { ...STEP_LIMIT, script: [hold('generating'), say('one'), say('two')] },
      async (harness) => {
        const started = await startOn(harness.handler);
        await harness.generate.reached('generating');
        const attached = new FrameReader(
          await harness.handler(attachRunRequest(started.nativeRunId)),
        );
        await attached.until(EventType.STATE_SNAPSHOT);

        harness.generate.release('generating');
        await attached.rest();
        await started.reader.rest();

        expect(typesOf(attached.received)).not.toContain(EventType.RUN_FINISHED);
        expect(attached.received.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'MAXIMUM_STEPS',
          message: MESSAGE,
        });
      },
    );
  });
});

describe('a retry of the start of a run that already stopped at its step limit', () => {
  // A plain attach to a settled run answers RUN_NOT_FOUND by design. What re-streams the ended
  // run is the exact retry of its start: the same runId over the same rows.
  it.each([
    ['without an answer', undefined, undefined],
    ['with an onMaximumSteps answer', async () => 'Out of steps.', 'Out of steps.'],
  ] as const)(
    'streams the ended run again, ending with RUN_ERROR, code MAXIMUM_STEPS, %s',
    async (_name, onMaximumSteps, answer) => {
      await withPeers(
        {
          ...STEP_LIMIT,
          script: [say('one'), say('two')],
          ...(onMaximumSteps === undefined ? {} : { onMaximumSteps }),
        },
        async (harness) => {
          const first = await startOn(harness.handler);
          await first.reader.rest();
          expect(harness.bureau.listRuns()[0]!.status).toBe('error');

          const retry = await startOn(harness.handler);
          await retry.reader.rest();
          const frames = retry.reader.received;

          expect(harness.bureau.listRuns()).toHaveLength(1);
          expect(retry.nativeRunId).toBe(first.nativeRunId);
          expect(typesOf(frames)).not.toContain(EventType.RUN_FINISHED);
          expect(frames.at(-1)!.event).toMatchObject({
            type: EventType.RUN_ERROR,
            code: 'MAXIMUM_STEPS',
            message: MESSAGE,
          });
          if (answer !== undefined) {
            expect(
              frames
                .map((frame) => frame.event)
                .some((event) => 'delta' in event && event.delta === answer),
            ).toBe(true);
          }
        },
      );
    },
  );
});

describe('a peer stream of a run that stops at its step limit', () => {
  /** Follows the holder's run from a peer, releases it, and returns the frames the peer read. */
  async function followFromPeer(
    harness: Harness,
    prepare: (peer: Harness) => void = () => undefined,
  ) {
    const peer = await harness.peer([]);
    try {
      prepare(peer);
      const started = await startOn(harness.handler);
      await harness.generate.reached('a-generating');
      const attached = new FrameReader(await peer.handler(attachThreadRequest(THREAD)));
      await attached.next();
      harness.generate.release('a-generating');
      await attached.rest();
      await started.reader.rest();
      return attached.received;
    } finally {
      await peer.dispose();
    }
  }

  it('ends with RUN_ERROR, code MAXIMUM_STEPS, from the run’s history', async () => {
    await withPeers(
      { ...STEP_LIMIT, script: [hold('a-generating'), say('one'), say('two')] },
      async (harness) => {
        const received = await followFromPeer(harness);

        expect(typesOf(received)).not.toContain(EventType.RUN_FINISHED);
        expect(received.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'MAXIMUM_STEPS',
          message: MESSAGE,
        });
      },
    );
  });

  it('ends with RUN_ERROR, code MAXIMUM_STEPS, from the workflow’s status when history is unavailable', async () => {
    await withPeers(
      { ...STEP_LIMIT, script: [hold('a-generating'), say('one'), say('two')] },
      async (harness) => {
        const received = await followFromPeer(harness, (peer) => {
          peer.bureau.eventHistory = async () => {
            throw new Error('The event history is unavailable.');
          };
        });

        expect(typesOf(received)).not.toContain(EventType.RUN_FINISHED);
        const last = received.at(-1)!.event;
        expect(last).toMatchObject({ type: EventType.RUN_ERROR, code: 'MAXIMUM_STEPS' });
        expect((last as { message: string }).message).toMatch(
          /^Run ".+" stopped at its step limit$/,
        );
      },
    );
  });
});
