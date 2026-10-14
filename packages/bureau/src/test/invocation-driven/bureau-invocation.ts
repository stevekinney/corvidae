/**
 * COR-1437 — one invocation of a durable Bureau with one parent run and one
 * child, against the shared SQLite store in the driver's temporary directory.
 *
 * Usage: `bun bureau-invocation.ts <directory> <command> <label>`
 *
 * - `start` creates the parent run, dispatches one `worker` child, waits for
 *   the child to finish and for the parent to park on its `scheduleWakeup`
 *   timer, then exits through `bureau.shutdown()` with its default policy.
 * - `maintain` is the wake-up: `waitForRecovery()`, then one
 *   `bureau.runDurableMaintenance(now)` pass, then it waits for every durable
 *   run to leave `running` before shutting down.
 * - `read` only reads.
 *
 * Bureau composes its durable engine with `durableBackgroundTasks: 'manual'`
 * and `ownership: 'none'`. Bureau does not forward a `getNow` to that engine,
 * so its timers are scheduled on the wall clock; the driver's virtual clock
 * for these invocations therefore starts at the wall time, and only
 * `runDurableMaintenance(now)` reads it. With no claims to lapse, `'none'`
 * keeps the wall clock from deciding any outcome here.
 *
 * Not a test file: it is spawned by `invocation-driven-execution.test.ts`.
 */
import { join } from 'node:path';

import {
  createAgent,
  createCheckpointStore,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';

import { createBureau } from '../../create-bureau';
import type { BureauDiagnostic, BureauShutdownReport } from '../../types';
import { emit, parseInvocationArguments, pollUntil, readClock, WAKEUP_MS } from './protocol';

const { directory, command, label } = parseInvocationArguments('bureau-invocation');
const now = readClock(directory);
const CHILD_RUN_ID = 'invocation-driven-child';
const PRINCIPAL = 'alice';
const diagnostics: string[] = [];
const parentGenerateSteps: number[] = [];

/** The parent's first step parks on a wakeup; its continuation names this invocation. */
const parentGenerate: GenerateFunction = async ({ step }) => {
  parentGenerateSteps.push(step);
  if (step === 0) {
    return {
      content: '',
      toolCalls: [{ id: 'call-wakeup', name: 'scheduleWakeup', arguments: { in: WAKEUP_MS } }],
    };
  }
  return { content: `parent woke in ${label}`, toolCalls: [] };
};

const bureau = await createBureau({
  agents: {
    worker: createAgent({
      name: 'worker',
      generate: async () => ({ content: `child done in ${label}`, toolCalls: [] }),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  generate: parentGenerate,
  toolbox: createToolbox([]),
  storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
  durableExecution: true,
  durableBackgroundTasks: 'manual',
  durableOwnership: { ownership: 'none' },
  wakeup: true,
  stopWhen: stopWhen.some(stopWhen.toolCalled('scheduleWakeup'), stopWhen.noToolCalls()),
  onDiagnostic: (diagnostic: BureauDiagnostic) => {
    diagnostics.push(`${diagnostic.level} ${diagnostic.scope}: ${diagnostic.message}`);
  },
});

async function parentRunId(): Promise<string | undefined> {
  const runs = await bureau.listDurableRuns();
  return runs?.items.find((item) => item.id !== CHILD_RUN_ID)?.id;
}

/** Starts the parent and its child, and returns once the child is done and the parent is parked. */
async function startParentWithChild(): Promise<void> {
  const parent = await bureau.createRun({ message: 'plan the work', principal: PRINCIPAL });
  const dispatched = await bureau.children.dispatch({
    parentRunId: parent.id,
    agentName: 'worker',
    input: 'do the work',
    childRunId: CHILD_RUN_ID,
    principal: PRINCIPAL,
  });
  if (dispatched.outcome !== 'started') {
    throw new Error(`the child was not started: ${JSON.stringify(dispatched)}`);
  }
  const kv = bureau.kv;
  if (kv === undefined) throw new Error('the bureau has no durable key-value store');
  const checkpoints = createCheckpointStore(kv);
  await pollUntil('the parent to park on its wakeup', async () => {
    const cursor = await checkpoints.loadCursor(parent.id);
    return cursor !== null && cursor.step >= 1;
  });
  await pollUntil('the child to finish', async () => {
    const child = await bureau.children.get({
      parentRunId: parent.id,
      childRunId: CHILD_RUN_ID,
      principal: PRINCIPAL,
    });
    return child !== undefined && 'status' in child && child.status !== 'running';
  });
}

async function readState() {
  const id = await parentRunId();
  if (id === undefined) return { parent: null, child: null };
  const parent = await bureau.getDurableRun(id);
  const child = await bureau.children.get({
    parentRunId: id,
    childRunId: CHILD_RUN_ID,
    principal: PRINCIPAL,
  });
  return {
    parent: {
      status: parent?.status ?? null,
      content: (parent?.result as { content?: unknown } | undefined)?.content ?? null,
    },
    child:
      child !== undefined && 'status' in child
        ? { status: child.status, content: child.outcome?.content ?? null }
        : null,
  };
}

if (command === 'start') {
  await startParentWithChild();
} else if (command === 'maintain') {
  await bureau.waitForRecovery?.();
  await bureau.runDurableMaintenance(now);
  await pollUntil('every durable run to leave running', async () => {
    const runs = await bureau.listDurableRuns();
    return runs?.items.every((item) => item.status !== 'running') ?? false;
  });
} else if (command !== 'read') {
  process.stderr.write(`bureau-invocation: unknown command "${command}"\n`);
  process.exit(2);
}

const beforeShutdown = await readState();
const shutdown: BureauShutdownReport = await bureau.shutdown();
emit('finished', {
  label,
  now,
  beforeShutdown,
  shutdown: { policy: shutdown.policy, unresolved: shutdown.unresolved },
  parentGenerateSteps,
  diagnostics,
});
