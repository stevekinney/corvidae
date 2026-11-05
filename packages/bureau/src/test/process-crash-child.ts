/**
 * COR-1390 — the child half of the process-crash recovery harness.
 *
 * Usage: `bun process-crash-child.ts <scenario> <sqlite|lmdb> <storagePath> <markerPath>`
 *
 * Stands up a real durable Bureau under `workflow-lease` ownership, drives
 * the named scenario, writes the marker file synchronously, and then kills
 * itself with SIGKILL. No `dispose()`, no `shutdown()`: SIGKILL cannot be
 * trapped, so whatever the parent finds afterwards was genuinely on disk
 * before the process died and the claim it held is left to lapse.
 *
 * `verify`, `relaunch-recover`, and `race-recover` are the exceptions: each is
 * a later boot over a store a crashed child left behind, and exits normally.
 *
 * Not a test file: it is spawned by `process-crash-recovery.test.ts`. Each
 * scenario is a named function below; the `scenarios` table is the extension
 * point for further crash scenarios.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createCheckpointStore,
  stopWhen,
  createAgent,
  createSessionStore,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { spyOn } from 'bun:test';
import { z } from 'zod';

import { createBureau } from '../create-bureau';
import { publishChildFile } from './child-output-file';
import {
  chargeStatus,
  chargeToolCalls,
  CLAIM_RENEW_MS,
  CLAIM_TTL_MS,
  createChargeToolbox,
  createHarnessBureau,
  firstUserMessage,
  createInterruptedApprovalToolbox,
  createPeerApprovalToolbox,
  HUMAN_WAIT_PROMPT,
  HUMAN_WAIT_SIGNAL,
  openGovernedMemory,
  openIdempotencyCache,
  readEffects,
  REMEMBERED_ANSWER,
  requestContext,
  SECOND_HUMAN_WAIT_PROMPT,
  SECOND_HUMAN_WAIT_SIGNAL,
  SESSION_ID,
} from './process-crash-work-integrity-fixtures';
import {
  RACER_GO_FILE,
  RACER_READY_FILE,
  RACER_REPORT_FILE,
  settleRacer,
  startRacer,
} from './process-crash-racer';
import type { AgentDefinitions } from '../agent-catalog';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import { LMDBStorage } from '@lostgradient/storage-lmdb';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { textValueStore } from '@lostgradient/storage';
import { reviewDecisionKey } from '../review-decision-record';
/** Durable statuses a run never leaves. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);
const POLL_DELAY_MS = 5;
const runtime = createDefaultRuntimeServices();

const scenarioName = process.argv[2];
const backend = process.argv[3];
const storagePath = process.argv[4];
const markerPath = process.argv[5];
/** `unwrapped` builds `charge-then-crash` without idempotency (the COR-1391 control). */
const variant = process.argv[6];

if (
  scenarioName === undefined ||
  (backend !== 'sqlite' && backend !== 'lmdb') ||
  storagePath === undefined ||
  markerPath === undefined
) {
  process.stderr.write(
    'usage: process-crash-child <scenario> <sqlite|lmdb> <storagePath> <markerPath> [variant]\n',
  );
  process.exit(2);
}

/**
 * Condition poll with a tiny real delay (LMDB starves a zero-delay loop),
 * bounded by `attempts`. A scenario whose parent enforces its own deadline
 * passes `Infinity`, so a slow host is not mistaken for a stuck one.
 */
async function pollUntil(description: string, check: () => boolean | Promise<boolean>) {
  for await (const _turn of awakeTurns()) {
    if (await check()) return;
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, POLL_DELAY_MS));
  }
  process.stderr.write(`child: timed out waiting for ${description}\n`);
  process.exit(3);
}

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

/**
 * Commits step 0, parks mid-step-1, records what the child has durably
 * observed, then returns so the caller can kill the process.
 */
async function parkAfterStepZero(): Promise<void> {
  let reachedStepOne = false;
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          // Step 0's cursor has committed once step 1 is requested.
          reachedStepOne = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    durable: true,
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });

  const auditTrail = bureau.internals.auditTrail;
  if (auditTrail === undefined) {
    process.stderr.write('child: the bureau has no audit trail\n');
    process.exit(4);
  }

  const run = await bureau.tasks.start('default', 'crash harness run', { principal: 'alice' });

  await pollUntil('generate to be invoked at step 1', () => reachedStepOne);
  await pollUntil('the step-0 step.completed audit record', async () => {
    const records = await auditTrail.query({ runId: run.id, type: 'step.completed' });
    return records.length > 0;
  });
  await pollUntil('a non-empty session event page', async () => {
    const page = await bureau.contexts.events(run.contextId);
    return !('outcome' in page) && page.events.length > 0;
  });

  const records = await auditTrail.query({ runId: run.id });
  const maxAuditSequence = Math.max(...records.map((record) => record.sequence ?? -1));
  const page = await bureau.contexts.events(run.contextId);
  if ('outcome' in page) {
    process.stderr.write(`child: expected an event page, got ${JSON.stringify(page)}\n`);
    process.exit(4);
  }
  const last = page.events[page.events.length - 1];
  if (last === undefined) {
    process.stderr.write('child: session event page was empty\n');
    process.exit(4);
  }

  // Written synchronously so it is on disk before the kill.
  publishChildFile(
    markerPath as string,
    JSON.stringify({
      runId: run.id,
      sessionId: run.contextId,
      maxAuditSequence,
      sessionCursor: last.cursor,
      sessionLastSequence: last.sequence,
    }),
  );
}

function writeMarker(marker: Record<string, unknown>): void {
  publishChildFile(markerPath as string, JSON.stringify(marker));
}

function killSelf(): never {
  // No `dispose()` / `shutdown()`, deliberately.
  process.kill(process.pid, 'SIGKILL');
  return undefined as never;
}

/** COR-1391: step 0's tools ran and the idempotency cache recorded them, then SIGKILL. */
async function chargeThenCrash(): Promise<void> {
  const directory = dirname(markerPath as string);
  const { cache, store } = await openIdempotencyCache(directory);
  const runState: { id?: string } = {};
  const toolbox = createChargeToolbox(
    directory,
    async () => {
      await pollUntil('one charge effect and its completed cache entry', async () => {
        if (readEffects(directory).length !== 1) return false;
        return variant === 'unwrapped' ? true : (await chargeStatus(store, cache)) === 'completed';
      });
      await pollUntil('the run id', () => runState.id !== undefined);
      writeMarker({ runId: runState.id });
      return killSelf();
    },
    { cache, wrap: variant !== 'unwrapped' },
  );
  const bureau = await createHarnessBureau({
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    generate: async () => ({ content: 'charging', toolCalls: chargeToolCalls }),
    toolbox,
  });
  const run = await bureau.tasks.start('default', 'crash harness charge', {
    contextId: SESSION_ID,
    principal: 'alice',
    requestContext: requestContext(),
  });
  runState.id = run.id;
  await new Promise<never>(() => {});
}

/** COR-1391: the governed-memory record write resolves, then SIGKILL before the memo commits. */
async function memoryWriteThenCrash(): Promise<void> {
  const directory = dirname(markerPath as string);
  const runState: { id?: string } = {};
  const { memory } = await openGovernedMemory(directory, (storage) => {
    const original = storage.conditionalBatch?.bind(storage);
    if (original === undefined) throw new Error('child: memory storage lacks conditionalBatch');
    return new Proxy(storage, {
      get(target, property) {
        if (property === 'conditionalBatch') {
          return async (...args: Parameters<typeof original>) => {
            const applied = await original(...args);
            if (applied && args[1].some((operation) => operation.type === 'put')) {
              await pollUntil('the run id', () => runState.id !== undefined);
              writeMarker({ runId: runState.id, sessionId: SESSION_ID });
              killSelf();
            }
            return applied;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const bureau = await createHarnessBureau({
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    generate: async () => ({ content: REMEMBERED_ANSWER, toolCalls: [] }),
    toolbox: createToolbox([createNextTool()]),
    memory,
  });
  const run = await bureau.tasks.start('default', 'crash harness memory', {
    contextId: SESSION_ID,
    principal: 'alice',
    requestContext: requestContext(),
  });
  runState.id = run.id;
  await new Promise<never>(() => {});
}

/** COR-1391: two runs park mid-step-1; both ids are recorded, then SIGKILL. */
async function twoParkedRuns(): Promise<void> {
  const reachedStepOne = new Set<string>();
  const bureau = await createHarnessBureau({
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    generate: async (context) => {
      if (context.step === 0) {
        return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      reachedStepOne.add(firstUserMessage(context));
      return new Promise<never>(() => {});
    },
    toolbox: createToolbox([createNextTool()]),
  });
  const x = await bureau.tasks.start('default', 'crash harness run X', { principal: 'alice' });
  const y = await bureau.tasks.start('default', 'crash harness run Y', { principal: 'alice' });
  await pollUntil('both runs to invoke generate at step 1', () => reachedStepOne.size === 2);
  writeMarker({ xRunId: x.id, yRunId: y.id });
}

/**
 * COR-1409: a run parks on `requestHumanInput`, and the process dies once the
 * park is durable.
 *
 * The review becomes visible as soon as the tool dispatches its park event,
 * which happens while the step memo carrying the pending wait is still being
 * committed. A process killed in that window was never durably parked: its
 * successor rightly re-runs the step. So the child waits until the run's cursor
 * has advanced past step 0, which the workflow commits only after that memo and
 * the step record. COR-121's in-process test covers the narrower window where
 * the memo landed and the step record did not.
 */
async function humanWaitParked(twoCalls = false): Promise<void> {
  const park = {
    id: 'call-park',
    name: 'requestHumanInput',
    arguments: { signalName: HUMAN_WAIT_SIGNAL, prompt: HUMAN_WAIT_PROMPT },
  };
  // COR-1578: a second request in the same step is refused, so only one of the two parks.
  const secondPark = {
    id: 'call-park-second',
    name: 'requestHumanInput',
    arguments: { signalName: SECOND_HUMAN_WAIT_SIGNAL, prompt: SECOND_HUMAN_WAIT_PROMPT },
  };
  const bureau = await createHarnessBureau({
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    generate: async () => ({ content: '', toolCalls: twoCalls ? [park, secondPark] : [park] }),
    toolbox: createToolbox([]),
  });
  const run = await bureau.tasks.start('default', 'crash harness park', { principal: 'alice' });
  await pollUntil('the run to surface its human-wait review', () =>
    bureau.reviews.list().some((review) => review.runId === run.id),
  );
  // Read through the Bureau's own store: a second handle on a live LMDB path
  // can deadlock against the Bureau's (see `storage-fixtures.ts`).
  if (bureau.internals.kv === undefined) {
    process.stderr.write('child: the bureau has no durable key-value store\n');
    process.exit(4);
  }
  const checkpoints = createCheckpointStore(bureau.internals.kv);
  await pollUntil('the run cursor to advance past the parked step', async () => {
    const cursor = await checkpoints.loadCursor(run.id);
    return cursor !== null && cursor.step >= 1;
  });
  // The signal the step honored, as the live review names it: the parent compares the recovered
  // review with it, without assuming which of the two parallel calls arrived first.
  const honored = bureau.reviews
    .list()
    .find((review) => review.runId === run.id && review.kind === 'human-wait');
  writeMarker({
    runId: run.id,
    ...(honored?.kind === 'human-wait' ? { honoredSignal: honored.signalName } : {}),
  });
}

/**
 * COR-1439: the supervisor's relaunch after `park-after-step-0` died from
 * SIGKILL. Boots a durable Bureau over the same store, lets boot recovery and
 * durable maintenance adopt the run once the dead holder's claim lapses, and
 * records the run's terminal status beside the crash marker. It polls without
 * an attempt bound: the parent test owns the deadline and kills it there.
 */
async function relaunchRecover(): Promise<void> {
  const { runId } = JSON.parse(readFileSync(markerPath as string, 'utf8')) as { runId: string };
  let stepZeroCalls = 0;
  let laterStepCalls = 0;
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => {
          if (step === 0) stepZeroCalls += 1;
          else laterStepCalls += 1;
          return { content: `relaunched step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    durable: true,
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });
  const report = await bureau.recovery();
  await pollUntil('the relaunched run to reach a terminal status', async () => {
    const durable = await bureau.tasks.workflow(runId);
    if (durable !== null && durable !== undefined && TERMINAL_STATUSES.has(durable.status)) {
      return true;
    }
    await bureau.maintain();
    return false;
  });
  const durable = await bureau.tasks.workflow(runId);
  if (durable?.status !== 'completed') {
    // A run that ended any other way will never complete, so say how it ended
    // now rather than leaving the parent to wait out its deadline.
    process.stderr.write(
      `child: the relaunched run ended ${durable?.status}: ${durable?.error ?? 'no error'}\n`,
    );
    process.exit(5);
  }
  publishChildFile(
    join(dirname(markerPath as string), 'relaunched.json'),
    JSON.stringify({
      runId,
      recoveryOutcome: report?.outcome,
      durableStatus: durable?.status,
      runStatus: bureau.tasks.detail(runId)?.status,
      stepZeroCalls,
      laterStepCalls,
    }),
  );
  const shutdown = await bureau.shutdown();
  process.exit(shutdown.unresolved === 0 ? 0 : 1);
}

/**
 * COR-1390: the second of the two racing successors after `park-after-step-0`
 * died, run here so the test's own process holds the only other handle on the
 * store (COR-1795). Opens the store, says it is ready, and boots its Bureau
 * when the parent says go, at the moment the parent boots the other racer.
 * Writes what it observed once the run has settled, then shuts down.
 */
async function raceRecover(): Promise<void> {
  const directory = dirname(markerPath as string);
  const { runId } = JSON.parse(readFileSync(markerPath as string, 'utf8')) as { runId: string };
  const storage =
    backend === 'lmdb' ? new LMDBStorage(storagePath as string) : new BunSQLiteStorage(storagePath);
  publishChildFile(join(directory, RACER_READY_FILE), '');
  await pollUntil('the parent to start the race', () => existsSync(join(directory, RACER_GO_FILE)));
  const racer = await startRacer(storage);
  const report = await settleRacer(racer, runId);
  publishChildFile(join(directory, RACER_REPORT_FILE), JSON.stringify(report));
  const shutdown = await racer.bureau.shutdown();
  process.exit(shutdown.unresolved === 0 ? 0 : 1);
}

/** COR-1391: a non-crashing boot over the recovered, shut-down store. */
async function verify(): Promise<void> {
  const directory = dirname(markerPath as string);
  const { cache, close } = await openIdempotencyCache(directory);
  const governed = await openGovernedMemory(directory);
  const bureau = await createHarnessBureau({
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    generate: async () => ({ content: 'verify', toolCalls: [] }),
    toolbox: createChargeToolbox(directory, async () => 'ok', { cache, wrap: true }),
    memory: governed.memory,
  });
  const report = await bureau.recovery();
  const runningRuns = await bureau.tasks.workflows({ status: 'running' });
  const running = runningRuns?.items.length;
  writeMarker({ recoveryOutcome: report?.outcome, running });
  await bureau.shutdown();
  await governed.close();
  await close();
  process.exit(0);
}

/**
 * COR-1717: approves a gated tool call and dies inside the approved tool's body, after the
 * resolution-started marker is durable and before the decision commits. The tool has appended its
 * one line by then.
 */
async function approveThenCrash(): Promise<void> {
  const directory = dirname(markerPath as string);
  let calls = 0;
  const bureau = await createHarnessBureau({
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    generate: async () => {
      calls += 1;
      return {
        content: '',
        toolCalls: calls === 1 ? [{ id: 'append-call', name: 'append-line', arguments: {} }] : [],
      };
    },
    toolbox: createInterruptedApprovalToolbox(directory, () => {
      writeMarker({ reviewId });
      killSelf();
    }),
  });
  const run = await bureau.tasks.start('default', 'crash harness approval', { principal: 'alice' });
  await pollUntil('the run to surface its tool-approval review', () =>
    bureau.reviews.list().some((review) => review.runId === run.id),
  );
  const review = bureau.reviews.list().find((candidate) => candidate.runId === run.id);
  reviewId = review?.id;
  await bureau.reviews.resolve({
    id: reviewId as string,
    decision: 'approve',
    principal: 'operator',
  });
  // The tool body kills the process, so a resolution that returns is a failure of the scenario.
  process.stderr.write('child: the approved tool did not end the process\n');
  process.exit(6);
}

/** COR-2051: journals a peer task, then dies while the approved peer call is in flight. */
async function childWaitParked(): Promise<void> {
  const childWaitCallId = 'parent-child-wait-call';
  const siblingCallId = 'parent-sibling-call';
  const parentReady = Promise.withResolvers<void>();
  const allowParent = Promise.withResolvers<void>();
  let parentId: string | undefined;
  let durableEngine: {
    get(runId: string): Promise<{ waitingForSignals?: readonly string[] } | null>;
  };
  const waitForChild = createTool({
    name: 'wait-for-child',
    description: 'Wait for the named child.',
    input: z.object({ childRunId: z.string() }),
    metadata: { durableChildWait: true },
    execute: async ({ childRunId }, context) => {
      const wait = context.executionContext?.['durableChildWait'];
      if (typeof wait !== 'function') throw new Error('missing durable child wait');
      return wait({ childRunId, toolCallId: context.meta?.callId ?? context.toolCall.id });
    },
  });
  const siblingAction = createTool({
    name: 'sibling-action',
    description: 'A sibling action that must not replay after the park.',
    input: z.object({}),
    execute: async () => {
      publishChildFile(join(dirname(markerPath as string), 'siblingAction'), JSON.stringify('ran'));
      return { action: 'ran-once' };
    },
  });
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      planner: createAgent({
        name: 'planner',
        toolbox: createToolbox([waitForChild, siblingAction]),
        generate: async ({ step }) => {
          if (step === 0) {
            parentReady.resolve();
            await allowParent.promise;
            return {
              content: 'waiting',
              toolCalls: [
                {
                  id: childWaitCallId,
                  name: 'wait-for-child',
                  arguments: { childRunId: 'child-1' },
                },
                { id: siblingCallId, name: 'sibling-action', arguments: {} },
              ],
            };
          }
          return { content: 'recovered', toolCalls: [] };
        },
        stopWhen: stopWhen.noToolCalls(),
      }),
      worker: createAgent({
        name: 'worker',
        generate: async () => {
          const signalName = `durable-child:${parentId}:child-1`;
          let observed = false;
          await pollUntil('parent durable child wait', async () => {
            if (parentId === undefined) return false;
            const state = await durableEngine?.get(parentId);
            const waiting = state?.waitingForSignals?.includes(signalName) === true;
            if (waiting && !observed) {
              observed = true;
              publishChildFile(join(dirname(markerPath as string), 'workerGate'), 'observed');
            }
            return waiting;
          });
          return { content: 'child done', toolCalls: [] };
        },
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    durable: true,
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });
  const parent = await bureau.tasks.start('planner', 'wait for child', { principal: 'alice' });
  const engine = bureau.durableEngine();
  if (engine === undefined) throw new Error('child: durable engine unavailable');
  parentId = parent.id;
  durableEngine = engine;
  const signalTarget = engine as {
    signal: (runId: string, signalName: string, payload?: unknown) => Promise<void>;
  };
  const parentSignal = signalTarget.signal.bind(engine);
  spyOn(signalTarget, 'signal').mockImplementation(async (runId, signalName, payload) => {
    if (runId === parent.id && signalName === `durable-child:${parent.id}:child-1`) {
      const directory = dirname(markerPath as string);
      const childRecord = await bureau.children.get({
        parentRunId: parent.id,
        childRunId: 'child-1',
      });
      const parentState = await engine.get(parent.id);
      const wakeName = `durable-child:${parent.id}:child-1`;
      if (
        childRecord?.status !== 'completed' ||
        parentState?.waitingForSignals?.includes(wakeName) !== true
      ) {
        throw new Error(
          `child: wake barrier was not durable: ${JSON.stringify({ childRecord, parentState })}`,
        );
      }
      publishChildFile(
        join(directory, 'afterChildSettlementBeforeParentWake'),
        JSON.stringify({ childRecord, parentWaitingForSignals: parentState.waitingForSignals }),
      );
      if (!existsSync(join(directory, 'workerGate'))) {
        throw new Error('child: worker completed before the durable parent wait was visible');
      }
      killSelf();
    }
    return parentSignal(runId, signalName, payload);
  });
  await parentReady.promise;
  const child = await bureau.children.dispatch({
    parentRunId: parent.id,
    childRunId: 'child-1',
    agentName: 'worker',
    input: 'work',
  });
  if (child.outcome !== 'started') throw new Error(`child did not start: ${child.outcome}`);
  publishChildFile(
    markerPath as string,
    JSON.stringify({ runId: parent.id, childRunId: 'child-1', contextId: parent.contextId }),
  );
  allowParent.resolve();
  await pollUntil('parent park', async () => {
    const workflow = await bureau.tasks.workflow(parent.id);
    return workflow?.status === 'running';
  });
  await pollUntil('child terminal record', async () => {
    const childRecord = await bureau.children.get({
      parentRunId: parent.id,
      childRunId: 'child-1',
    });
    return childRecord?.status === 'completed';
  });
}

async function peerApprovalThenCrash(): Promise<void> {
  let bureau: Awaited<ReturnType<typeof createHarnessBureau>> | undefined;
  const toolbox = createPeerApprovalToolbox(async () => {
    if (variant === 'invalid-binding' && bureau?.internals.sessionStore !== undefined) {
      await bureau.internals.sessionStore.update(sessionId, (session) => {
        if (session === undefined) return undefined;
        const pending = session.metadata['pendingApprovalOverrides'];
        if (typeof pending !== 'object' || pending === null || Array.isArray(pending))
          return session;
        const pendingRecords = pending as Record<string, unknown>;
        const approval = pendingRecords[reviewId as string];
        if (typeof approval !== 'object' || approval === null || Array.isArray(approval))
          return session;
        return {
          ...session,
          metadata: {
            ...session.metadata,
            pendingApprovalOverrides: JSON.parse(
              JSON.stringify({
                ...pendingRecords,
                [reviewId as string]: { ...approval, approvalToken: 'invalid' },
              }),
            ),
          },
        };
      });
    }
    killSelf();
  });
  const tool = toolbox.tools().find((candidate) => candidate.name === 'ask-peer');
  if (tool === undefined) {
    process.stderr.write('child: peer tool was not registered\n');
    process.exit(4);
  }
  const revision = tool.id;
  bureau = await createHarnessBureau({
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    generate: async () => ({
      content: '',
      toolCalls: [{ id: 'peer-call', name: 'ask-peer', arguments: { message: 'hello peer' } }],
    }),
    toolbox,
    recoverableStartedApprovals: new Map([
      [revision, { version: 1, attach: async () => undefined }],
    ]),
  });
  const run = await bureau.tasks.start('default', 'crash harness peer approval', {
    principal: 'alice',
    requestContext: requestContext(),
  });
  await pollUntil('the peer approval review', () =>
    bureau.reviews.list().some((review) => review.runId === run.id),
  );
  const review = bureau.reviews.list().find((candidate) => candidate.runId === run.id);
  if (review?.kind !== 'tool-approval') {
    process.stderr.write('child: peer approval review was not found\n');
    process.exit(4);
  }
  const sessionId = run.contextId;
  reviewId = review.id;
  const operationKey = `approval-resume:v1:${review.id}`;
  if (variant !== 'missing-journal') {
    await bureau.peerCalls.write(
      { parentRunId: run.id, operationKey },
      {
        taskId: 'peer-task-1',
        contextId: 'peer-context-1',
        requestDigest: variant === 'invalid-journal' ? 'not-a-digest' : 'a'.repeat(64),
      },
    );
  }
  if (variant === 'before-marker') killSelf();
  writeMarker({ runId: run.id, sessionId: run.contextId, reviewId: review.id, revision });
  await bureau.reviews.resolve({
    id: review.id,
    decision: 'approve',
    principal: 'operator',
    arguments: { message: 'hello peer' },
  });
  process.stderr.write('child: the peer tool did not end the process\n');
  process.exit(6);
}

/** COR-2051: a recovery process dies immediately after the trusted peer adapter is entered. */
async function peerRecoveryAttachThenCrash(): Promise<void> {
  const marker = JSON.parse(readFileSync(markerPath as string, 'utf8')) as {
    revision: string;
  };
  const toolbox = createPeerApprovalToolbox();
  const bureau = await createHarnessBureau({
    storage:
      backend === 'lmdb'
        ? new LMDBStorage(storagePath as string)
        : new BunSQLiteStorage(storagePath),
    generate: async () => ({ content: 'recovered', toolCalls: [] }),
    toolbox,
    recoverableStartedApprovals: new Map([
      [marker.revision, { version: 1, attach: async () => killSelf() }],
    ]),
  });
  await bureau.recovery();
  process.stderr.write('child: peer recovery attach did not end the process\n');
  process.exit(6);
}

/** COR-2051: kill after the session commit, before the decision record's recorded=true CAS. */
async function peerRecoveryPostCommitThenCrash(): Promise<void> {
  const marker = JSON.parse(readFileSync(markerPath as string, 'utf8')) as {
    sessionId: string;
    reviewId: string;
    revision: string;
  };
  const storage =
    backend === 'lmdb' ? new LMDBStorage(storagePath as string) : new BunSQLiteStorage(storagePath);
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const independentSessions = createSessionStore(kv);
  const decisionKey = reviewDecisionKey(marker.reviewId, 0);
  const originalConditionalBatch = storage.conditionalBatch?.bind(storage);
  if (originalConditionalBatch === undefined) process.exit(4);
  storage.conditionalBatch = async (conditions, operations) => {
    const decisionWrite = operations.some(
      (operation) =>
        operation.type === 'put' &&
        operation.key === decisionKey &&
        new TextDecoder().decode(operation.value).includes('"recorded":true'),
    );
    if (decisionWrite) {
      const session = await independentSessions.load(marker.sessionId);
      const rawDecision = await kv.get(decisionKey);
      const resolved = session?.metadata['resolvedReviewIds'];
      if (Array.isArray(resolved) && resolved.includes(marker.reviewId) && rawDecision !== null) {
        appendFileSync(`${markerPath}.postcommit`, `${rawDecision}\n`, 'utf8');
        killSelf();
      }
    }
    return originalConditionalBatch(conditions, operations);
  };
  const bureau = await createHarnessBureau({
    storage,
    generate: async () => ({ content: 'recovered', toolCalls: [] }),
    toolbox: createPeerApprovalToolbox(),
    recoverableStartedApprovals: new Map([
      [
        marker.revision,
        {
          version: 1,
          attach: async (input) => ({
            callId: input.callId,
            toolCallId: input.callId,
            toolName: 'ask-peer',
            outcome: 'success' as const,
            content: 'peer answer',
            result: 'peer answer',
          }),
        },
      ],
    ]),
  });
  await bureau.recovery();
  process.exit(6);
}

let reviewId: string | undefined;

const scenarios: Record<string, () => Promise<void>> = {
  'park-after-step-0': parkAfterStepZero,
  'charge-then-crash': chargeThenCrash,
  'memory-write-then-crash': memoryWriteThenCrash,
  'two-parked-runs': twoParkedRuns,
  'human-wait-parked': () => humanWaitParked(),
  'human-wait-two-calls-parked': () => humanWaitParked(true),
  'approve-then-crash': approveThenCrash,
  'child-wait-parked': childWaitParked,
  'peer-approval-then-crash': peerApprovalThenCrash,
  'peer-recovery-attach-then-crash': peerRecoveryAttachThenCrash,
  'peer-recovery-post-commit-then-crash': peerRecoveryPostCommitThenCrash,
  'relaunch-recover': relaunchRecover,
  'race-recover': raceRecover,
  verify,
};

const scenario = scenarios[scenarioName];
if (scenario === undefined) {
  process.stderr.write(`child: unknown scenario "${scenarioName}"\n`);
  process.exit(2);
}

await scenario();

// No `bureau.dispose()` / `shutdown()`, deliberately.
process.kill(process.pid, 'SIGKILL');
