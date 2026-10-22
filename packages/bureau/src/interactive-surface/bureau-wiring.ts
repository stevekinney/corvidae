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
  readonly tasks: TaskRegistry;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly diagnose: DiagnosticSink;
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
      const record = await tasks.record(taskId);
      if (record === undefined) return undefined;
      return { owner: record.owner, settled: record.settled?.status };
    },
    now: options.now,
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
