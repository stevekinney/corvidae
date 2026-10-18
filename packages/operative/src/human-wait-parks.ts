/**
 * How many human-wait parks a step's tool results hold.
 *
 * A run's parks are numbered from zero across the run, and that number is the one
 * ordinal both sides of the AG-UI mount name a park by: the review a park lists
 * carries it in its id (`human-wait:<runId>:<signalName>:<ordinal>`), and the row its
 * answer appends is `<runId>:signal:<signalName>:<ordinal>`. There is one rule for
 * counting, here, and Bureau reads it from here: consecutive parked
 * `requestHumanInput` results of one step under the same signal name are one park,
 * and a different signal name starts the next.
 *
 * @module human-wait-parks
 */

type ParkableResult = { readonly toolName?: string | undefined; readonly result?: unknown };

/** The signal name a parked `requestHumanInput` result waits on, or `undefined` if it is not one. */
export function parkedSignalName(result: ParkableResult): string | undefined {
  if (result.toolName !== 'requestHumanInput') return undefined;
  const value = result.result;
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { parked?: unknown; signalName?: unknown };
  return candidate.parked === true && typeof candidate.signalName === 'string'
    ? candidate.signalName
    : undefined;
}

/** The parks one step's results hold, counted by the rule above. */
export function countHumanWaitParks(results: ReadonlyArray<ParkableResult>): number {
  let count = 0;
  let previous: string | undefined;
  for (const result of results) {
    const signalName = parkedSignalName(result);
    if (signalName === undefined) continue;
    if (previous !== signalName) count += 1;
    previous = signalName;
  }
  return count;
}
