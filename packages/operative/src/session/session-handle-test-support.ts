import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  activity,
  MemoryStorage,
  textValueStore,
  workflow,
  yieldToPortableEventLoop,
  type Storage,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import type { ConversationSnapshot } from 'conversationalist';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import type { CheckpointStore } from '../durable/checkpoint-store';
import {
  createRunEngine,
  type RegistryAgnosticEngine,
  type RunEngine,
} from '../durable/create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import type { RunCheckpoint } from '../durable/types';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import type { SessionStore } from './types';

export const fixtureRuntime = createManualRuntimeServices();

export function createInstantGenerate(content = 'hello'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

export function errorMessage(value: unknown): string {
  if (!(value instanceof Error)) throw new TypeError('Expected an Error');
  return value.message;
}

export function createCheckpointStoreFixture(
  loadCheckpoint: (runId: string) => Promise<{
    conversation: ConversationSnapshot | null;
    cursor: {
      totalUsage: Record<string, number>;
      lastContent: string;
      schemaAttempts: number;
    };
    steps: RunCheckpoint['steps'];
  }>,
): CheckpointStore {
  return {
    saveCursor: async () => {},
    loadCursor: async () => null,
    saveConversation: async () => {},
    loadConversation: async () => null,
    saveStep: async () => {},
    loadSteps: async () => [],
    async loadCheckpoint(runId) {
      const checkpoint = await loadCheckpoint(runId);
      return {
        ...checkpoint,
        runId,
        cursor: {
          schemaVersion: 2,
          step: 0,
          lastAppliedConfigVersion: 0,
          totalUsage: { prompt: 0, completion: 0, total: 0, ...checkpoint.cursor.totalUsage },
          lastContent: checkpoint.cursor.lastContent,
          lastParts: [],
          finalRowIsReplacement: false,
          schemaAttempts: checkpoint.cursor.schemaAttempts,
        },
      };
    },
    clear: async () => 0,
  };
}

export function createTestRunOptions(generate: GenerateFunction = createInstantGenerate()) {
  return { generate, toolbox: createToolbox([]), maximumSteps: 1 };
}

export function createSessionHandleFixture(overrides?: {
  sessionId?: string;
  engine?: RegistryAgnosticEngine;
  withoutRunOptions?: boolean;
}) {
  const sessionId = overrides?.sessionId ?? 'test-session';
  const store = createSessionStore(textValueStore(new MemoryStorage()));
  return {
    sessionId,
    store,
    handle: createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      engine: overrides?.engine,
      runOptions: overrides?.withoutRunOptions ? undefined : createTestRunOptions(),
    }),
  };
}

export function createUpdateGate(store: SessionStore): {
  readonly store: SessionStore;
  readonly release: () => void;
} {
  let releaseUpdate: (() => void) | undefined;
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  return {
    store: {
      ...store,
      async update(...args) {
        await updateGate;
        return store.update(...args);
      },
    },
    release() {
      releaseUpdate?.();
    },
  };
}

export function collectEvents(emitter: EventTarget, type: string): Event[] {
  const collected: Event[] = [];
  emitter.addEventListener(type, (event) => collected.push(event));
  return collected;
}

export function makeProbeWorkflow() {
  const probe = activity({ name: 'probe', execute: async () => ({ ok: true }) });
  return workflow({ name: 'agentRun' })
    .activities({ probe })
    .execute(async function* (ctx) {
      yield* ctx.run('probe', {});
      return {
        schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
        parts: [],
        runId: '',
        steps: 1,
        content: 'done',
        finishReason: 'stop-condition' as const,
      };
    });
}

function makeParkingWorkflow(sleepMs: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx) {
    yield* ctx.sleep(sleepMs);
    return {
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      parts: [],
      runId: '',
      steps: 1,
      content: 'resumed',
      finishReason: 'stop-condition' as const,
    };
  });
}

/**
 * The instant every parked-run engine reads as "now" (COR-1610).
 *
 * A durable `ctx.sleep` anchors its deadline on the engine's `getNow()`, and Weft completes a
 * sleep inline, without ever writing its timer, when that deadline has already passed by the time
 * the operation is processed (`processSleepOperation`). On the host clock, a parked run therefore
 * stays parked only while less than its sleep has elapsed in wall time, which a loaded host does
 * not guarantee: the run finished inside the first engine, so a poll for its timer never held and
 * `recover()` found a terminal run and returned `null`. Every parked-run engine reads this frozen
 * instant instead, so a parked sleep fires only when a test ticks the scheduler past it.
 */
const PARKED_RUN_NOW_EPOCH_MILLISECONDS = 1_000_000;

/** How long the parking workflow sleeps, measured on the frozen parked-run clock. */
const PARKED_RUN_SLEEP_MILLISECONDS = 50;

/**
 * An instant far past any parked deadline (2100-01-01T00:00:00.000Z), for
 * `engine.scheduler.tick()`. `Scheduler#tick` scans persisted deadlines directly, so it fires a
 * parked sleep whether or not the engine started its real-time poller.
 */
export const FAR_FUTURE_EPOCH_MILLISECONDS = 4_102_444_800_000;

/**
 * Build a run engine whose `agentRun` workflow parks on a durable sleep that only an explicit
 * {@link settleParkedRun} fires. The engine reads the frozen parked-run clock and never arms
 * Weft's real-time scheduler poller, so no amount of elapsed host time completes the run.
 */
export function createParkedRunEngine(
  storage: Storage,
  options: { readonly recover?: boolean } = {},
): Promise<RunEngine> {
  return createRunEngine({
    storage,
    runWorkflow: makeParkingWorkflow(PARKED_RUN_SLEEP_MILLISECONDS),
    getNow: () => PARKED_RUN_NOW_EPOCH_MILLISECONDS,
    startScheduler: false,
    ...(options.recover === undefined ? {} : { recover: options.recover }),
  });
}

/** The storage key of the durable timer a parked run's first `ctx.sleep` writes. */
export function parkedSleepTimerKey(runId: string): string {
  return `timer-idx:sleep:${runId}:0`;
}

// Bounded, event-loop-turn poll for a condition — never a real timer delay.
const EVENT_LOOP_POLL_MAX_ATTEMPTS = 200;
export async function waitForEventLoop(predicate: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < EVENT_LOOP_POLL_MAX_ATTEMPTS; attempt++) {
    if (await predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('waitForEventLoop exceeded its attempt bound before the condition held');
}

/** Wait until a parked run has committed its durable sleep timer. */
export async function waitForParkedSleep(storage: Storage, runId: string): Promise<void> {
  await waitForEventLoop(() => storage.has(parkedSleepTimerKey(runId)));
}

/**
 * Fire a parked run's sleep and wait for the run to reach a terminal status. The scheduler is
 * ticked on every attempt because a recovered run re-registers its sleep asynchronously after
 * recovery returns; a tick before that registration leaves the run parked.
 */
export async function settleParkedRun(
  engine: RegistryAgnosticEngine,
  runId: string,
): Promise<void> {
  await waitForEventLoop(async () => {
    await engine.scheduler.tick(FAR_FUTURE_EPOCH_MILLISECONDS);
    const state = await engine.get(runId);
    return state !== null && state.status !== 'running' && state.status !== 'pending';
  });
}

export function alreadyTerminalError(runId: string, status: string): Error {
  return new Error(
    `Cannot resume workflow "${runId}": status is "${status}", expected "running" or "suspended"`,
  );
}

export async function seedRunningSession(sessionId: string, runId: string): Promise<SessionStore> {
  const store = createSessionStore(textValueStore(new MemoryStorage()));
  await store.save(
    createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId,
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    }),
  );
  return store;
}

export function dispatchOnToolboxContext(context: unknown, event: Event): void {
  if (
    context === null ||
    typeof context !== 'object' ||
    !('dispatchEvent' in context) ||
    typeof context.dispatchEvent !== 'function'
  ) {
    throw new TypeError('toolbox context does not expose dispatchEvent');
  }
  context.dispatchEvent(event);
}
