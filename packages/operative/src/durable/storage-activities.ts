import { activity } from '@lostgradient/weft';
import type { ConversationSnapshot } from 'conversationalist';

import type { CheckpointStore, SessionInputPromotionWrite } from './checkpoint-store';
import { applyConversationSnapshotDelta, type ConversationSnapshotDelta } from './snapshot-delta';
import type { RunCursor, StepRecord } from './types';

/** Input for the cursor write activity. */
export interface SaveCursorInput {
  runId: string;
  cursor: RunCursor;
}

/**
 * Input for the conversation snapshot write activity: the snapshot whole, or
 * (COR-1376) a delta from the transcript the run last saved.
 */
export type SaveConversationInput = SaveWholeConversationInput | SaveConversationDeltaInput;

/** Saves the run's transcript whole. */
export interface SaveWholeConversationInput {
  runId: string;
  snapshot: ConversationSnapshot;
  delta?: never;
  /** COR-1476 — session inputs this transcript holds, promoted in the same write. */
  promotion?: SessionInputPromotionWrite | undefined;
  /**
   * COR-104 — the steering `getAppliedFloor()` read at the run's first
   * execution. The activity echoes it back as its result, so Weft's positional
   * replay cache carries the first run's value; a history recorded before this
   * field existed cached `undefined` there, which callers read as floor `0`.
   */
  steeringBoundary?: number | undefined;
}

/**
 * Saves the run's transcript as a delta from the transcript the run saved
 * last. Weft keeps every activity input in the run's timeline, so passing the
 * whole snapshot on every step stored the whole conversation once per step.
 */
export interface SaveConversationDeltaInput {
  runId: string;
  delta: ConversationSnapshotDelta;
  snapshot?: never;
  steeringBoundary?: never;
  /** COR-1476 — session inputs this transcript holds, promoted in the same write. */
  promotion?: SessionInputPromotionWrite | undefined;
}

/** Input for the step-record write activity. */
export interface RecordStepInput {
  runId: string;
  record: StepRecord;
}

/**
 * Builds the durable storage WRITE activities over the given {@link CheckpointStore}.
 *
 * These commit run state at checkpoint boundaries so the {@link import('./active-run-create').createDurableActiveRun}
 * adapter can reconstruct the `RunResult` after completion:
 *
 * - `saveCursor` commits the resume position (step + accumulators) every yield,
 * - `saveConversation` / `recordStep` commit the transcript and per-step record.
 *
 * There are deliberately NO read activities. The workflow's own resume position
 * is Weft's checkpointed locals + `ctx.memo` results, NOT a re-read of this store
 * — re-reading via an activity is wrong because Weft caches the activity's first
 * result and replays that stale value on recovery. These writes feed the adapter,
 * not the workflow's resume.
 *
 * All inputs are plain and cloneable — no `Conversation` instance and no closures
 * cross the activity boundary. The store is captured once (it wraps the engine's
 * shared backend), so the activities never need a per-run registry.
 *
 * The return type is inferred so each activity keeps its precise input/output
 * types for `ctx.run` autocompletion in the workflow body.
 */
export function createStorageActivities(checkpointStore: CheckpointStore) {
  return {
    saveCursor: activity({
      name: 'saveCursor',
      idempotent: true,
      execute: async (input: SaveCursorInput): Promise<void> =>
        checkpointStore.saveCursor(input.runId, input.cursor),
    }),

    saveConversation: activity({
      name: 'saveConversation',
      idempotent: true,
      execute: async (input: SaveConversationInput): Promise<number | undefined> => {
        if (input.delta === undefined) {
          await checkpointStore.saveConversation(input.runId, input.snapshot, input.promotion);
          return input.steeringBoundary;
        }
        const saved = await checkpointStore.loadConversation(input.runId, { strict: true });
        // A retry after the write landed finds the delta already applied.
        if (saved?.integrity.digest === input.delta.digest) return undefined;
        if (saved === null) {
          throw new Error(
            `Durable run "${input.runId}" has no saved transcript to apply a conversation delta to.`,
          );
        }
        await checkpointStore.saveConversation(
          input.runId,
          applyConversationSnapshotDelta(saved, input.delta),
          input.promotion,
        );
        return undefined;
      },
    }),

    recordStep: activity({
      name: 'recordStep',
      idempotent: true,
      execute: async (input: RecordStepInput): Promise<void> =>
        checkpointStore.saveStep(input.runId, input.record),
    }),
  };
}
