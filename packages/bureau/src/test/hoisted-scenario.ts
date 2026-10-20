/**
 * A crash scenario that boots real processes (a SIGKILLed child and, sometimes, a fresh verifying
 * one) pays process boot, module load, and a real-time claim-lapse wait. That cannot fit Bun's
 * per-test clock on a loaded host, so the scenario runs once at module scope and its test only
 * reports how it went.
 *
 * `settleScenario` captures a scenario's outcome, including the failure of its own assertions, and
 * `expectScenarioPassed` rethrows that failure from the test that names the scenario. Scenarios
 * run one after another: they share a host that is already loaded by the processes they boot.
 *
 * `waitForBureauState` replaces a wall-clock poll with the thing the poll stood in for: it checks
 * the state, and when the state is not yet true it waits for the bureau to say something changed.
 */
import type { Subscription } from '@lostgradient/lifecycle';
import { afterAwakeTime } from '@lostgradient/testing/hang-guard';

import type { Bureau } from '../types';

/** What a running scenario hands its owner so that a hung scenario can be cleaned up. */
export interface ScenarioScope {
  /**
   * Registers something the scenario owns (a bureau to shut down, a child to kill, a directory to
   * remove). The releases run, last registered first, as soon as the hang guard fires, because a
   * hung scenario never reaches its own `finally`. Each release must be safe to run twice.
   */
  onHang(release: () => unknown): void;
  /**
   * Runs one awaited stage of the scenario under a label. When the hang guard fires, its error names
   * the phase that was running, how long it had run, and how long each finished phase took, so a
   * hang says where it stalled instead of only that it did (COR-1592). The result and any
   * rejection pass through unchanged. Phases do not nest: a phase started inside another one takes
   * over as the running phase.
   */
  phase<T>(label: string, run: () => Promise<T>): Promise<T>;
  /**
   * Registers what the running phase is waiting for, read when the guard fires. `waitForBureauState`
   * registers its check's label and last observation here.
   */
  observe(describe: () => string | Promise<string>): void;
}

/** The longest the hang report waits for a phase to say what it was waiting for. */
const DESCRIBE_MILLISECONDS = 5_000;

/**
 * Reads `describe` for the hang report, giving up after `milliseconds`: a read of a stalled
 * bureau can itself stall, and the report must still be written.
 */
async function readWithin(
  describe: (() => string | Promise<string>) | undefined,
  milliseconds: number,
): Promise<string | undefined> {
  if (describe === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(describe),
      new Promise<string>((resolve) => {
        timer = setTimeout(
          () => resolve(`the read did not return within ${milliseconds}ms`),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ScenarioOutcome {
  readonly failed: boolean;
  readonly error?: unknown;
}

/**
 * Runs `run`, capturing its failure. `hangGuardMilliseconds` is the only time bound: it is the
 * per-test timeout the scenario's tests had before they were hoisted, kept solely so a genuine
 * hang fails the scenario instead of stalling the file. It counts only time the process was awake
 * (`@lostgradient/testing/hang-guard`, COR-1541), so a host that sleeps mid-scenario does not fail
 * it on wake. It does not bound any wait for a state
 * change, which `waitForBureauState` makes by event. When the guard wins, the releases the
 * scenario registered on its {@link ScenarioScope} run before this returns, so the next scenario
 * starts with nothing of this one still alive.
 */
export async function settleScenario(
  run: (scope: ScenarioScope) => Promise<void>,
  hangGuardMilliseconds: number,
): Promise<ScenarioOutcome> {
  const releases: Array<() => unknown> = [];
  const finishedPhases: Array<{ label: string; milliseconds: number }> = [];
  let running:
    { label: string; startedAt: number; describe?: () => string | Promise<string> } | undefined;
  let lastFinished: string | undefined;
  const scope: ScenarioScope = {
    onHang: (release) => void releases.push(release),
    observe: (describe) => {
      if (running !== undefined) running.describe = describe;
    },
    phase: async (label, run) => {
      const phase = { label, startedAt: performance.now() };
      running = phase;
      try {
        return await run();
      } finally {
        finishedPhases.push({
          label,
          milliseconds: Math.round(performance.now() - phase.startedAt),
        });
        lastFinished = label;
        if (running === phase) running = undefined;
      }
    },
  };
  const describeHang = async (): Promise<string> => {
    const base = `the scenario made no progress within the ${hangGuardMilliseconds}ms hang guard`;
    let where: string;
    // The phase that was running when the guard fired. It can finish while its description is
    // read, which clears `running`, so the report keeps its own reference.
    const stalled = running;
    if (stalled !== undefined) {
      const waited = Math.round(performance.now() - stalled.startedAt);
      let detail = '';
      try {
        const described = await readWithin(stalled.describe, DESCRIBE_MILLISECONDS);
        if (described !== undefined) detail = ` (${described})`;
      } catch (error) {
        detail = ` (describing the wait failed: ${error instanceof Error ? error.message : String(error)})`;
      }
      where = `stalled in phase "${stalled.label}" after ${waited}ms${detail}`;
    } else if (lastFinished === undefined) {
      where = 'stalled before its first phase';
    } else {
      where = `stalled between phases after "${lastFinished}"`;
    }
    const finished =
      finishedPhases.length === 0
        ? 'no phase finished'
        : `finished phases: ${finishedPhases.map((phase) => `${phase.label} (${phase.milliseconds}ms)`).join(', ')}`;
    return `${base}; ${where}; ${finished}`;
  };
  // Start every release, last registered first, without waiting for any to finish: a release
  // can itself be stuck (a shutdown awaiting the very thing that hung), and waiting on it would
  // block module initialization again. Each starts synchronously, so a child is killed at
  // once; a failing release is swallowed so it cannot hide the hang it cleans up after.
  const startReleases = (): void => {
    for (const release of releases.toReversed()) {
      try {
        void Promise.resolve(release()).catch(() => {});
      } catch {
        // A release that throws synchronously is as best effort as one that rejects.
      }
    }
  };
  let cancel: (() => void) | undefined;
  let hung = false;
  const hang = new Promise<ScenarioOutcome>((resolve) => {
    cancel = afterAwakeTime(hangGuardMilliseconds, () => {
      hung = true;
      // The releases start here, as the guard fires, before the hang is described: describing
      // can take up to `DESCRIBE_MILLISECONDS`, and a hung child must not outlive the guard by that.
      startReleases();
      void describeHang().then(
        (message) => resolve({ failed: true, error: new Error(message) }),
        (error: unknown) => resolve({ failed: true, error }),
      );
    });
  });
  const finished = (async (): Promise<ScenarioOutcome> => {
    try {
      await run(scope);
      return { failed: false };
    } catch (error) {
      return { failed: true, error };
    }
  })();
  try {
    let outcome = await Promise.race([finished, hang]);
    // Once the guard has fired, the outcome is the hang's, whatever the scenario did meanwhile: it
    // may have finished while the description was read, or a release may have made the stalled
    // operation reject. The hang always resolves, and its report is bounded by
    // `DESCRIBE_MILLISECONDS`.
    if (hung) outcome = await hang;
    return outcome;
  } finally {
    cancel?.();
  }
}

export function expectScenarioPassed(outcome: ScenarioOutcome | undefined): void {
  if (outcome === undefined) throw new Error('the scenario never ran');
  if (outcome.failed) throw outcome.error;
}

export interface WaitForBureauStateOptions {
  /**
   * Runs whose liveness snapshots also wake the wait. A run is subscribed once the bureau knows it,
   * so ids may name runs that are only registered later (by recovery, for example).
   */
  readonly runIds?: readonly string[];
  /**
   * An extra source of change the bureau cannot announce, such as a test double being called.
   * Receives `notify` and returns how to stop listening.
   */
  readonly onChange?: (notify: () => void) => () => void;
  /**
   * The scenario's scope. When given, the hang report names this wait: its `label` and what
   * `describe` returns for the state the check last read.
   */
  readonly scope?: ScenarioScope;
  /** What the wait is for, in the hang report. Defaults to `check`. */
  readonly label?: string;
  /** The state the check last read, for the hang report. */
  readonly describe?: () => string | Promise<string>;
}

/**
 * Resolves once `check` is true. The current state is checked first; otherwise the wait wakes on
 * whatever the bureaus announce (every live frame, every bureau event, and the liveness snapshots
 * of `runIds`) and checks again. Listeners are attached before the first check, and a
 * notification that arrives while a check is running forces another check, so a transition that
 * happens before or during the wait cannot be missed. For a state with no event of its own, such as
 * `getDurableRun`, the re-check on each announcement is the whole mechanism; no timer is involved.
 */
export async function waitForBureauState(
  bureaus: readonly Bureau[],
  check: () => boolean | Promise<boolean>,
  options: WaitForBureauStateOptions = {},
): Promise<void> {
  let version = 0;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    version += 1;
    wake?.();
  };

  const subscriptions: Array<{ unsubscribe: () => void }> = [];
  const snapshotSubscriptions = new Set<string>();
  const subscribeSnapshots = (): void => {
    for (const [index, bureau] of bureaus.entries()) {
      for (const runId of options.runIds ?? []) {
        const key = `${index}:${runId}`;
        if (snapshotSubscriptions.has(key)) continue;
        try {
          subscriptions.push(bureau.subscribeRunSnapshot(runId, notify));
          snapshotSubscriptions.add(key);
        } catch {
          // The bureau does not know the run yet; the next announcement tries again.
        }
      }
    }
  };

  for (const bureau of bureaus) {
    subscriptions.push({ unsubscribe: bureau.subscribeLiveFrames(notify) });
    const eventSubscription: Subscription = bureau.toObservable().subscribe(notify);
    subscriptions.push(eventSubscription);
  }

  const stopCustom = options.onChange?.(notify);
  let checks = 0;
  options.scope?.observe(async () => {
    const state = await options.describe?.();
    return `waiting for "${options.label ?? 'check'}"; checked ${checks} times${
      state === undefined ? '' : `; last read: ${state}`
    }`;
  });
  try {
    while (true) {
      const seen = version;
      subscribeSnapshots();
      checks += 1;
      if (await check()) return;
      if (version !== seen) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    stopCustom?.();
    for (const subscription of subscriptions) subscription.unsubscribe();
  }
}
