/**
 * The durable batch a scheduled occurrence commits with its start (COR-1408).
 *
 * `startScheduledRun` builds the operations that belong to the occurrence (its schedule-run
 * metadata and links, its terminal-cleanup marker, the `workflowHasServices` marker when a
 * services resolution happened, and the schedule state and settled-run delete the caller folds
 * in) and hands them to `startWorkflow`, which commits them in the same batch as the workflow
 * record. Which launch holds an occurrence's services and cleanup membership in memory is a
 * separate matter from that batch, and moving it must not change what is written: a fresh
 * process recovering the run tells "never had services" from "had services" by the marker, and
 * finds the cleanup sweep it owes by the cleanup key.
 *
 * The expected lists below are the operations `startScheduledRun` committed on main (244ef383),
 * in order, before the occurrence's transient state moved into `startWorkflow`. This file does not
 * import anything the pull request added, so it passes unchanged against that commit as well.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  workflow,
  type EngineOptions,
  type ScheduleState,
  type WorkflowContext,
} from '../types.ts';
import { createScheduleCallbacks } from './callback-creators-schedule.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { startScheduledRun } from './schedule-run.ts';

const WORKFLOW_ID = 'batch-run';
const SCHEDULE_ID = 'batch-schedule';
const FIXED_NOW = 1_700_000_000_000;

/** How the services resolver answers: with a value, as unavailable, or not at all (no resolver). */
type Resolution = 'available' | 'unavailable' | 'none';

const RESOLUTIONS: readonly Resolution[] = ['available', 'unavailable', 'none'];

const RESOLUTION_LABELS: Record<Resolution, string> = {
  available: 'available services',
  unavailable: 'unavailable services',
  none: 'no resolver',
};

function createScheduleState(overrides: Partial<ScheduleState> = {}): ScheduleState {
  return {
    id: SCHEDULE_ID,
    workflowType: WORKFLOW_ID,
    input: null,
    intervalMs: 60_000,
    status: 'paused',
    overlap: 'skip',
    backfill: false,
    revisionPolicy: 'active-at-fire',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: null,
    queuedRuns: [],
    ...overrides,
  };
}

/** The operations every start batch for the id carries ahead of the occurrence's own. */
const WORKFLOW_RECORD_OPERATIONS = [
  `put ${KEYS.workflow(WORKFLOW_ID)}`,
  `put ${KEYS.checkpoint(WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityCreated(FIXED_NOW, WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityStatus('running', WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityType(WORKFLOW_ID, WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityUpdated(FIXED_NOW, WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityManifest(WORKFLOW_ID)}`,
];

/** The operations `buildScheduleRunOperations` produces for an occurrence with no folded-in extras. */
const OCCURRENCE_OPERATIONS = [
  `put ${KEYS.scheduleRun(WORKFLOW_ID)}`,
  `put ${KEYS.scheduleRunLink(WORKFLOW_ID)}`,
  `put ${KEYS.scheduleRunBySchedule(SCHEDULE_ID, WORKFLOW_ID)}`,
  `put ${KEYS.terminalCleanupNeeded(WORKFLOW_ID)}`,
];

const FOLDED_IN_OPERATIONS = [
  `put ${KEYS.schedule(SCHEDULE_ID)}`,
  `delete ${KEYS.scheduleRun('prior-run')}`,
];

const SERVICES_MARKER = `put ${KEYS.workflowHasServices(WORKFLOW_ID)}`;

function expectedBatch(resolution: Resolution, foldedIn: boolean): string[] {
  return [
    ...WORKFLOW_RECORD_OPERATIONS,
    ...OCCURRENCE_OPERATIONS,
    ...(foldedIn ? FOLDED_IN_OPERATIONS : []),
    // Written for every resolution that was attempted, available or not, and last.
    ...(resolution === 'none' ? [] : [SERVICES_MARKER]),
  ];
}

function describeOperation(operation: BatchOperation): string {
  return `${operation.type} ${operation.key}`;
}

/** Launch one occurrence and return the operations of the batch that committed its start. */
async function captureStartBatch(
  resolution: Resolution,
  foldedIn: boolean,
): Promise<readonly BatchOperation[]> {
  const storage = new MemoryStorage();
  const resolveWorkflowServices: EngineOptions['resolveWorkflowServices'] | undefined =
    resolution === 'none'
      ? undefined
      : () =>
          resolution === 'available'
            ? { status: 'available', services: { owner: 'the occurrence' } }
            : { status: 'unavailable', reason: 'no services for this occurrence' };
  const engine = await Engine.create({
    storage,
    recover: false,
    getNow: () => FIXED_NOW,
    ...(resolveWorkflowServices === undefined ? {} : { resolveWorkflowServices }),
  });
  engine.register(
    workflow({ name: WORKFLOW_ID }).execute(async function* (context: WorkflowContext) {
      return yield* context.waitForSignal<string>('go');
    }),
  );
  const internals = getInternals(engine);
  const batches: BatchOperation[][] = [];
  internals.storage = new Proxy(storage, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      if (property === 'batch' || property === 'conditionalBatch') {
        return (...argumentsList: unknown[]) => {
          batches.push(
            (property === 'batch' ? argumentsList[0] : argumentsList[1]) as BatchOperation[],
          );
          return original.apply(target, argumentsList);
        };
      }
      return original.bind(target);
    },
  });
  try {
    const schedule = createScheduleState();
    await startScheduledRun(internals, schedule, createScheduleCallbacks(engine), {
      workflowId: WORKFLOW_ID,
      occurrence: FIXED_NOW,
      ...(foldedIn
        ? {
            scheduleStateAfterStart: createScheduleState({ updatedAt: FIXED_NOW + 1 }),
            completedWorkflowId: 'prior-run',
          }
        : {}),
    });
    const startBatch = batches.find((operations) =>
      operations.some(
        (operation) => operation.type === 'put' && operation.key === KEYS.scheduleRun(WORKFLOW_ID),
      ),
    );
    if (startBatch === undefined) throw new Error('the occurrence committed no start batch');
    return startBatch;
  } finally {
    internals.storage = storage;
    await engine[Symbol.asyncDispose]();
  }
}

describe('the start batch of a scheduled occurrence', () => {
  for (const resolution of RESOLUTIONS) {
    for (const foldedIn of [false, true]) {
      it(`commits exactly the operations main committed, with ${RESOLUTION_LABELS[resolution]}${
        foldedIn ? ' and the schedule state and settled run folded in' : ''
      }`, async () => {
        const batch = await captureStartBatch(resolution, foldedIn);

        expect(batch.map(describeOperation)).toEqual(expectedBatch(resolution, foldedIn));
      });
    }
  }

  for (const resolution of RESOLUTIONS) {
    it(`writes each occurrence key once, with presence-only markers, with ${RESOLUTION_LABELS[resolution]}`, async () => {
      const batch = await captureStartBatch(resolution, false);

      const keys = batch.map((operation) => operation.key);
      expect(new Set(keys).size).toBe(keys.length);
      const marker = batch.find(
        (operation) => operation.key === KEYS.workflowHasServices(WORKFLOW_ID),
      );
      expect(marker !== undefined).toBe(resolution !== 'none');
      for (const operation of batch) {
        if (
          operation.type === 'put' &&
          (operation.key === KEYS.workflowHasServices(WORKFLOW_ID) ||
            operation.key === KEYS.terminalCleanupNeeded(WORKFLOW_ID))
        ) {
          expect(operation.value.byteLength).toBe(0);
        }
      }
    });
  }
});
