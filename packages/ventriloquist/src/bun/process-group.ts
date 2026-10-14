import type { CleanupOutcome } from '../protocol/messages.ts';
import type { CancelTimer, SessionClock } from '../session/session-clock.ts';

/** The operations on a process group that the helpers need, so cleanup can be driven without real signals. */
export type ProcessGroupOperations = {
  /** Signal every member of the group. A group that is already gone is not an error. */
  signal(group: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Whether any member remains. A group this process may not signal still exists. */
  exists(group: number): boolean;
};

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/** Signal and probe a process group with `process.kill`, whose negative pid addresses the whole group. */
export const processGroupOperations: ProcessGroupOperations = {
  signal(group, signal) {
    try {
      process.kill(-group, signal);
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') throw error;
    }
  },
  exists(group) {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      return errorCode(error) !== 'ESRCH';
    }
  },
};

export type GroupTermination = {
  readonly group: number;
  readonly operations: ProcessGroupOperations;
  readonly clock: SessionClock;
  /** How long a TERM-signaled group may take to empty before it is KILL-signaled. */
  readonly graceMilliseconds: number;
  /** How long a KILL-signaled group may take to empty before it is reported incomplete. */
  readonly observationMilliseconds: number;
  /** How often the group is probed while waiting. */
  readonly pollMilliseconds: number;
};

/** Resolve `true` as soon as the group has no member, or `false` once `milliseconds` have passed. */
function waitForEmpty(termination: GroupTermination, milliseconds: number): Promise<boolean> {
  const { clock, group, operations, pollMilliseconds } = termination;
  return new Promise((resolve) => {
    let cancelPoll: CancelTimer | undefined;
    const cancelDeadline = clock.schedule(() => {
      cancelPoll?.();
      resolve(!operations.exists(group));
    }, milliseconds);
    const poll = (): void => {
      if (operations.exists(group)) {
        cancelPoll = clock.schedule(poll, pollMilliseconds);
        return;
      }
      cancelDeadline();
      resolve(true);
    };
    poll();
  });
}

/**
 * Ask a process group to end, then make it. TERM first, so a well-behaved process can clean up,
 * and KILL once the grace has passed; the group is reported empty only when a probe finds no
 * member. A group that still has members after the KILL window, or that cannot be signaled at all,
 * is `incomplete`: the action was attempted and the observation failed.
 */
export async function terminateProcessGroup(
  termination: GroupTermination,
): Promise<CleanupOutcome> {
  const { group, operations, graceMilliseconds, observationMilliseconds } = termination;
  try {
    operations.signal(group, 'SIGTERM');
    if (await waitForEmpty(termination, graceMilliseconds)) return 'complete';
    operations.signal(group, 'SIGKILL');
  } catch {
    return 'incomplete';
  }
  return (await waitForEmpty(termination, observationMilliseconds)) ? 'complete' : 'incomplete';
}

/** One row of the process table: a process, its parent and its process group. */
export type ProcessRecord = {
  readonly pid: number;
  readonly parentPid: number;
  readonly group: number;
};

/** Read `pid ppid pgid` rows, as `ps -A -o pid=,ppid=,pgid=` prints them. A row that is not three integers fails the read. */
export function parseProcessTable(text: string): ProcessRecord[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const [pid, parentPid, group] = fields.map(Number);
      if (
        fields.length !== 3 ||
        !Number.isSafeInteger(pid) ||
        !Number.isSafeInteger(parentPid) ||
        !Number.isSafeInteger(group)
      ) {
        throw new Error(`unreadable process table row: ${JSON.stringify(line)}`);
      }
      return { pid: pid as number, parentPid: parentPid as number, group: group as number };
    });
}

/**
 * Every descendant of `root` that is not in `group`. These left the owned group, by starting a
 * session or a group of their own, so signaling the group cannot reach them. Descendants are found
 * by walking parent links down from `root`.
 */
export function descendantsOutsideGroup(
  table: readonly ProcessRecord[],
  root: number,
  group: number,
): ProcessRecord[] {
  const childrenOf = new Map<number, ProcessRecord[]>();
  for (const record of table) {
    childrenOf.set(record.parentPid, [...(childrenOf.get(record.parentPid) ?? []), record]);
  }
  const escaped: ProcessRecord[] = [];
  const pending = [root];
  const visited = new Set<number>(pending);
  while (pending.length > 0) {
    for (const child of childrenOf.get(pending.pop() as number) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      if (child.group !== group) escaped.push(child);
      pending.push(child.pid);
    }
  }
  return escaped;
}

const PROCESS_TABLE_COMMAND = ['ps', '-A', '-o', 'pid=,ppid=,pgid='];

/**
 * Read the process table with `ps`, or with `command` when a test supplies a stand-in. A host
 * without a working `ps` cannot be observed, which the caller treats as unknown.
 */
export async function readProcessTable(
  command: readonly string[] = PROCESS_TABLE_COMMAND,
): Promise<ProcessRecord[]> {
  const child = Bun.spawn([...command], {
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  const [text, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`ps exited with ${exitCode}`);
  return parseProcessTable(text);
}
