/**
 * When a run has really finished, for task retention (COR-1477).
 *
 * `run.error` is not the end of a run: Operative marks the run `error` when it
 * dispatches that event and then dispatches `run.completed`, which carries the
 * finish reason and is what Bureau's terminal listeners wait for. A run
 * between the two reports a terminal status and holds a terminal action, yet is
 * still finishing, so retention reads only the actions that close a run:
 * `run.completed` and `run.aborted`.
 *
 * COR-424's run-creation binding measures its window from the earlier
 * `run.error` and keeps doing so; a binding outlasting a few milliseconds of
 * wind-down is harmless, whereas deleting a run that is still finishing is not.
 *
 * @module run-settlement
 */

/** The actions that close a run for good. */
const SETTLING_RUN_ACTION_TYPES: ReadonlySet<string> = new Set(['run.completed', 'run.aborted']);

/**
 * The runtime-clock timestamp at which the run's last closing action was
 * recorded, or `undefined` while the run has recorded none (still running,
 * still finishing after `run.error`, or abandoned there by a crash).
 */
export function settledActionTimestamp(
  actions: readonly { readonly type: string; readonly timestamp: number }[],
): number | undefined {
  return actions.findLast((action) => SETTLING_RUN_ACTION_TYPES.has(action.type))?.timestamp;
}

/** Whether an action of this type closes a run for good. */
export function isSettlingRunAction(type: string): boolean {
  return SETTLING_RUN_ACTION_TYPES.has(type);
}
