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
  /** Reads the process table, to find descendants that left the owned group. */
  readonly readProcessTable: () => Promise<ProcessRecord[]>;
};

/**
 * One spawned process and the process group it leads. The helpers start every process as its own
 * group leader, so the group is exactly the process and the descendants that stayed in it, and
 * ending the group ends all of them. That is the whole of what cleanup can own; descendants that
 * started a group or session of their own, and anything left behind by a host crash, are outside
 * it and are reported as `unknown`, never as clean.
 *
 * What cleanup can observe of that is limited, and it says so. An escaped descendant is found by
 * walking parent links in the process table, which works only while its ancestors are alive: once
 * the leader has exited the walk cannot reach it, so a process that escaped earlier and outlived
 * its parent is invisible, as is anything a crashed host left running. A `complete` result
 * therefore claims the owned process group and nothing wider.
 *
 * The exit and the state of the group at the moment of exit are recorded as they happen. A group
 * that was already empty then is never signaled afterwards, because its number may have been given
 * to an unrelated process since. A group that outlived its leader is signaled as usual; its
 * remaining members hold the number, which cannot be reused while any of them lives.
 */
export class OwnedProcess {
  readonly #options: OwnedProcessOptions;
  #child: SpawnedProcess | undefined;
  #exit: Promise<ProcessExit> | undefined;
  #exited = false;
  #emptyAtExit = false;

  constructor(options: OwnedProcessOptions) {
    this.#options = options;
  }

  /** Take ownership of a spawned process and start watching for its exit. */
  adopt(child: SpawnedProcess): void {
    this.#child = child;
    this.#exit = child.exited.then((exitCode) => {
      this.#exited = true;
      this.#emptyAtExit = !this.#options.operations.exists(child.pid);
      const signal = child.signalCode;
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
  async terminate(): Promise<CleanupOutcome> {
    const child = this.#child;
    if (child === undefined) return 'complete';
    if (this.#exited && this.#emptyAtExit) return 'complete';
    const scope = await this.#observeScope(child.pid);
    const { operations, clock, graceMilliseconds, observationMilliseconds } = this.#options;
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
    return combineOutcomes([scope, ended]);
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
