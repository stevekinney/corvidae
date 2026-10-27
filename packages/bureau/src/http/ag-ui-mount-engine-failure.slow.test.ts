/**
 * COR-1626 — a refused workflow-state (`wf:`) or event-history (`ev:`) write ends the run, the
 * session, and the AG-UI stream, instead of leaving all three open until the next boot.
 *
 * The engine retries a refused checkpoint or terminal write in process, five attempts over 750 ms of
 * real waiting, and a write still refused fails the run as a `system` failure. The one case that
 * leaves the engine's durable record `running` is a refused failure write too, which is what a
 * refused `wf:` write is: the engine abandons the run locally, and Operative and Bureau record it as
 * `error` anyway. These cases are the B31 probe's (COR-1490): a write refused after the run's step is
 * released, and a model that fails first and then meets a refused write, each with a follow-up the
 * run delivered and without one. In every one the stream's last frame is `RUN_ERROR` and not the
 * deadline's, the run record and the session read `error`, and the thread takes a new message.
 *
 * The waits are real, and so is this file's time: the engine's retry delays have no test seam from
 * here, and Bun's fake timers mis-count leaked real intervals in this repository, so none is used.
 */
import { EventType } from '@ag-ui/core';
import { createScriptedGenerate, type ScriptedGenerateStep } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import {
  openBureau,
  refusingStorage,
  say,
  startStream,
} from './ag-ui-engine-failure.test-support.ts';
import { FrameReader, typesOf } from './ag-ui-stream.test-support.ts';
import { listHeldTasks } from '../test';

/** Text no client may ever see: the storage adapter's own, which can name tables and paths. */
const ADAPTER_TEXT = 'relation "wf_secret_table" violates a constraint at /var/db/store';

type Moment = 'after the step is released' | 'after the model fails';

/** The script each moment runs: held at `hold`, then either a reply or a failing model. */
function scriptFor(moment: Moment): ScriptedGenerateStep[] {
  const next: ScriptedGenerateStep =
    moment === 'after the model fails'
      ? { kind: 'fail', error: new Error('the model failed') }
      : say('First.');
  return [{ kind: 'block', barrier: 'hold' }, next, say('Answer.'), say('Spare.'), say('Spare.')];
}

describe('a refused workflow-state or event-history write (COR-1626)', () => {
  for (const prefix of ['wf:', 'ev:'] as const) {
    for (const moment of ['after the step is released', 'after the model fails'] as const) {
      for (const withFollowUp of [true, false]) {
        it(`ends the stream, run record, and session as error when ${prefix} writes are refused ${moment}, ${withFollowUp ? 'with' : 'without'} a follow-up`, async () => {
          const generate = createScriptedGenerate(scriptFor(moment));
          const refusing = refusingStorage({ message: ADAPTER_TEXT });
          const opened = await openBureau({ generate, storage: refusing.storage });
          const { bureau, handler } = opened;
          const stream = await startStream(opened);
          try {
            await stream.until(EventType.STEP_STARTED);
            await generate.reached('hold');
            if (withFollowUp) {
              const admitted = await bureau.contexts.input('thread-1', {
                id: 'follow-up-1',
                principal: 'anonymous:local',
                deliveryMode: 'steer',
                payload: 'One more thing',
              });
              expect(admitted.outcome).toBe('admitted');
            }
            refusing.refuseWritesUnder(prefix);
            generate.release('hold');

            await stream.rest();

            expect(refusing.refused()).toBeGreaterThan(0);
            const last = stream.received.at(-1);
            expect(last?.event.type).toBe(EventType.RUN_ERROR);
            // The run's own end, not the stream's deadline.
            expect(last?.event).not.toMatchObject({ code: 'STREAM_DEADLINE' });
            expect(typesOf(stream.received)).not.toContain(EventType.RUN_FINISHED);
            const runId = listHeldTasks(bureau)[0]!.id;
            // A run that reports its own error ends its stream before the session has saved the
            // run's end, so wait for that save: `internals.whenTaskRecorded` is what a stuck run never reached.
            await bureau.internals.whenTaskRecorded(runId);
            expect(listHeldTasks(bureau)[0]?.status).toBe('error');
            const session = await bureau.contexts.get('thread-1');
            expect(session?.metadata['lastRunStatus']).toBe('error');
            // The storage adapter's text stays in the operator's logs: no client-facing record
            // (the stream, the saved session, the run record) carries it.
            expect(JSON.stringify(stream.received)).not.toContain('wf_secret_table');
            expect(JSON.stringify(session?.metadata)).not.toContain('wf_secret_table');
            expect(JSON.stringify(listHeldTasks(bureau))).not.toContain('wf_secret_table');

            // The thread takes a new message once storage accepts writes again.
            refusing.lift();
            const next = new FrameReader(
              await handler(
                startRequest(
                  runAgentInput({
                    threadId: 'thread-1',
                    runId: 'client-run-2',
                    messages: [{ id: 'user-2', role: 'user', content: 'again' }],
                  }),
                ),
              ),
            );
            await next.rest();
            expect(next.received.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
            expect(typesOf(next.received)).not.toContain(EventType.RUN_ERROR);
          } finally {
            await stream.cancel().catch(() => undefined);
            await bureau.dispose();
          }
        });
      }
    }
  }
});

describe('a completion that landed and then met refused retries (COR-1626)', () => {
  it('ends the stream with the stored outcome, not at the deadline', async () => {
    const generate = createScriptedGenerate([{ kind: 'block', barrier: 'hold' }, say('Done.')]);
    const refusing = refusingStorage({ message: ADAPTER_TEXT });
    const opened = await openBureau({ generate, storage: refusing.storage });
    const { bureau } = opened;
    const stream = await startStream(opened);
    try {
      await stream.until(EventType.STEP_STARTED);
      await generate.reached('hold');
      // The next write of a workflow record lands and is reported as failed; every later one is
      // refused. The workflow record is the one key `wf:<id>` has no suffix on.
      refusing.refuseWritesMatching((key) => /^wf:[^:]+$/.test(key), { landFirst: true });
      generate.release('hold');

      await stream.rest();

      expect(refusing.refused()).toBeGreaterThan(0);
      const last = stream.received.at(-1);
      expect(last?.event.type).toBe(EventType.RUN_FINISHED);
      expect(last?.event).not.toMatchObject({ code: 'STREAM_DEADLINE' });
      const runId = listHeldTasks(bureau)[0]!.id;
      await bureau.internals.whenTaskRecorded(runId);
      expect(listHeldTasks(bureau)[0]?.status).toBe('completed');
      const session = await bureau.contexts.get('thread-1');
      expect(session?.metadata['lastRunStatus']).toBe('completed');
    } finally {
      await stream.cancel().catch(() => undefined);
      await bureau.dispose();
    }
  });
});
