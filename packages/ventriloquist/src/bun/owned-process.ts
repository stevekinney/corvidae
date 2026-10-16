import type { CleanupOutcome } from '../protocol/messages.ts';
import type { SessionClock } from '../session/session-clock.ts';
import { combineOutcomes } from '../session/settle.ts';
import {
  descendantsOutsideGroup,
  terminateProcessGroup,
  type ProcessGroupOperations,
  type ProcessRecord,
} from './process-group.ts';
import type { ProcessExit, SpawnedProcess } from './process-types.ts';

/** How often a terminating group is probed for remaining members. */
const POLL_MILLISECONDS = 20;

export type OwnedProcessOptions = {
  readonly operations: ProcessGroupOperations;
  readonly clock: SessionClock;
  readonly graceMilliseconds: number;
  readonly observationMilliseconds: number;
  /**
   * Reads the process table, to find descendants that left the owned scope. Each record's `group`
   * is the scope id the operations work on: a process group, or a session.
   */
  readonly readProcessTable: () => Promise<ProcessRecord[]>;
  /**
   * Asked once per termination, before the first TERM, to hang up the leader so it can end its own
   * jobs. Only a session has one; a failure is swallowed, because the sweep that follows does not
   * depend on it.
   */
  readonly hangUp?: (leader: number) => void;
};

/** The wire carries a signal as a nonempty name; a signal without a name of its own is spelled by its number. */
function signalName(signal: string | number | null): string | null {
  if (signal === null) return null;
  if (signal === '') return 'SIGUNKNOWN';
  return typeof signal === 'number' ? `SIG${signal}` : signal;
}

/**
 * One spawned process and the scope it leads. The helpers start every process as its own group
 * leader, and a PTY child as its own session leader as well. For a pipe the scope is the group:
 * exactly the process and the descendants that stayed in it, and ending the group ends all of them.
 * For a PTY it is the whole session, which also holds the jobs a shell puts in groups of their own.
 * That is the whole of what cleanup can own; descendants that started a group (a pipe) or a session
 * (either) of their own, and anything left behind by a host crash, are outside it and are reported
 * as `unknown`, never as clean. In the rest of this file "group" means that scope, and a scope's id
 * is its leader's pid.
 *
 * What cleanup can observe of that is limited, and it says so. An escaped descendant is found by
 * walking parent links in the process table, which works only while its ancestors are alive: once
 * the leader has exited the walk cannot reach it, so a process that escaped earlier and outlived
 * its parent is invisible, as is anything a crashed host left running. A `complete` result
 * therefore claims the owned process group and nothing wider.
 *
 * The exit and the state of the group at the moment of exit are recorded as they happen. A group
 * that was already empty then is never signaled afterwards, because its number may have been given
 * to an unrelated process since. A termination that emptied the group is remembered the same way,
 * so a second `terminate` repeats its outcome instead of signaling again. A group that outlived its
 * leader is signaled as usual; its remaining members hold the number, which cannot be reused while
 * any of them lives.
 */
export class OwnedProcess {
  readonly #options: OwnedProcessOptions;
  #child: SpawnedProcess | undefined;
  #exit: Promise<ProcessExit> | undefined;
  #exiting = false;
  #exited = false;
  #emptyAtExit = false;
  /** The termination in flight, or the one that emptied the group: either way, no second one starts. */
  #termination: Promise<CleanupOutcome> | undefined;

  constructor(options: OwnedProcessOptions) {
    this.#options = options;
  }

  /** Take ownership of a spawned process and start watching for its exit. */
  adopt(child: SpawnedProcess): void {
    this.#child = child;
    this.#exit = child.exited.then(async (exitCode) => {
      // Marked before the group is looked at, so a termination that starts meanwhile waits for it.
      this.#exiting = true;
      const present = await this.#options.operations.exists(child.pid);
      this.#emptyAtExit = !present;
      this.#exited = true;
      const signal = signalName(child.signalCode);
      return signal === null ? { exitCode, signal: null } : { exitCode: null, signal };
    });
  }

  /** Resolves once with how the process ended; `undefined` if no process was ever adopted. */
  get exit(): Promise<ProcessExit> | undefined {
    return this.#exit;
  }

  /**
   * End the owned process group and report how far that got. Nothing owned means `complete`.
   * Otherwise the process table is read first, so a descendant that already left the group is
   * known before the group is signaled; then the group is ended and the process reaped. Any
   * escaped descendant, or a table that could not be read, is `unknown`; a group that did not
   * empty is `incomplete`.
   */
  terminate(): Promise<CleanupOutcome> {
    // Nothing is owned yet, so nothing is remembered: a process adopted later is still to be ended.
    if (this.#child === undefined) return Promise.resolve('complete');
    this.#termination ??= this.#terminate(this.#child);
    return this.#termination;
  }

  async #terminate(child: SpawnedProcess): Promise<CleanupOutcome> {
    // An exit being recorded decides whether the group is already empty: let it finish first.
    if (this.#exiting) await this.#exit;
    if (this.#exited && this.#emptyAtExit) return 'complete';
    const scope = await this.#observeScope(child.pid);
    // The leader may have exited, and its group emptied, while the process table was being read.
    // That group's number can belong to an unrelated group by now, so it is not signaled.
    if (this.#exiting) await this.#exit;
    if (this.#exited && this.#emptyAtExit) return scope;
    const { operations, clock, graceMilliseconds, observationMilliseconds, hangUp } = this.#options;
    // A leader known to have exited is never hung up: its pid may belong to another process by now.
    if (hangUp !== undefined && !this.#exited) {
      let hungUp = true;
      try {
        hangUp(child.pid);
      } catch {
        // A courtesy only: the TERM and KILL sweep below is what ends the scope.
        hungUp = false;
      }
      if (hungUp) {
        await this.#headStart();
        // The leader may have exited, and its session emptied, during the head start; then the
        // number is no longer one to sweep.
        if (this.#exiting) await this.#exit;
        if (this.#exited && this.#emptyAtExit) return scope;
      }
    }
    const ended = await terminateProcessGroup({
      group: child.pid,
      operations,
      clock,
      graceMilliseconds,
      observationMilliseconds,
      pollMilliseconds: POLL_MILLISECONDS,
    });
    // The group is empty, so the leader is gone; wait for the exit to be observed before reporting.
    if (ended === 'complete') await this.#exit;
    const outcome = combineOutcomes([scope, ended]);
    // An emptied group's number may belong to an unrelated process by now, so its outcome stands
    // and nothing is signaled again. A group that did not empty still has members holding the
    // number, so a later call may try again.
    if (ended !== 'complete') this.#termination = undefined;
    return outcome;
  }

  /**
   * Give the hung-up leader one poll tick to forward the hangup to its jobs before the sweep, or
   * less if the leader exits first. Bounded and on the injected clock, so nothing waits on a leader
   * that ignores the hangup.
   */
  async #headStart(): Promise<void> {
    let cancel: (() => void) | undefined;
    const tick = new Promise<void>((resolve) => {
      cancel = this.#options.clock.schedule(resolve, POLL_MILLISECONDS);
    });
    await Promise.race([tick, this.#exit]);
    cancel?.();
  }

  async #observeScope(root: number): Promise<CleanupOutcome> {
    try {
      const table = await this.#options.readProcessTable();
      return descendantsOutsideGroup(table, root, root).length === 0 ? 'complete' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
