/**
 * COR-1587 — a durable run whose engine fails it ends, for the session and for the stream. A
 * refused write of the run's durable record, after the run is released, rejects the run's result
 * with a plain error the engine gives no code. The run settles as `error`: the stream's last frame
 * is `RUN_ERROR`, the run record reads `error`, and the session records `lastRunStatus: 'error'`,
 * so the thread takes new input instead of staying `running` until the next boot. Held to the same
 * outcome with a follow-up the run delivered and without one.
 */
import { EventType } from '@ag-ui/core';
import {
  createAgent,
  createScriptedGenerate,
  type ScriptedGenerateStep,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import { runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { FrameReader, typesOf } from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const WRITES = new Set(['put', 'delete', 'batch', 'conditionalBatch']);
/** The durable run record: the key a run's own writes go to once the run is released. */
const DURABLE_RUN_RECORD = 'durable-run:';

function keysOf(name: string, args: readonly unknown[]): string[] {
  if (name === 'put' || name === 'delete') return [String(args[0])];
  const operations = (name === 'batch' ? args[0] : args[1]) as Array<{ key: string }> | undefined;
  return (operations ?? []).map((operation) => operation.key);
}

/** A memory storage that, once told to, refuses every write whose key starts with a prefix. */
function refusingStorage() {
  const storage = new MemoryStorage();
  let refusedPrefix: string | undefined;
  let refused = 0;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const name = String(property);
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (!WRITES.has(name)) return call.bind(null);
      return async (...args: unknown[]) => {
        if (
          refusedPrefix !== undefined &&
          keysOf(name, args).some((key) => key.startsWith(refusedPrefix!))
        ) {
          refused += 1;
          throw new Error('This storage write is refused.');
        }
        return call(...args);
      };
    },
  });
  return {
    storage: proxy as unknown as Storage,
    refuseWritesUnder(prefix: string) {
      refusedPrefix = prefix;
    },
    refused: () => refused,
  };
}

const say = (content: string): ScriptedGenerateStep => ({
  kind: 'respond',
  response: { content, toolCalls: [] },
});

/** How long the stream may stay open before the test calls it stuck. */
const STUCK_AFTER_MILLISECONDS = 3000;

describe('a durable run whose engine fails it (COR-1587)', () => {
  for (const withFollowUp of [true, false]) {
    it(`ends the stream, the run record, and the session as error ${withFollowUp ? 'with' : 'without'} a delivered follow-up`, async () => {
      const generate = createScriptedGenerate([
        { kind: 'block', barrier: 'hold' },
        say('First.'),
        say('Answer.'),
      ]);
      const refusing = refusingStorage();
      const bureau = await createBureau({
        id: 'engine-failure',
        agents: {
          assistant: createAgent({ generate, name: 'assistant', stopWhen: stopWhen.noToolCalls() }),
        },
        generate,
        storage: refusing.storage,
        durableExecution: true,
        sessionPersistenceRetryDelayMilliseconds: 0,
        stopWhen: stopWhen.noToolCalls(),
        onDiagnostic: () => undefined,
      });
      const handler = createBureauHandler(bureau, {
        unauthenticatedAccess: 'allow',
        publish: ['assistant'],
        agUi: {},
      });
      const stream = new FrameReader(
        await handler(startRequest(runAgentInput({ threadId: 'thread-1', runId: 'client-run-1' }))),
      );
      try {
        await stream.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        if (withFollowUp) {
          const admitted = await bureau.submitSessionInput('thread-1', {
            id: 'follow-up-1',
            principal: 'anonymous:local',
            deliveryMode: 'steer',
            payload: 'One more thing',
          });
          expect(admitted.outcome).toBe('admitted');
        }
        refusing.refuseWritesUnder(DURABLE_RUN_RECORD);
        generate.release('hold');

        let stuck: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          stream.rest().then(() => 'ended' as const),
          new Promise<'stuck'>((resolve) => {
            stuck = setTimeout(() => resolve('stuck'), STUCK_AFTER_MILLISECONDS);
          }),
        ]);
        clearTimeout(stuck);

        expect(refusing.refused()).toBeGreaterThan(0);
        expect(outcome).toBe('ended');
        const last = stream.received.at(-1)?.event;
        expect(last?.type).toBe(EventType.RUN_ERROR);
        expect(typesOf(stream.received)).not.toContain(EventType.RUN_FINISHED);
        expect(bureau.listRuns()[0]?.status).toBe('error');
        const session = await bureau.getSession('thread-1');
        expect(session?.metadata['lastRunStatus']).toBe('error');
      } finally {
        await stream.cancel().catch(() => undefined);
        await bureau.dispose();
      }
    });
  }
});
