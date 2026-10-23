/**
 * COR-1631 — how a Bureau builds its interactive surfaces: over the storage
 * its durable history writes to, reading each task from its task registry and
 * freezing a task's surfaces as the registry records its settlement.
 */
import type { Storage } from '@lostgradient/weft';

import type { DurableEventHistory } from '../durable-event-history';
import { serializeUnknownError } from '../serialization';
import type { TaskRegistry } from '../task-registry';
import type { DiagnosticSink } from '../types';
import { createInteractiveSurfaces, type InteractiveSurfaces } from './store';

/** What {@link createBureauInteractiveSurfaces} reads from the Bureau it serves. */
export interface BureauInteractiveSurfacesOptions {
  /** The Bureau's persistent durable storage, or `undefined` when it has none. */
  readonly storage: Storage | undefined;
  /** The Bureau's durable history, or `undefined` when it keeps none. */
  readonly history: DurableEventHistory | undefined;
  readonly tasks: Pick<TaskRegistry, 'get' | 'onSettled'>;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly diagnose: DiagnosticSink;
  /** The ids of the reviews a task holds open: the authority on review ownership. */
  readonly reviewIdsOf: (taskId: string) => Promise<ReadonlySet<string>>;
}

/**
 * The Bureau's interactive surfaces, or `undefined` for a Bureau with no
 * durable history: a surface lives in its task's history, so without one
 * there is nowhere to keep it.
 */
export function createBureauInteractiveSurfaces(
  options: BureauInteractiveSurfacesOptions,
): InteractiveSurfaces | undefined {
  const { storage, history, tasks, diagnose } = options;
  if (storage === undefined || history === undefined) return undefined;
  return createInteractiveSurfaces({
    storage,
    history,
    task: async (taskId) => {
      // One snapshot: the view carries the owner, the session, and liveness. A
      // task whose run ended with a review still open reads as `input-required`,
      // not settled, so its surfaces stay live until the review closes.
      const view = await tasks.get(taskId);
      if (view === undefined) return undefined;
      const status = view.status;
      const settled =
        status === 'completed' || status === 'failed' || status === 'canceled' ? status : undefined;
      return {
        owner: view.owner,
        settled,
        contextId: view.contextId,
        generation: view.createdAt,
      };
    },
    now: options.now,
    reviewIdsOf: options.reviewIdsOf,
    watchTask: (taskId, listener) => {
      tasks.onSettled(taskId, (_view, record) => {
        if (record.settled !== undefined) listener(record.settled.status);
      });
    },
    onFreezeError: (taskId, error) =>
      diagnose({
        level: 'error',
        scope: 'interactive-surfaces',
        message: `[bureau] Could not freeze the surfaces of task "${taskId}": ${serializeUnknownError(error)}`,
        cause: error,
      }),
  });
}
