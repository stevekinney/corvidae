/**
 * The test side of a stand-in's PID record: stop every process a stand-in recorded, by PID, and
 * check that none is left. A test calls `reapRecordedProcesses` in a `finally`, so the stand-ins
 * die whatever the test's outcome, including when its body throws or the gate runner that owned
 * them is already dead and can no longer clean up after them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isZombie,
  type ProcessRow,
  readProcessTable,
  waitUntil,
} from '../../../static-playground-processes.ts';

/** Every PID a stand-in recorded as `<record>/<label>.pid`, in label order. */
export function recordedProcessIds(record: string): number[] {
  if (!existsSync(record)) return [];
  const pids: number[] = [];
  for (const name of readdirSync(record).toSorted()) {
    if (!name.endsWith('.pid')) continue;
    const pid = Number(readFileSync(join(record, name), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) pids.push(pid);
  }
  return pids;
}

/**
 * SIGKILL each PID recorded under `record`, and the process group it leads or belongs to unless
 * that is the caller's own. A PID that no longer names a stand-in (it exited and the number was
 * reused) is left alone. Returns the PIDs it found, for `livingProcesses`.
 */
export function reapRecordedProcesses(record: string): number[] {
  const pids = recordedProcessIds(record);
  const table = readProcessTable();
  const ownGroup = table.find((row) => row.pid === process.pid)?.pgid;
  for (const pid of pids) {
    const row = table.find((candidate) => candidate.pid === pid);
    if (row === undefined || isZombie(row) || !row.args.includes('stand-in')) continue;
    if (row.pgid !== ownGroup && row.pgid > 1) kill(-row.pgid);
    kill(pid);
  }
  return pids;
}

/**
 * SIGKILL `target` (a negative one is a group). A target that is already gone is not an error, and
 * neither is one macOS answers with EPERM: it refuses to signal a zombie, and a stand-in that
 * exited between the table read and the kill is one. `waitUntilGone` is the check that it ended.
 */
function kill(target: number): void {
  try {
    process.kill(target, 'SIGKILL');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

/**
 * The rows among `pids` that are still running. A zombie counts as gone unless `requireReaped`,
 * the setting of the Linux `docker run --init` recipe, where a killed process must be reaped too.
 */
export function livingProcesses(pids: readonly number[], requireReaped = false): ProcessRow[] {
  const table = readProcessTable();
  return table.filter((row) => pids.includes(row.pid) && (requireReaped || !isZombie(row)));
}

/** Wait until none of `pids` is running, naming the survivors if the bound passes. */
export async function waitUntilGone(
  pids: readonly number[],
  milliseconds: number,
  requireReaped = false,
): Promise<void> {
  await waitUntil(
    () => livingProcesses(pids, requireReaped).length === 0,
    milliseconds,
    `stand-in processes to exit: ${pids.join(', ')}`,
  );
}
