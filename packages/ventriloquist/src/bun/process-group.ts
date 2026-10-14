import type { CleanupOutcome } from '../protocol/messages.ts';
import type { CancelTimer, SessionClock } from '../session/session-clock.ts';

/** The operations on a process group that the helpers need, so cleanup can be driven without real signals. */
export type ProcessGroupOperations = {
  /** Signal every member of the group. A group that is already gone is not an error. */
  signal(group: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /**
   * Whether any member remains. A group this process may not signal still exists. It may need to
   * look at the process table, so it can be asynchronous.
   */
  exists(group: number): boolean | Promise<boolean>;
};

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/** The process state letters `ps` reports for the members of one process group, one string per member. */
export type GroupMemberStates = readonly string[];

const MEMBER_STATE_COMMAND = ['ps', '-A', '-o', 'pgid=,stat='];

/**
 * Read `pgid stat` rows, as `ps -A -o pgid=,stat=` prints them, and collect the states of the
 * members of `group`. A row that is not a group and a state fails the read.
 */
export function parseGroupMemberStates(text: string, group: number): GroupMemberStates {
  const states: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const fields = line.trim().split(/\s+/);
    const row = Number(fields[0]);
    if (fields.length !== 2 || !Number.isSafeInteger(row)) {
      throw new Error(`unreadable process state row: ${JSON.stringify(line)}`);
    }
    if (row === group) states.push(fields[1] as string);
  }
  return states;
}

/**
 * Read the state of every member of `group` with `ps`, or with `command` when a test supplies a
 * stand-in; `undefined` when the table cannot be read. The read is asynchronous, so a slow process
 * table never holds up the event loop other sessions share.
 */
export async function readGroupMemberStates(
  group: number,
  command: readonly string[] = MEMBER_STATE_COMMAND,
): Promise<GroupMemberStates | undefined> {
  try {
    const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const [text, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exitCode === 0 ? parseGroupMemberStates(text, group) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signal and probe process groups with `process.kill`, whose negative pid addresses the whole
 * group. A group counts as present only while it has a member that is not a zombie: a zombie is
 * already dead and only waits for its parent to reap it, which a container's init may never do, so
 * `kill(-group, 0)` keeps succeeding for a group that nothing can still run in. `readStates` is how
 * the members are inspected; a state that cannot be read leaves the group present.
 */
export function createProcessGroupOperations(
  readStates: (
    group: number,
  ) => GroupMemberStates | undefined | Promise<GroupMemberStates | undefined>,
): ProcessGroupOperations {
  return {
    signal(group, signal) {
      try {
        process.kill(-group, signal);
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') throw error;
      }
    },
    async exists(group) {
      try {
        process.kill(-group, 0);
      } catch (error) {
        // A group this process may not signal still exists; only ESRCH says it does not.
        if (errorCode(error) === 'ESRCH') return false;
      }
      const states = await readStates(group);
      return states === undefined || states.some((state) => !state.startsWith('Z'));
    },
  };
}

export const processGroupOperations: ProcessGroupOperations = createProcessGroupOperations(
  (group) => readGroupMemberStates(group),
);

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
    let settled = false;
    let cancelPoll: CancelTimer | undefined;
    const settle = (empty: boolean): void => {
      if (settled) return;
      settled = true;
      cancelPoll?.();
      cancelDeadline();
      resolve(empty);
    };
    const cancelDeadline = clock.schedule(() => {
      cancelPoll?.();
      void (async () => settle(!(await operations.exists(group))))();
    }, milliseconds);
    const poll = (): void => {
      void (async () => {
        const present = await operations.exists(group);
        if (settled) return;
        if (present) cancelPoll = clock.schedule(poll, pollMilliseconds);
        else settle(true);
      })();
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
