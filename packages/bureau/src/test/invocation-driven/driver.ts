/**
 * COR-1437 — the driver half: spawns invocations as separate OS processes and
 * enforces that each one exits on its own after it reports its work finished.
 *
 * The leak deadline is not a timing assertion. An invocation still running
 * {@link LEAK_DEADLINE_MS} after its `finished` line is holding a handle it
 * should have released; the driver SIGKILLs that one process (never a process
 * group, so the test runner receives nothing) and the outcome reports it as
 * leaked, which `expectCleanExit` turns into a failure naming the invocation.
 *
 * Not a test file: `invocation-driven-execution.test.ts` imports it.
 */
import type { Subprocess } from 'bun';

import { createDefaultRuntimeServices, type RuntimeTimeoutHandle } from '@lostgradient/lifecycle';

import { INVOCATION_LINE_PREFIX } from './protocol';

/** How long an invocation may keep running after its `finished` line before it is killed as leaked. */
export const LEAK_DEADLINE_MS = 30_000;

/**
 * The runtime kills an invocation that is still running this long after it
 * started, whether or not it reported `finished`: the hang guard every test
 * spawn carries, so a child stuck before its work finishes cannot hold the run.
 */
const HANG_GUARD_MILLISECONDS = 120_000;

const runtime = createDefaultRuntimeServices();

export interface InvocationEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface InvocationOutcome {
  readonly label: string;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stderr: string;
  readonly events: readonly InvocationEvent[];
  /** `true` when the driver killed the process for outliving its leak deadline. */
  readonly leaked: boolean;
}

export interface RunningInvocation {
  readonly label: string;
  readonly pid: number;
  /** Resolves with the first `event` line; rejects if the process exits without one. */
  waitFor(event: string): Promise<InvocationEvent>;
  /** Resolves once the process has exited and its output is drained. */
  outcome(): Promise<InvocationOutcome>;
  /** Sends `signal` to this invocation's own pid only, if it is still running. */
  kill(signal: NodeJS.Signals): void;
}

interface Waiter {
  readonly event: string;
  readonly resolve: (event: InvocationEvent) => void;
  readonly reject: (error: Error) => void;
}

/** Owns every invocation a test spawns, so `killAll` can reap them when an assertion fails first. */
export class InvocationDriver {
  readonly #live = new Set<Subprocess>();
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  /**
   * Starts `bun <entry> <directory> <command> <label> [blockActivity]` as its
   * own OS process. With `blockActivity`, the invocation holds that activity
   * open until the driver releases or kills it.
   */
  spawn(entry: string, command: string, label: string, blockActivity?: string): RunningInvocation {
    const argv = [process.execPath, entry, this.#directory, command, label];
    if (blockActivity !== undefined) argv.push(blockActivity);
    const child = Bun.spawn(argv, {
      timeout: HANG_GUARD_MILLISECONDS,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.#live.add(child);
    const events: InvocationEvent[] = [];
    const waiters: Waiter[] = [];
    let leaked = false;
    let leakTimerArmed = false;
    let leakTimer: RuntimeTimeoutHandle;
    const stderr = new Response(child.stderr).text();

    const record = (event: InvocationEvent): void => {
      events.push(event);
      if (event.event === 'finished' && !leakTimerArmed) {
        leakTimerArmed = true;
        leakTimer = runtime.timers.setTimeout(() => {
          leaked = true;
          process.kill(child.pid, 'SIGKILL');
        }, LEAK_DEADLINE_MS);
      }
      for (const waiter of waiters.filter((candidate) => candidate.event === event.event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    };

    const drained = (async () => {
      const decoder = new TextDecoder();
      let buffered = '';
      for await (const chunk of child.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.startsWith(INVOCATION_LINE_PREFIX)) {
            record(JSON.parse(line.slice(INVOCATION_LINE_PREFIX.length)) as InvocationEvent);
          }
          newline = buffered.indexOf('\n');
        }
      }
    })();

    const finished = (async (): Promise<InvocationOutcome> => {
      await child.exited;
      await drained;
      if (leakTimerArmed) runtime.timers.clearTimeout(leakTimer);
      this.#live.delete(child);
      const outcome: InvocationOutcome = {
        label,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stderr: await stderr,
        events,
        leaked,
      };
      for (const waiter of waiters.splice(0)) {
        waiter.reject(
          new Error(
            `invocation ${label} exited (code ${String(outcome.exitCode)}, signal ` +
              `${String(outcome.signalCode)}) before reporting "${waiter.event}"; stderr: ${outcome.stderr}`,
          ),
        );
      }
      return outcome;
    })();

    return {
      label,
      pid: child.pid,
      waitFor: (event) => {
        const seen = events.find((candidate) => candidate.event === event);
        if (seen !== undefined) return Promise.resolve(seen);
        return new Promise<InvocationEvent>((resolve, reject) => {
          waiters.push({ event, resolve, reject });
        });
      },
      outcome: () => finished,
      kill: (signal) => {
        if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, signal);
      },
    };
  }

  /** SIGKILLs every invocation still running and waits for each to exit. */
  async killAll(): Promise<void> {
    const live = [...this.#live];
    for (const child of live) {
      if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, 'SIGKILL');
    }
    await Promise.all(live.map((child) => child.exited));
    this.#live.clear();
  }
}

/**
 * Waits for `invocation` to exit and requires that it exited on its own,
 * cleanly, with nothing on stderr (warnings are defects), returning its
 * `finished` report.
 */
export async function expectCleanExit(invocation: RunningInvocation): Promise<InvocationEvent> {
  const outcome = await invocation.outcome();
  if (outcome.leaked) {
    throw new Error(
      `invocation ${outcome.label} was still running ${LEAK_DEADLINE_MS}ms after it reported ` +
        'its work finished, so the driver killed it: something it opened was never released',
    );
  }
  const finished = outcome.events.find((event) => event.event === 'finished');
  if (outcome.exitCode !== 0 || outcome.stderr !== '' || finished === undefined) {
    throw new Error(
      `invocation ${outcome.label} did not exit cleanly: code ${String(outcome.exitCode)}, ` +
        `signal ${String(outcome.signalCode)}, finished ${String(finished !== undefined)}, ` +
        `stderr: ${outcome.stderr}`,
    );
  }
  return finished;
}
