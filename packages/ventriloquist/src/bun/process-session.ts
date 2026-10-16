import { dlopen, FFIType } from 'bun:ffi';

import {
  readProcessTable,
  type ProcessGroupOperations,
  type ProcessRecord,
} from './process-group.ts';

/**
 * Whether a process state means the process can no longer run: `Z`, a zombie, which only waits to
 * be reaped and which macOS refuses to signal. Nothing else is assumed gone. macOS also prints `?`
 * (seen as `?NEs`, named like `(bash)`) for processes whose session `getsid` cannot read while
 * `kill(pid, 0)` still succeeds; its `ps(1)` page documents only `I R S T U Z`, so that `?` means
 * "being torn down" could not be established and such a process gets the same second look, and the
 * same scoping, as any other whose session cannot be read.
 */
export function isGone(state: string): boolean {
  return state.startsWith('Z');
}

/**
 * One process as `ps` lists it. `parentPid` and `group` say how it relates to the session being
 * ended; where they are absent the process is treated as possibly related.
 */
export type ProcessState = {
  readonly pid: number;
  readonly state: string;
  readonly parentPid?: number;
  readonly group?: number;
};

/**
 * Read `pid ppid pgid stat` rows, as `ps -A -o pid=,ppid=,pgid=,stat=` prints them. A row that is
 * not three integers and a state fails the read.
 */
export function parseProcessStates(text: string): ProcessState[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const [pid, parentPid, group] = fields.slice(0, 3).map(Number);
      if (
        fields.length !== 4 ||
        !Number.isSafeInteger(pid) ||
        !Number.isSafeInteger(parentPid) ||
        !Number.isSafeInteger(group)
      ) {
        throw new Error(`unreadable process state row: ${JSON.stringify(line)}`);
      }
      return {
        pid: pid as number,
        parentPid: parentPid as number,
        group: group as number,
        state: fields[3] as string,
      };
    });
}

const PROCESS_STATE_COMMAND = ['ps', '-A', '-o', 'pid=,ppid=,pgid=,stat='];

/**
 * Read the state of every process with `ps`, or with `command` when a test supplies a stand-in;
 * `undefined` when the table cannot be read. The read is asynchronous, so a slow process table
 * never holds up the event loop other sessions share.
 */
export async function readProcessStates(
  command: readonly string[] = PROCESS_STATE_COMMAND,
): Promise<ProcessState[] | undefined> {
  try {
    const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const [text, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exitCode === 0 ? parseProcessStates(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session a process belongs to, or `-1` when there is no such process. A process that exists
 * but whose session cannot be read throws: that is not "gone", and nothing may treat it as clean.
 */
export type SessionOf = (pid: number) => number;

/**
 * Build a `SessionOf` over `getsid(2)`, which answers `-1` for every failure. Only ESRCH means the
 * process is gone, so a `-1` is confirmed with signal 0 and anything else is raised.
 */
export function createSessionOf(
  getsid: (pid: number) => number,
  probe: (pid: number, signal: 0) => unknown,
): SessionOf {
  return (pid) => {
    const session = getsid(pid);
    if (session >= 0) return session;
    try {
      probe(pid, 0);
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return -1;
    }
    throw new Error(`the session of process ${pid} could not be read`);
  };
}

let getsid: ((pid: number) => number) | undefined;

/**
 * `getsid(2)` through libc. `ps` cannot be the source of session membership: on macOS its `sess`
 * column is the kernel's session pointer, hidden and printed as `0` for every process, so it
 * names no session at all. `getsid` answers the same way on macOS and Linux, for a process in any
 * session. It is bound on first use, so a host that never ends a PTY never loads it. A zombie
 * answers `-1` on macOS and still exists, so callers filter zombies by state before asking.
 */
export const sessionOfProcess: SessionOf = createSessionOf(
  (pid) => {
    getsid ??= dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
      getsid: { args: [FFIType.i32], returns: FFIType.i32 },
    }).symbols.getsid as (pid: number) => number;
    return getsid(pid);
  },
  (pid, signal) => process.kill(pid, signal),
);

/** A kill the operations can be driven through without real signals. */
export type Kill = (pid: number, signal: NodeJS.Signals) => unknown;

/** What ending a session needs on top of the process-group operations: the courtesy `SIGHUP` to its leader. */
export type SessionOperations = ProcessGroupOperations & {
  /**
   * Hang up the session leader so it can hang up its own jobs. Sends `SIGHUP`, then `SIGCONT` so a
   * stopped leader can act on it, and only to a process that is still the leader of `session`. A
   * leader that is already gone is not an error.
   */
  hangUp(session: number): void;
};

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/** The snapshots of the process table a caller has already taken, so a second look can reuse them. */
type Snapshots = { latest?: ProcessState[] | undefined };

/**
 * What became of a process whose session could not be read: `gone` if it is a zombie or no longer
 * listed, `unknown` if the table cannot be read, otherwise its entry. The last snapshot is reused
 * only if it lists the process; one that does not may simply predate it, so the table is read again.
 */
async function lookAgain(
  pid: number,
  snapshots: Snapshots,
  readStates: () => ProcessState[] | undefined | Promise<ProcessState[] | undefined>,
): Promise<ProcessState | 'gone' | 'unknown'> {
  let entry = snapshots.latest?.find((candidate) => candidate.pid === pid);
  if (entry === undefined) {
    snapshots.latest = await readStates();
    if (snapshots.latest === undefined) return 'unknown';
    entry = snapshots.latest.find((candidate) => candidate.pid === pid);
  }
  return entry === undefined || isGone(entry.state) ? 'gone' : entry;
}

/**
 * Whether a live process whose session is unknown could be a member of `session`: it descends from
 * the leader or from a known member, or it shares a process group with the leader or a member. A
 * process with nothing to do with the session is no concern of its cleanup, however unreadable.
 */
function couldBelongTo(
  suspect: ProcessState,
  table: readonly ProcessState[],
  session: number,
  members: ReadonlySet<number>,
): boolean {
  if (suspect.parentPid === undefined || suspect.group === undefined) return true;
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const groups = new Set([session, ...[...members].map((pid) => byPid.get(pid)?.group)]);
  if (groups.has(suspect.group)) return true;
  const seen = new Set<number>();
  for (let current: ProcessState | undefined = suspect; current !== undefined;) {
    if (seen.has(current.pid)) return false;
    seen.add(current.pid);
    const parent = current.parentPid;
    if (parent === undefined) return true;
    if (parent === session || members.has(parent)) return true;
    current = byPid.get(parent);
  }
  return false;
}

/**
 * How many times one signal pass re-reads the process table looking for members that started while
 * it was signaling. A member forks faster than a pass can read, so the pass is bounded rather than
 * chasing a fork loop forever; the grace and observation windows are what finally report it.
 */
const SIGNAL_PASSES = 4;

/**
 * Signal and probe a whole session. A process group stops at the first `setpgid`, and a shell puts
 * every background job in a group of its own, so ending the shell's group leaves its jobs running;
 * a session holds all of them, because only `setsid` leaves it.
 *
 * `ps` only lists candidates and their states. Nothing is signaled on its word: each candidate's
 * session is read with `sessionOf` immediately before it is signaled, in the same synchronous run,
 * so a process that exited and whose pid was handed to an unrelated process since the listing is
 * never one of the targets. A zombie is gone: it only waits to be reaped and, on macOS, refuses
 * signals. A table that cannot be read leaves the session present, and a signal pass raises.
 */
export function createSessionOperations(dependencies: {
  readonly readStates: () => ProcessState[] | undefined | Promise<ProcessState[] | undefined>;
  readonly sessionOf: SessionOf;
  readonly kill?: Kill;
}): SessionOperations {
  const { readStates, sessionOf } = dependencies;
  const kill: Kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));

  /**
   * The live (non-zombie) members of `session`, or `undefined` when they cannot be read. A process
   * whose session cannot be read is given a second look: one that became a zombie or vanished is
   * gone, and one still live blocks the answer only if it could belong to the session.
   */
  async function liveMembers(session: number): Promise<number[] | undefined> {
    const states = await readStates();
    if (states === undefined) return undefined;
    const snapshots: Snapshots = {};
    const members: number[] = [];
    const unreadable: ProcessState[] = [];
    for (const entry of states) {
      if (isGone(entry.state)) continue;
      try {
        if (sessionOf(entry.pid) === session) members.push(entry.pid);
      } catch {
        const look = await lookAgain(entry.pid, snapshots, readStates);
        if (look === 'unknown') return undefined;
        if (look !== 'gone') unreadable.push(look);
      }
    }
    const known = new Set(members);
    return unreadable.some((suspect) => couldBelongTo(suspect, states, session, known))
      ? undefined
      : members;
  }

  return {
    hangUp(session) {
      try {
        if (sessionOf(session) !== session) return;
        kill(session, 'SIGHUP');
        kill(session, 'SIGCONT');
      } catch (error) {
        // Gone, or a zombie macOS will not signal: there is no leader left to hang up.
        if (errorCode(error) !== 'ESRCH' && errorCode(error) !== 'EPERM') throw error;
      }
    },
    async signal(session, signal) {
      const signaled = new Set<number>();
      const refused: { readonly pid: number; readonly error: unknown }[] = [];
      for (let pass = 0; pass < SIGNAL_PASSES; pass += 1) {
        const members = await liveMembers(session);
        if (members === undefined) throw new Error('the process table could not be read');
        const fresh = members.filter((pid) => !signaled.has(pid));
        if (fresh.length === 0) break;
        for (const pid of fresh) {
          signaled.add(pid);
          // Read and signal with no `await` between them: the window for a reused pid is one call.
          let inSession: boolean;
          try {
            inSession = sessionOf(pid) === session;
          } catch (error) {
            // Neither gone nor readable: the follow-up read below says whether it became a zombie.
            refused.push({ pid, error });
            continue;
          }
          if (!inSession) continue;
          try {
            kill(pid, signal);
            // A stopped process holds a TERM it cannot act on until it is continued.
            if (signal === 'SIGTERM') kill(pid, 'SIGCONT');
          } catch (error) {
            if (errorCode(error) === 'ESRCH') continue;
            if (errorCode(error) !== 'EPERM') throw error;
            refused.push({ pid, error });
          }
        }
      }
      if (refused.length === 0) return;
      // macOS answers EPERM, not ESRCH, for a process that became a zombie meanwhile. That is gone;
      // a live process this one may not signal, or cannot read, is a real refusal.
      const snapshots: Snapshots = {};
      for (const { pid, error } of refused) {
        if ((await lookAgain(pid, snapshots, readStates)) !== 'gone') throw error;
      }
    },
    async exists(session) {
      const members = await liveMembers(session);
      return members === undefined || members.length > 0;
    },
  };
}

export const sessionOperations: SessionOperations = createSessionOperations({
  readStates: () => readProcessStates(),
  sessionOf: sessionOfProcess,
});

/** The `group` of a live process whose session could not be read: no session, so never the one asked about. */
export const UNREADABLE_SESSION = -2;

/**
 * The process table with each process's `group` replaced by its session, so
 * `descendantsOutsideGroup` finds the descendants that left the session the way it finds those
 * that left a group. A process that vanished, or that became a zombie or was torn down between the
 * table and its session being read, is gone and dropped. A process that is still live but whose
 * session cannot be read is kept with `UNREADABLE_SESSION`: as a descendant it counts as one that
 * may have left, so cleanup is `unknown` and never `complete`, and a process that is not a
 * descendant is nobody's concern here, so an unrelated process on a busy host cannot fail it.
 */
export async function readSessionTable(
  sessionOf: SessionOf = sessionOfProcess,
  readTable: () => Promise<ProcessRecord[]> = () => readProcessTable(),
  readStates: () => Promise<ProcessState[] | undefined> = () => readProcessStates(),
): Promise<ProcessRecord[]> {
  const [table, states] = await Promise.all([readTable(), readStates()]);
  if (states === undefined) throw new Error('the process states could not be read');
  const gone = new Set(states.filter(({ state }) => isGone(state)).map(({ pid }) => pid));
  const records: ProcessRecord[] = [];
  const snapshots: Snapshots = {};
  for (const record of table) {
    if (gone.has(record.pid)) continue;
    try {
      const group = sessionOf(record.pid);
      if (group >= 0) records.push({ ...record, group });
    } catch {
      if ((await lookAgain(record.pid, snapshots, readStates)) === 'gone') continue;
      records.push({ ...record, group: UNREADABLE_SESSION });
    }
  }
  return records;
}
