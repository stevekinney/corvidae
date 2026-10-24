/**
 * How many human-wait parks a step's tool results hold.
 *
 * A run's parks are numbered from zero across the run, and that number is the one
 * ordinal both sides of the AG-UI mount name a park by: the review a park lists
 * carries it in its id (`human-wait:<runId>:<signalName>:<ordinal>`), and the row its
 * answer appends is `<runId>:signal:<signalName>:<ordinal>`. There is one rule for
 * counting, here, and Bureau reads it from here: consecutive parked
 * `requestHumanInput` results of one step under the same signal name are one park,
 * and a different signal name starts the next. A step now parks on at most one request, so a step
 * written since COR-1578 holds at most one park; the rule stays for the checkpoints written before
 * it, which can hold several. A refused request is not parked and counts for nothing.
 *
 * @module human-wait-parks
 */

import { type HumanInputSchema, humanInputSchemaOf } from './human-input-schema';

type ParkableResult = { readonly toolName?: string | undefined; readonly result?: unknown };

/** What a parked `requestHumanInput` result holds: the signal it waits on, and the prompt it asked with if any. */
export type ParkedHumanWait = {
  readonly signalName: string;
  readonly prompt?: string | undefined;
  /** The schema the author configured for the signal, when the park carries one. */
  readonly inputSchema?: HumanInputSchema | undefined;
};

/**
 * The park a `requestHumanInput` result holds, or `undefined` if it holds none. A refused request
 * (COR-1578) carries `parked: false` and so can never narrow as parked: this is the one place that
 * decides what a parked result looks like, and the signal name, the park count and a review rebuilt
 * from a checkpoint all read it from here.
 */
export function parkedHumanWait(result: ParkableResult): ParkedHumanWait | undefined {
  if (result.toolName !== 'requestHumanInput') return undefined;
  const value = result.result;
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as {
    parked?: unknown;
    signalName?: unknown;
    prompt?: unknown;
    inputSchema?: unknown;
  };
  if (candidate.parked !== true || typeof candidate.signalName !== 'string') return undefined;
  const inputSchema = humanInputSchemaOf(candidate.inputSchema);
  return {
    signalName: candidate.signalName,
    ...(typeof candidate.prompt === 'string' ? { prompt: candidate.prompt } : {}),
    ...(inputSchema === undefined ? {} : { inputSchema }),
  };
}

/** The signal name a parked `requestHumanInput` result waits on, or `undefined` if it is not one. */
export function parkedSignalName(result: ParkableResult): string | undefined {
  return parkedHumanWait(result)?.signalName;
}

/** A park one step's results hold: the signal it waits on, and the prompt it asked with. */
export type HumanWaitPark = {
  readonly signalName: string;
  readonly prompt: string | undefined;
  readonly inputSchema?: HumanInputSchema | undefined;
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
    const park = parkedHumanWait(result);
    if (park === undefined) continue;
    if (previous !== park.signalName) {
      parks.push({
        signalName: park.signalName,
        prompt: park.prompt,
        ...(park.inputSchema === undefined ? {} : { inputSchema: park.inputSchema }),
      });
    }
    previous = park.signalName;
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

/**
 * A tool result as the model reads it. A parked `requestHumanInput` result carries the schema its
 * author configured so the step record the checkpoint commits can rebuild the wait after a restart
 * (see {@link parkedHumanWait}); the schema is for the form a client renders, so the model's copy
 * leaves it out. Any other result is returned as it is, and the step record keeps the original.
 */
export function modelFacingToolResult<
  Result extends ParkableResult & { readonly content?: unknown },
>(result: Result): Result {
  if (parkedHumanWait(result)?.inputSchema === undefined) return result;
  const withoutSchema = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || !('inputSchema' in value)) return value;
    const { inputSchema: _inputSchema, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  return {
    ...result,
    content: withoutSchema(result.content),
    result: withoutSchema(result.result),
  };
}
