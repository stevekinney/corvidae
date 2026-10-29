/**
 * COR-1437 — one invocation of an Operative durable run with an inline
 * scripted `generate`, against the shared SQLite store in the driver's
 * temporary directory.
 *
 * Usage: `bun operative-invocation.ts <directory> <start|maintain|read> <label>`
 *
 * - `start` starts the run through `createActiveRun`'s durable routing. Its
 *   one scripted step calls `scheduleWakeup`, so the run parks on a durable
 *   timer and the invocation shuts its engine down.
 * - `maintain` is the wake-up: one `engine.runMaintenance(now)` pass. When the
 *   timer is due, Weft resumes the run and asks `resolveWorkflowServices` for
 *   the run's services, which this invocation rebuilds with its own scripted
 *   `generate`, so the continuation step runs here.
 * - `read` only reads.
 *
 * Not a test file: it is spawned by `invocation-driven-execution.test.ts`.
 */
import { join } from 'node:path';

import {
  createActiveRun,
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  createScheduleWakeupTool,
  type DurableRunDeps,
  type GenerateFunction,
  type ScheduleWakeupInput,
  stopWhen,
} from '@lostgradient/operative';
import { BunSQLiteStorage } from '@lostgradient/weft';
import { textValueStore } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { createConversationHistory } from 'conversationalist';

import {
  CLAIM_RENEW_MS,
  CLAIM_TTL_MS,
  emit,
  OPERATIVE_RUN_ID,
  parseInvocationArguments,
  pollUntil,
  readClock,
  WAKEUP_MS,
} from './protocol';

const { directory, command, label } = parseInvocationArguments('operative-invocation');
const now = readClock(directory);
const generateCalls: number[] = [];

/** Step 0 parks on a wakeup; every later step finishes the run, naming this invocation. */
const generate: GenerateFunction = async ({ step }) => {
  generateCalls.push(step);
  if (step === 0) {
    return {
      content: '',
      toolCalls: [{ id: 'call-wakeup', name: 'scheduleWakeup', arguments: { in: WAKEUP_MS } }],
    };
  }
  return { content: `woke in ${label}`, toolCalls: [] };
};

/** A `scheduleWakeup` tool that writes onto whichever services object `servicesRef` holds. */
function createWakeupToolbox(servicesRef: { current?: DurableRunDeps }) {
  const wakeup = createScheduleWakeupTool({
    context: {
      durable: true,
      get pendingWakeup() {
        return servicesRef.current?.pendingWakeup;
      },
      set pendingWakeup(value) {
        if (servicesRef.current !== undefined) servicesRef.current.pendingWakeup = value;
      },
      get pendingHumanWait() {
        return servicesRef.current?.pendingHumanWait;
      },
    },
  });
  return createToolbox([
    createTool({
      ...wakeup,
      execute: async (input: ScheduleWakeupInput) => await Promise.resolve(wakeup.execute(input)),
    }),
  ]);
}

/** The services a resumed run needs, rebuilt in this process. */
function rebuildServices(): DurableRunDeps {
  const servicesRef: { current?: DurableRunDeps } = {};
  const toolbox = createWakeupToolbox(servicesRef);
  const services: DurableRunDeps = {
    toolbox,
    options: {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: stopWhen.noToolCalls(),
    },
  };
  servicesRef.current = services;
  return services;
}

const storage = new BunSQLiteStorage(join(directory, 'operative.sqlite'));
const checkpointStore = createCheckpointStore(
  textValueStore(storage, { disposeUnderlyingStorage: false }),
);
const { engine } = await createRunEngine({
  storage,
  runWorkflow: createRunWorkflow(checkpointStore),
  checkpointStore,
  recover: false,
  ownership: 'workflow-lease',
  workflowClaimTtlMs: CLAIM_TTL_MS,
  workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
  backgroundTasks: 'manual',
  getNow: () => now,
  resolveWorkflowServices: () => ({ status: 'available', services: rebuildServices() }),
});

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed-out']);

/** Terminal, or parked on its wakeup timer and not yet due. */
async function settledReason(): Promise<string | undefined> {
  const state = await engine.get(OPERATIVE_RUN_ID);
  if (state === null) return undefined;
  if (TERMINAL.has(state.status)) return 'terminal';
  const timeline = await engine.getTimeline(OPERATIVE_RUN_ID);
  const sleeps = timeline.filter((entry) => entry.operationType === 'sleep');
  const scheduled = sleeps[0];
  const woke = sleeps.some((entry) => entry.status === 'completed');
  if (scheduled !== undefined && !woke && scheduled.timestamp + WAKEUP_MS > now) return 'parked';
  return undefined;
}

async function settle(): Promise<string> {
  let reason: string | undefined;
  await pollUntil('the run to settle', async () => {
    reason = await settledReason();
    return reason !== undefined;
  });
  return reason as string;
}

let settled = 'read-only';
if (command === 'start') {
  const servicesRef: { current?: DurableRunDeps } = {};
  const toolbox = createWakeupToolbox(servicesRef);
  const run = createActiveRun(
    {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: stopWhen.some(stopWhen.toolCalled('scheduleWakeup'), stopWhen.noToolCalls()),
    },
    {
      engine,
      checkpointStore,
      runId: OPERATIVE_RUN_ID,
      prompt: 'check back in an hour',
      onServices: (services) => {
        servicesRef.current = services;
      },
    },
  );
  await run.durablyStarted;
  settled = await settle();
} else if (command === 'maintain') {
  await engine.runMaintenance(now);
  settled = await settle();
} else if (command !== 'read') {
  process.stderr.write(`operative-invocation: unknown command "${command}"\n`);
  process.exit(2);
}

const state = await engine.get(OPERATIVE_RUN_ID);
const checkpoint = await checkpointStore.loadCheckpoint(OPERATIVE_RUN_ID);
const runReport = {
  status: state?.status ?? null,
  content: (state?.result as { content?: unknown } | undefined)?.content ?? null,
  steps: checkpoint.steps.map((record) => record.step),
  generateCalls,
};
await engine.shutdown();
emit('finished', { label, now, settled, run: runReport });
