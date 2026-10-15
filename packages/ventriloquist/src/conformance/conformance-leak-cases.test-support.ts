import { BEHAVIOR_CASES, runCell, type CellResult } from './conformance-cases.test-support.ts';
import {
  check,
  openDescriptorCount,
  type ProcessMode,
  type TransportPath,
} from './conformance.test-support.ts';

const SESSIONS_MEASURED = 6;

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
  const before = openDescriptorCount();
  let failedChecks = 0;
  for (let session = 0; session < SESSIONS_MEASURED; session += 1) {
    const result = await runCell(stop, path, mode, scratch);
    failedChecks += result.checks.filter((entry) => !entry.ok).length;
  }
  const after = openDescriptorCount();
  return {
    checks: [
      check(`${SESSIONS_MEASURED} sessions each ended with complete cleanup`, failedChecks === 0),
      check(
        `descriptors returned to the starting count (${before} before, ${after} after)`,
        after <= before,
      ),
    ],
    signature: [],
  };
}
