import { dlopen, FFIType } from 'bun:ffi';

import {
  readProcessTable,
  type ProcessGroupOperations,
  type ProcessRecord,
} from './process-group.ts';

/** One process and the state letters `ps` reports for it. */
export type ProcessState = { readonly pid: number; readonly state: string };

/**
 * Read `pid stat` rows, as `ps -A -o pid=,stat=` prints them. A row that is not a pid and a state
 * fails the read.
 */
export function parseProcessStates(text: string): ProcessState[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const pid = Number(fields[0]);
      if (fields.length !== 2 || !Number.isSafeInteger(pid)) {
        throw new Error(`unreadable process state row: ${JSON.stringify(line)}`);
      }
      return { pid, state: fields[1] as string };
    });
}

const PROCESS_STATE_COMMAND = ['ps', '-A', '-o', 'pid=,stat='];

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

/** The session a process belongs to, or a negative number when there is no such process. */
export type SessionOf = (pid: number) => number;

let getsid: SessionOf | undefined;

/**
 * `getsid(2)` through libc. `ps` cannot be the source of session membership: on macOS its `sess`
 * column is the kernel's session pointer, hidden and printed as `0` for every process, so it
 * names no session at all. `getsid` answers the same way on macOS and Linux, for a process in any
 * session, and returns `-1` once the process is gone. It is bound on first use, so a host that
 * never ends a PTY never loads it.
 */
export const sessionOfProcess: SessionOf = (pid) => {
  getsid ??= dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
    getsid: { args: [FFIType.i32], returns: FFIType.i32 },
  }).symbols.getsid as SessionOf;
  return getsid(pid);
};

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

  /** The live (non-zombie) members of `session`, or `undefined` when they cannot be read. */
  async function liveMembers(session: number): Promise<number[] | undefined> {
    const states = await readStates();
    if (states === undefined) return undefined;
    try {
      return states
        .filter(({ state }) => !state.startsWith('Z'))
        .map(({ pid }) => pid)
        .filter((pid) => sessionOf(pid) === session);
    } catch {
      return undefined;
    }
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
          if (sessionOf(pid) !== session) continue;
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
      // a live process this one may not signal is a real refusal.
      const states = await readStates();
      for (const { pid, error } of refused) {
        const state = states?.find((candidate) => candidate.pid === pid)?.state;
        if (states === undefined || (state !== undefined && !state.startsWith('Z'))) throw error;
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

/**
 * The process table with each process's `group` replaced by its session, so
 * `descendantsOutsideGroup` finds the descendants that left the session the way it finds those
 * that left a group. A process that vanished between the table and its session being read is
 * dropped: it is gone, not escaped.
 */
export async function readSessionTable(
  sessionOf: SessionOf = sessionOfProcess,
  readTable: () => Promise<ProcessRecord[]> = () => readProcessTable(),
): Promise<ProcessRecord[]> {
  const table = await readTable();
  return table
    .map((record) => ({ ...record, group: sessionOf(record.pid) }))
    .filter((record) => record.group >= 0);
}
