/**
 * COR-1437 — one invocation of a Weft workflow with an activity and a durable
 * timer, against the shared SQLite store in the driver's temporary directory.
 *
 * Usage: `bun weft-invocation.ts <directory> <start|maintain|read> <label>`
 *
 * - `start` calls `engine.start` and does the work that start makes runnable.
 * - `maintain` is the cron or queue wake-up: one `engine.runMaintenance(now)`
 *   pass, which renews this engine's claims, takes over a workflow whose
 *   holder's claim has lapsed, and fires due timers.
 * - `read` only reads.
 *
 * The engine runs with `backgroundTasks: 'manual'` and no recovery during
 * construction, so nothing happens that this invocation did not ask for. Each
 * activity result names the invocation that produced it, which is how the
 * driver attributes every committed step. Setting the block variable to
 * `charge` or `finish` holds that activity open (see `blockIfRequested`).
 *
 * Not a test file: it is spawned by `invocation-driven-execution.test.ts`.
 */
import { join } from 'node:path';

import { activity, BunSQLiteStorage, Engine, workflow } from '@lostgradient/weft';

import {
  blockIfRequested,
  CLAIM_RENEW_MS,
  CLAIM_TTL_MS,
  emit,
  parseInvocationArguments,
  pollUntil,
  readClock,
  WEFT_SLEEP_MS,
  WEFT_WORKFLOW_ID,
  WEFT_WORKFLOW_INPUT,
} from './protocol';

const invocation = parseInvocationArguments('weft-invocation');
const { directory, command, label } = invocation;
const now = readClock(directory);

const charge = activity({
  name: 'charge',
  execute: async (order: string) => {
    await blockIfRequested('charge', invocation);
    return `charged ${order} in ${label}`;
  },
});

const finish = activity({
  name: 'finish',
  execute: async (order: string) => {
    await blockIfRequested('finish', invocation);
    return `finished ${order} in ${label}`;
  },
});

const order = workflow({ name: 'order' }).execute(async function* (ctx, input: string) {
  const charged = yield* ctx.run(charge, input);
  yield* ctx.sleep(WEFT_SLEEP_MS);
  const finished = yield* ctx.run(finish, input);
  return `${charged}; ${finished}`;
});

const engine = await Engine.create({
  storage: new BunSQLiteStorage(join(directory, 'weft.sqlite')),
  workflows: { order },
  activities: { charge, finish },
  ownership: 'workflow-lease',
  workflowClaimTtl: CLAIM_TTL_MS,
  workflowClaimRenewInterval: CLAIM_RENEW_MS,
  backgroundTasks: 'manual',
  getNow: () => now,
  recover: false,
});

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed-out']);

/**
 * Why this invocation has nothing more to do for the workflow, or `undefined`
 * while it is still driving it: the workflow is terminal, another live
 * invocation holds its claim, or it is parked on a timer that is not yet due.
 */
async function settledReason(): Promise<string | undefined> {
  const state = await engine.get(WEFT_WORKFLOW_ID);
  if (state === null) return 'absent';
  if (TERMINAL.has(state.status)) return 'terminal';
  const holder = await engine.claimHolder(WEFT_WORKFLOW_ID);
  if (holder?.heldByAnyProcess === true && !holder.heldByThisProcess) return 'held-elsewhere';
  // The workflow sleeps once, and the scenarios never wake it before its
  // timer is due, so the deadline is `WEFT_SLEEP_MS` after the timeline entry
  // that first scheduled it.
  const timeline = await engine.getTimeline(WEFT_WORKFLOW_ID);
  const sleeps = timeline.filter((entry) => entry.operationType === 'sleep');
  const scheduled = sleeps[0];
  const woke = sleeps.some((entry) => entry.status === 'completed');
  if (scheduled !== undefined && !woke && scheduled.timestamp + WEFT_SLEEP_MS > now) {
    return 'parked';
  }
  return undefined;
}

async function settle(): Promise<string> {
  let reason: string | undefined;
  await pollUntil('the workflow to settle', async () => {
    reason = await settledReason();
    return reason !== undefined;
  });
  return reason as string;
}

async function readWorkflow() {
  const state = await engine.get(WEFT_WORKFLOW_ID);
  const timeline = await engine.getTimeline(WEFT_WORKFLOW_ID);
  const events = await engine.getEvents(WEFT_WORKFLOW_ID);
  const checkpoints = await engine.listCheckpoints(WEFT_WORKFLOW_ID);
  return {
    status: state?.status ?? null,
    result: state?.result ?? null,
    timeline: timeline.map((entry) => ({
      step: entry.step,
      label: entry.operationLabel,
      status: entry.status,
      output: entry.outputSummary ?? null,
    })),
    checkpointEventSteps: events
      .filter((event) => event.type === 'workflow:checkpoint')
      .map((event) => event.data['step']),
    checkpointSteps: checkpoints.map((checkpoint) => checkpoint.step).toSorted((a, b) => a - b),
  };
}

let settled = 'read-only';
if (command === 'start') {
  await engine.start('order', WEFT_WORKFLOW_INPUT, { id: WEFT_WORKFLOW_ID });
  settled = await settle();
} else if (command === 'maintain') {
  await engine.runMaintenance(now);
  // A timer this pass fired has been acknowledged and collected by now, so a
  // driver that waits for this line before overlapping or killing this
  // invocation never leaves another engine a fired-but-uncollected timer.
  emit('maintained');
  settled = await settle();
} else if (command !== 'read') {
  process.stderr.write(`weft-invocation: unknown command "${command}"\n`);
  process.exit(2);
}

const workflowReport = await readWorkflow();
await engine.shutdown();
emit('finished', { label, now, settled, workflow: workflowReport });
