/**
 * Hang guards that count only time the test process was awake to observe.
 *
 * A hang guard turns a child process or scenario that never finishes into a failure instead of a
 * run that never ends. Bun's timers, and the `timeout` option of `Bun.spawn`, keep counting while
 * the host sleeps or the process is stopped, so a guard armed before a laptop's lid closes fires
 * the moment it wakes, against work that was frozen rather than hung (COR-1541). A clamshell
 * sleep with brief dark wakes did exactly that to a `test:self` run: a scenario that takes three
 * seconds was reported "hung" after its 120-second guard, and the victim changed from run to run.
 *
 * `afterAwakeTime` measures the budget in ticks instead. It wakes at most once a second and
 * credits each tick no more than the interval it waited for, so a gap the process did not live
 * through, however long, counts as one interval. A hung scenario leaves the event loop idle, its
 * ticks arrive on schedule, and the guard still fires when the budget is spent. A busy loop only
 * delays ticks, so the guard can fire late but never early. No clock needs to exclude sleep.
 *
 * Bun's fake timers freeze every clock and turn any timer armed while they are active into a
 * fake one, so ticks cannot measure anything then. A caller whose scenario may install fake timers
 * passes `fakeTimersActive` (`jest.isFakeTimers` from `bun:test`); ticks stop while it reports
 * true, and a real one-shot backstop, armed before the scenario runs and therefore still real,
 * fires the guard at the full budget as a plain timer would. In real mode the backstop only
 * re-arms. The detector is injected rather than imported because this module is also loaded
 * outside the Bun test runner, where `bun:test` does not exist.
 *
 * This file has two byte-for-byte copies, kept equal by `scripts/check-test-support-copies.ts`:
 * `scripts/hang-guard.ts` for the root self-test suite, which may not depend on a workspace, and
 * `packages/weft/scripts/lib/hang-guard.ts`, because the Weft mirror cannot resolve
 * `@lostgradient/testing`.
 */
import type { SpawnOptions, Subprocess } from 'bun';
/**
 * The uniform hang guard for a test's child process or module-scope scenario: far above any
 * healthy run on a loaded host, and never a performance bound. A larger budget is passed
 * explicitly where one is needed.
 */
export declare const HANG_GUARD_MILLISECONDS = 120000;
export interface AwakeTimeOptions {
  /** Whether fake timers are installed, so real time cannot be measured. Defaults to never. */
  fakeTimersActive?: () => boolean;
  /** The clock ticks read. Injected by tests; defaults to `performance.now`. */
  now?: () => number;
  /** The longest wait between ticks, and so the most one tick can credit. Defaults to a second. */
  tickMilliseconds?: number;
}
/**
 * Call `onElapsed` once `milliseconds` of awake time have passed, measured by the ticks described
 * above. Returns a function that cancels the deadline; cancelling after it fired does nothing.
 */
export declare function afterAwakeTime(
  milliseconds: number,
  onElapsed: () => void,
  options?: AwakeTimeOptions,
): () => void;
export type HangGuardedSpawnOptions<
  In extends SpawnOptions.Writable,
  Out extends SpawnOptions.Readable,
  Err extends SpawnOptions.Readable,
> = Omit<SpawnOptions.SpawnOptions<In, Out, Err>, 'timeout'> & {
  /** Awake time after which the child is killed with `killSignal`. */
  hangGuardMilliseconds?: number;
};
/**
 * `Bun.spawn` with an awake-time hang guard in place of its `timeout` option. A child still
 * running when the guard elapses is killed with `killSignal` (SIGTERM by default), so its
 * `exitCode` and `signalCode` read as they would after `timeout`. Test files start every process
 * through this or `runWithHangGuard`; `scripts/check-test-process-spawns.ts` enforces it.
 */
export declare function spawnWithHangGuard<
  const In extends SpawnOptions.Writable = 'ignore',
  const Out extends SpawnOptions.Readable = 'pipe',
  const Err extends SpawnOptions.Readable = 'inherit',
>(command: string[], options?: HangGuardedSpawnOptions<In, Out, Err>): Subprocess<In, Out, Err>;
/** What `runWithHangGuard` resolves to: the fields of Bun's `SyncSubprocess` that tests read. */
export interface CompletedProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  success: boolean;
  stdout: Buffer;
  stderr: Buffer;
  pid: number;
}
/**
 * The asynchronous replacement for `Bun.spawnSync`: run `command` under the awake-time hang
 * guard and resolve once it exits, with both streams read in full. A synchronous spawn blocks
 * the thread, so no awake-time guard can tick while it runs; that is why test files may not use
 * one.
 */
export declare function runWithHangGuard<const In extends SpawnOptions.Writable = 'ignore'>(
  command: string[],
  options?: Omit<HangGuardedSpawnOptions<In, 'pipe', 'pipe'>, 'stdout' | 'stderr'>,
): Promise<CompletedProcess>;
