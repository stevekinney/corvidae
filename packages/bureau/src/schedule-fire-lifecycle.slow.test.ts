/**
 * COR-1482 — a schedule fire is part of the task and context lifecycle: its event stream follows
 * it to its end, bound or not; a running fire keeps its context live and is cancelled with it; a
 * fire that timed out settles its task; and a task registry that cannot write does not stop a
 * fire. Fires are driven by Weft's poller on real elapsed time, which is why this is a slow lane.
 */
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, WorkflowTimedOutEvent } from '@lostgradient/weft';
import type { BatchOperation, ConditionalBatchCondition } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import {
  openBureau,
  type OpenedBureau,
  parkingUntilAborted,
  readFrames,
  rpc,
  type RpcBody,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';

const FIRE_TIMEOUT_MS = 20_000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function waitForReal<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = FIRE_TIMEOUT_MS,
): Promise<T> {
  const start = performance.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function serve(generate: GenerateFunction): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: { writer: createAgent({ name: 'writer', generate }) },
    generate,
    durableHistory: true,
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

type TaskView = { id: string; contextId: string; status: string; finishReason: string | null };
const tasksOf = (body: RpcBody) => (body.result?.['tasks'] ?? []) as TaskView[];

/** The first fire of a schedule the owner makes; the schedule is cancelled so no second one starts. */
async function firstFire(opened: OpenedBureau): Promise<TaskView> {
  const created = await rpc(
    opened.handler,
    'bureau.schedules.create',
    { agentName: 'writer', spec: '1s', input: 'tick' },
    'alice-key',
  );
  const scheduleId = created.result!['id'] as string;
  const task = await waitForReal(async () => {
    const listed = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');
    return tasksOf(listed)[0];
  }, 'the first fire');
  await rpc(opened.handler, 'bureau.schedules.cancel', { scheduleId }, 'alice-key');
  return task;
}

/** Starts reading a task's event stream, so a test can change the world while it is open. */
async function observe(opened: OpenedBureau, taskId: string) {
  const response = await opened.handler(
    subscribeRequest('bureau.tasks.events', { taskId }, 'alice-key'),
  );
  expect(response.status).toBe(200);
  return readFrames(response, { timeoutMs: 10_000 });
}

/** Step 0 saves the fire's session (a tool call the toolbox lacks); step 1 waits on `gate`. */
function gatedAfterFirstStep(gate: Promise<void>): GenerateFunction {
  return async (context: GenerateContext) => {
    if (context.step === 0) {
      return {
        content: 'thinking',
        toolCalls: [{ id: 'call-1', name: 'missing-tool', arguments: {} }],
      };
    }
    await gate;
    return { content: 'fire answer', toolCalls: [] };
  };
}

async function waitForBound(opened: OpenedBureau, taskId: string): Promise<void> {
  await waitForReal(async () => {
    const record = await opened.bureau.tasks.record(taskId);
    return record !== undefined && record.incarnation !== '' ? true : undefined;
  }, 'the fire to be bound to its session');
}

describe('the event stream of a schedule fire', () => {
  it(
    'follows a fire that is not yet bound to its session to its end, and then ends',
    async () => {
      const opened = await serve(parkingUntilAborted);
      const task = await firstFire(opened);
      const unbound = await opened.bureau.tasks.record(task.id);
      expect(unbound?.incarnation).toBe('');

      const frames = observe(opened, task.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rpc(opened.handler, 'bureau.tasks.cancel', { taskId: task.id }, 'alice-key');
      const seen = await frames;

      expect(seen.map((frame) => frame.event)).toEqual(['task.snapshot', 'task.status']);
      expect(seen[0]?.data).toMatchObject({ status: 'working' });
      expect(seen[1]?.data).toMatchObject({ status: 'canceled', taskId: task.id });
    },
    FIRE_TIMEOUT_MS + 25_000,
  );

  it(
    'follows a fire that is bound to its session to its end, with its answer, and then ends',
    async () => {
      const gate = Promise.withResolvers<void>();
      const opened = await serve(gatedAfterFirstStep(gate.promise));
      const task = await firstFire(opened);
      await waitForBound(opened, task.id);

      const frames = observe(opened, task.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      gate.resolve();
      const seen = await frames;

      expect(seen.map((frame) => frame.event)).toEqual(['task.snapshot', 'task.status']);
      expect(seen[1]?.data).toMatchObject({
        status: 'completed',
        artifact: { text: 'fire answer' },
      });
      const view = await rpc(opened.handler, 'bureau.tasks.get', { taskId: task.id }, 'alice-key');
      expect(view.result).toMatchObject({ status: 'completed' });
    },
    FIRE_TIMEOUT_MS + 25_000,
  );

  it(
    'answers a fire that is already over with its end at once, and an empty stream to a client that has seen it',
    async () => {
      const opened = await serve(async () => ({ content: 'done at once', toolCalls: [] }));
      const task = await firstFire(opened);
      await waitForReal(async () => {
        const view = await rpc(
          opened.handler,
          'bureau.tasks.get',
          { taskId: task.id },
          'alice-key',
        );
        return view.result?.['status'] === 'completed' ? true : undefined;
      }, 'the fire to complete');

      const seen = await observe(opened, task.id);
      expect(seen.map((frame) => frame.event)).toEqual(['task.snapshot', 'task.status']);
      expect(seen[1]?.data).toMatchObject({
        status: 'completed',
        artifact: { text: 'done at once' },
      });

      const cursor = (seen[1] as { id?: string }).id!;
      const resumed = await readFrames(
        await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: task.id }, 'alice-key', cursor),
        ),
        { timeoutMs: 5_000 },
      );
      expect(resumed).toEqual([]);
    },
    FIRE_TIMEOUT_MS + 25_000,
  );
});

describe('a running schedule fire and its context', () => {
  it(
    'keeps the context live while it runs, and is cancelled when the context is deleted',
    async () => {
      const gate = Promise.withResolvers<void>();
      const opened = await serve(gatedAfterFirstStep(gate.promise));
      const task = await firstFire(opened);
      await waitForBound(opened, task.id);

      const listed = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const contexts = (listed.result?.['contexts'] ?? []) as Array<{
        id: string;
        activity: string;
      }>;
      expect(contexts.find((context) => context.id === task.contextId)?.activity).toBe('running');

      const deleted = await rpc(
        opened.handler,
        'bureau.contexts.delete',
        { contextId: task.contextId },
        'alice-key',
      );
      expect(deleted.error).toBeUndefined();
      // A fire has no cleanup to acknowledge: its stop is reported as one nothing confirms, with
      // no wait for it, as the default wait of zero gives.
      expect(deleted.result?.['receipt']).toBe('cleanup-unresolved');
      expect(deleted.result?.['tasks']).toEqual([
        expect.objectContaining({ taskId: task.id, cleanup: 'cleanup-unresolved' }),
      ]);
      const after = await rpc(opened.handler, 'bureau.tasks.get', { taskId: task.id }, 'alice-key');
      expect(after.result).toMatchObject({ status: 'canceled' });
      gate.resolve();
    },
    FIRE_TIMEOUT_MS + 25_000,
  );

  it(
    'does not keep the context live once it has ended',
    async () => {
      const gate = Promise.withResolvers<void>();
      const opened = await serve(gatedAfterFirstStep(gate.promise));
      const task = await firstFire(opened);
      await waitForBound(opened, task.id);
      gate.resolve();
      await waitForReal(async () => {
        const view = await rpc(
          opened.handler,
          'bureau.tasks.get',
          { taskId: task.id },
          'alice-key',
        );
        return view.result?.['status'] === 'completed' ? true : undefined;
      }, 'the fire to complete');

      const listed = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const contexts = (listed.result?.['contexts'] ?? []) as Array<{
        id: string;
        activity: string;
      }>;
      expect(contexts.find((context) => context.id === task.contextId)?.activity).toBe('idle');
    },
    FIRE_TIMEOUT_MS + 25_000,
  );
});

describe('a schedule fire that timed out', () => {
  it(
    'settles its task as failed',
    async () => {
      const opened = await serve(parkingUntilAborted);
      const task = await firstFire(opened);

      opened.bureau
        .durableEngine()!
        .dispatchEvent(new WorkflowTimedOutEvent(task.id, 'execution', 1));

      const failed = await waitForReal(async () => {
        const view = await rpc(
          opened.handler,
          'bureau.tasks.get',
          { taskId: task.id },
          'alice-key',
        );
        return view.result?.['status'] === 'failed' ? view : undefined;
      }, 'the timed-out fire’s task to read as failed');
      expect(failed.result).toMatchObject({ finishReason: 'timed-out' });
    },
    FIRE_TIMEOUT_MS + 25_000,
  );
});

/** Storage that refuses to change a task record once it exists, as a registry that cannot write. */
class StuckTaskRecordStorage extends MemoryStorage {
  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const updatesATaskRecord =
      operations.some(
        (operation) => operation.type === 'put' && operation.key.includes('bureau-task:v1:'),
      ) && conditions.some((condition) => condition.expectedValue !== null);
    if (updatesATaskRecord) return false;
    return super.conditionalBatch(conditions, operations);
  }
}

describe('a task registry that cannot write', () => {
  it(
    'is diagnosed, and the fire still runs to its end',
    async () => {
      const diagnostics: string[] = [];
      const completed: string[] = [];
      const bureau = await createBureau({
        id: 'stuck-registry',
        agents: {},
        generate: async () => ({ content: 'ran anyway', toolCalls: [] }),
        toolbox: createToolbox([]),
        storage: new StuckTaskRecordStorage(),
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });
      cleanups.push(() => bureau.dispose());
      bureau.addEventListener('schedule.completed', (event) => completed.push(event.runId));

      const schedule = await bureau.createSchedule({
        agentName: 'writer',
        spec: '1s',
        input: 'tick',
        principal: 'api-key:alice',
        sessionId: 'recurring',
      });
      await waitForReal(async () => (completed.length > 0 ? true : undefined), 'the fire to end');
      await bureau.cancelSchedule(schedule!.id);

      expect(completed.length).toBeGreaterThan(0);
      expect(diagnostics.some((message) => message.includes('Could not bind the task'))).toBe(true);
    },
    FIRE_TIMEOUT_MS + 25_000,
  );
});
