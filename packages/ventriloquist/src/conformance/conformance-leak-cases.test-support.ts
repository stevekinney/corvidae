import { awakeTurns } from '@lostgradient/testing/wait-until';
import { BEHAVIOR_CASES, runCell, type CellResult } from './conformance-cases.test-support.ts';
import {
  check,
  openDescriptorCount,
  type ProcessMode,
  type TransportPath,
} from './conformance.test-support.ts';

const SESSIONS_MEASURED = 6;
const BASELINE_SAMPLES = 5;

/**
 * The lowest descriptor count over several event-loop turns. A descriptor still being released when
 * the baseline is read would raise it, and one leaked afterwards could then hide behind that
 * excess, so the baseline is the minimum the process settles to, not a single reading.
 */
export async function stableDescriptorBaseline(): Promise<number> {
  let lowest = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < BASELINE_SAMPLES; sample += 1) {
    await Bun.sleep(0);
    lowest = Math.min(lowest, openDescriptorCount());
  }
  return lowest;
}

/**
 * Event-loop turns until the descriptor count is back at `baseline`. A socket's descriptor is
 * closed by a native thread after the JavaScript close event, so the count can still be one high on
 * the turn a session ends, and no event announces the release; the wait ends when the count drops,
 * or on the hang guard, which is a leak. A caller that is proving the wait cannot hide a descriptor
 * that is held passes `maximumTurns`, because that descriptor is never released.
 */
export async function settledDescriptorCount(
  baseline: number,
  maximumTurns?: number,
): Promise<{ count: number; turns: number }> {
  let turns = 0;
  let count = openDescriptorCount();
  // load-proof: the caller that passes maximumTurns holds the descriptor, so it is never released
  for await (const _turn of awakeTurns()) {
    await Bun.sleep(0);
    count = openDescriptorCount();
    turns += 1;
    if (count <= baseline || (maximumTurns !== undefined && turns >= maximumTurns)) break;
  }
  return { count, turns };
}

/**
 * Descriptors held by this process before and after a run of complete sessions. One session runs
 * first, off the books, so lazily created singletons are not counted as a leak; every session
 * after it opens and closes a process, its pipes or terminal, and (on the WebSocket path) a
 * socket on each side, and the count must come back to where it started.
 */
export async function descriptorStability(
  path: TransportPath,
  mode: ProcessMode,
  scratch: string,
): Promise<CellResult> {
  const stop = BEHAVIOR_CASES.find((definition) => definition.id === 'client-stop');
  if (stop === undefined) throw new Error('the client-stop case is the leak probe and must exist');
  await runCell(stop, path, mode, scratch);
  const before = await stableDescriptorBaseline();
  let failedChecks = 0;
  for (let session = 0; session < SESSIONS_MEASURED; session += 1) {
    const result = await runCell(stop, path, mode, scratch);
    failedChecks += result.checks.filter((entry) => !entry.ok).length;
  }
  const { count: after, turns } = await settledDescriptorCount(before);
  return {
    checks: [
      check(`${SESSIONS_MEASURED} sessions each ended with complete cleanup`, failedChecks === 0),
      check(
        `descriptors returned to the starting count (${before} before, ${after} after, settled in ${turns} turns)`,
        after <= before,
      ),
    ],
    signature: [],
  };
}
