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

/** A park one step's results hold: the signal it waits on, and the prompt it asked with. */
export type HumanWaitPark = {
  readonly signalName: string;
  readonly prompt: string | undefined;
};

/**
 * The parks one step's results hold, in order, counted by the rule above: consecutive parked
 * results on one signal are one park, and its prompt is the first result's. The one place that rule
 * is written, so a count of parks, the ordinal a park's review id carries and the prompt a rebuilt
 * review shows cannot disagree.
 */
export function humanWaitParks(results: ReadonlyArray<ParkableResult>): HumanWaitPark[] {
  const parks: HumanWaitPark[] = [];
  let previous: string | undefined;
  for (const result of results) {
    const signalName = parkedSignalName(result);
    if (signalName === undefined) continue;
    if (previous !== signalName) {
      const value = result.result as { prompt?: unknown };
      parks.push({
        signalName,
        prompt: typeof value.prompt === 'string' ? value.prompt : undefined,
      });
    }
    previous = signalName;
  }
  return parks;
}

/** The signal name of each park one step's results hold, in order (see {@link humanWaitParks}). */
export function humanWaitParkSignalNames(results: ReadonlyArray<ParkableResult>): string[] {
  return humanWaitParks(results).map((park) => park.signalName);
}

/** The parks one step's results hold, counted by the rule above. */
export function countHumanWaitParks(results: ReadonlyArray<ParkableResult>): number {
  return humanWaitParks(results).length;
}
