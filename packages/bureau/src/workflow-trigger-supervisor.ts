/**
 * COR-1874 — runs the contributed trigger kinds (`plugin:name`) the workflow files use. A file
 * whose `trigger.kind` is a contributed kind is handed to that kind's `start`, which listens for
 * the external source and calls `fire` with the payload the instance starts with. The supervisor
 * keeps what `start` returned so it can stop the trigger when the file is paused, changed,
 * deleted, no longer valid, or the Bureau closes.
 *
 * A trigger is bound to a file, not to a run, so it floats with the loaded plugin and is not
 * pinned by a revision (see `workflow-contributions.ts`).
 *
 * COR-2165 — it also keeps what each listener is doing, in memory only: `listening` once `start`
 * resolved, `waiting-for-secret` while a secret its plugin declares is missing, `failed` with a
 * code when `start` threw or the kind refused the configuration, and `stopped` for a paused file.
 * A failed listener is one `trigger-failed` problem on its plugin until it is not failed. A start
 * that settles after its listener was stopped writes nothing.
 *
 * COR-2166 — a listener whose `start` threw is started again after 1 second, then 2, 4 and on to
 * 300 seconds, for as long as it stays failed, on the runtime's injected timers: one timer per
 * workflow, armed exactly while it is `failed` with `start-failed`, and its due time is the
 * status's `retryAt`. A start that resolved, whether it listens or waits for a secret, starts the
 * delays over, as a manual retry and an edit of the file do. A configuration the kind refuses is
 * never retried. Every attempt, a timer's, a manual retry's and a reconcile's, runs under the
 * runtime's serialization lock, so none interleaves with another.
 *
 * COR-2168 — a kind that only receives has no `start`: its file is `ready` once the configuration
 * parses and the storage can be made, `stopped` when paused, and `failed` as any file is when
 * either step fails. The entry stays, with nothing to stop, so `noteFired` can record the runs its
 * `receive` started.
 *
 * @module workflow-trigger-supervisor
 */

import type { RuntimeTimeoutHandle, RuntimeTimers } from '@lostgradient/lifecycle';
import type {
  PluginTrigger,
  PluginTriggerContext,
  PluginTriggerOutcome,
} from '@lostgradient/interborough-plugin';
import type { Storage } from '@lostgradient/storage';

import type { VersionedCatalogEntry } from './versioned-catalog';
import { createTriggerStorage } from './workflow-trigger-state';
import { type ListenerReport, listenForReports } from './workflow-trigger-reports';

/** The wait before the first retry; each failure in a row doubles it. */
const RETRY_FIRST_DELAY_MILLISECONDS = 1_000;

/** The longest wait between two attempts. */
const RETRY_LONGEST_DELAY_MILLISECONDS = 300_000;

/** A file's trigger that should be listening, or is paused. */
export interface DesiredTrigger {
  /** The contributed kind, with the plugin it came from. */
  readonly kind: VersionedCatalogEntry<PluginTrigger>;
  /** The file's `trigger` object, `kind` included. */
  readonly trigger: Readonly<Record<string, unknown>>;
  /** Whether the file is paused: its listener is not started, and its state is `stopped`. */
  readonly paused?: boolean | undefined;
}

/**
 * What a listener is doing. `ready` is a kind that only receives (COR-2168): it has no listener to
 * run, and its file is ready for `receive` whatever its secrets, until the file is paused.
 */
export type ListenerState = 'listening' | 'waiting-for-secret' | 'failed' | 'stopped' | 'ready';

/** Why a listener is `failed`. */
export type ListenerCode = 'start-failed' | 'configuration-refused';

/** The state of one file's listener, as the supervisor last saw it settle. */
export interface ListenerStatus {
  readonly state: ListenerState;
  /** When `state` last changed, by the supervisor's clock; a change of `code` alone keeps it. */
  readonly since: string;
  /** Why it is `failed`, else `null`. */
  readonly code: ListenerCode | null;
  /** When a fire last started a run, or `null` when none has since this process started. */
  readonly lastFiredAt: string | null;
  /**
   * When the next attempt to start a `start-failed` listener is due, else `null`: also `null`
   * while an attempt is in flight.
   */
  readonly retryAt: string | null;
}

/** Keeps the running triggers equal to the files'. */
export interface WorkflowTriggerSupervisor {
  /**
   * Start the triggers in `desired` that are not running, restart those whose kind or trigger
   * changed, and stop the others, except the workflows in `keep`, which are left as they are. The
   * caller holds the serialization lock: a reconcile never overlaps another attempt.
   */
  reconcile(desired: ReadonlyMap<string, DesiredTrigger>, keep: ReadonlySet<string>): Promise<void>;
  /**
   * What the listener of workflow `id` is doing, when it is of trigger kind `kind`. `undefined`
   * before its first start settles, for a workflow that has none, and once its file is gone.
   */
  listener(id: string, kind: string): ListenerStatus | undefined;
  /**
   * Start the failed listener of workflow `id` at once, with the backoff cleared, and answer what
   * it is doing once the attempt has settled; the attempt runs under the serialization lock. An
   * attempt already in flight, or already queued for its timer, is not repeated: its result is the
   * answer. A listener that is listening, waiting for a secret or stopped is left as it is. A
   * listener whose configuration the kind refuses is parsed again, and stays failed without a
   * timer when it is refused again. `undefined` when the workflow has no listener, which is also
   * what it answers after the supervisor is closed.
   */
  retry(id: string): Promise<ListenerStatus | undefined>;
  /**
   * A `receive` of kind `kind` for workflow `id` started a run: record when, on the entry that is
   * the workflow's now, whatever state it is in, as a started fire of its own `start` does
   * (COR-2168). Nothing is written when the workflow has no entry yet or any more, when its entry
   * is of another kind, or after the supervisor closed. The state, `since` and `retryAt` are left as
   * they are.
   */
  noteFired(id: string, kind: string): void;
  /** Stop every trigger, cancel every retry, and refuse to start another. */
  close(): Promise<void>;
}

/** One fire of a listener that is still running, as the supervisor hands it to the runtime. */
export interface TriggerFireRequest {
  /** The workflow file the trigger starts. */
  readonly workflowId: string;
  /** The contributed kind, `plugin:name`. */
  readonly kind: string;
  /** The kind's own version, else its plugin's, as of when this listener started. */
  readonly version: string;
  /** What the trigger gave `fire`; the caller still owns it. */
  readonly payload: unknown;
  /**
   * What the trigger gave as `options.idempotencyKey`: absent when it gave none, and otherwise
   * whatever the plugin passed, for the runtime to check, since the supervisor does not.
   */
  readonly idempotencyKey?: unknown;
}

export interface WorkflowTriggerSupervisorOptions {
  /**
   * Starts an instance of the request's workflow for its trigger kind, or says why it did not;
   * called by a trigger's `fire`, which may come before its `start` resolves. It must never wait
   * for a reconcile: a reconcile awaits a trigger's `stop`, and a `stop` may wait for the trigger's
   * fires in flight. The supervisor answers `skipped` itself, without calling it, for a listener it
   * stopped or after it closed.
   */
  readonly fire: (request: TriggerFireRequest) => Promise<PluginTriggerOutcome>;
  readonly diagnose: (message: string, cause: unknown) => void;
  /**
   * The store the plugins' own storage is a prefix of. A trigger receives the part of it under
   * `plugin:<plugin>:trigger:<trigger-name>:<workflow-id>:` (see `workflow-trigger-state.ts`).
   */
  readonly storage: Storage;
  /** The runtime's clock, which every `since`, `retryAt` and `lastFiredAt` is read from. */
  readonly nowISO: () => string;
  /** The runtime's timers, which every retry is armed on. */
  readonly timers: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'>;
  /**
   * Runs `work` after everything queued before it, and before everything queued after: the
   * runtime's serialization lock, which a reconcile already runs under. A retry's attempt, whether
   * a timer's or a caller's, goes through it. A caller of `reconcile` holds it already, so the
   * supervisor never takes it inside a reconcile.
   */
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * A listener became `failed`: `plugin` is the one that contributes its kind, and `message` is the
   * failure's, unredacted, for the plugin registry to redact. Called once while the listener stays
   * failed.
   */
  readonly reportFailure: (plugin: string, workflow: string, message: string) => void;
  /** The listener of `workflow` is no longer failed, or its file is gone. */
  readonly clearFailure: (plugin: string, workflow: string) => void;
}

interface RunningTrigger {
  /** The kind, its version, the trigger object and whether it is paused: a change to any restarts the trigger. */
  readonly key: string;
  /** What the file wants, so a retry can start it again. */
  readonly desired: DesiredTrigger;
  /** The plugin that contributes the kind. */
  readonly plugin: string;
  /** The kind, `plugin:name`. */
  readonly kind: string;
  readonly paused: boolean;
  /** This attempt's own controller: its signal is the `signal` the kind's `start` received. */
  readonly controller: AbortController;
  /** The attempt itself, from before its `start` to what it recorded. */
  attempt: Promise<void>;
  /**
   * What `start` resolved with; absent while it is pending, and when it failed, since the
   * supervisor stopped the listener then.
   */
  stop?: (() => void | Promise<void>) | undefined;
  /** The stop a failed listener's gate was given in the background; awaited with the listener. */
  stopping?: Promise<void> | undefined;
  /** Set once the trigger was removed, replaced or closed: whatever it settles with is stale. */
  retired: boolean;
  /** Whether its `start` has settled. A report before then is held and applied when it does. */
  settled: boolean;
  /** The latest report that came before `start` settled. */
  pendingReport?: ListenerReport | undefined;
  /** When a fire of this listener last started a run. */
  lastFiredAt?: string | undefined;
  /** How many failures in a row came before this attempt; the next delay doubles from it. */
  failures: number;
  /** The timer armed for this entry's retry, while it is failed with `start-failed`. */
  timer?: RuntimeTimeoutHandle;
  /** When that timer is due. */
  retryAt?: string | undefined;
  /** The attempt a timer or a caller queued behind the serialization lock for this entry. */
  queued?: Promise<void> | undefined;
}

/** What the supervisor knows about one file's listener. */
interface ListenerRecord {
  /** The plugin that contributes the kind, to clear its problem. */
  readonly plugin: string;
  /** The kind, `plugin:name`. */
  readonly kind: string;
  readonly status: ListenerStatus;
}

/** A fire that started nothing, and why. */
function skipped(reason: 'stopped' | 'paused' | 'closed'): PluginTriggerOutcome {
  return { outcome: 'skipped', reason };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build a supervisor. */
export function createWorkflowTriggerSupervisor(
  options: WorkflowTriggerSupervisorOptions,
): WorkflowTriggerSupervisor {
  const running = new Map<string, RunningTrigger>();
  const listeners = new Map<string, ListenerRecord>();
  let closed = false;

  /** Whether `entry` is still the trigger of `id`, so that what it settles with counts. */
  function isCurrent(id: string, entry: RunningTrigger): boolean {
    return !closed && !entry.retired && running.get(id) === entry;
  }

  /**
   * The one place a retry timer stops being armed. The invariant (I3): the published `retryAt` is
   * non-null exactly while a timer is armed, so it clears the entry's `retryAt` and the one on
   * the status together. Every path that cancels a timer or starts an attempt goes through it: the
   * timer firing, a manual retry, an edit, a pause, a removal, and a close.
   */
  function cancelTimer(id: string, entry: RunningTrigger): void {
    const published = entry.retryAt;
    if (entry.timer !== undefined) options.timers.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.retryAt = undefined;
    const prior = listeners.get(id);
    if (published !== undefined && prior?.status.retryAt === published) {
      listeners.set(id, { ...prior, status: { ...prior.status, retryAt: null } });
    }
  }

  /**
   * Write the state of `id`'s listener. `since` changes only when the state does, and the
   * `trigger-failed` problem follows the state: reported when it becomes failed, cleared when it is
   * no longer failed. A start that resolved starts the delays over.
   */
  function record(
    id: string,
    entry: RunningTrigger,
    next: {
      readonly state: ListenerState;
      readonly code: ListenerCode | null;
      readonly message?: string;
      readonly retryAt?: string | null;
    },
  ): void {
    const prior = listeners.get(id);
    const sameState = prior?.status.state === next.state;
    if (
      prior?.status.state === 'failed' &&
      (next.state !== 'failed' || prior.plugin !== entry.plugin)
    ) {
      options.clearFailure(prior.plugin, id);
    }
    const alreadyReported =
      prior?.status.state === 'failed' && next.state === 'failed' && prior.plugin === entry.plugin;
    if (next.state === 'failed' && !alreadyReported) {
      options.reportFailure(entry.plugin, id, next.message ?? '');
    }
    if (
      next.state === 'listening' ||
      next.state === 'waiting-for-secret' ||
      next.state === 'ready'
    ) {
      entry.failures = 0;
    }
    listeners.set(id, {
      plugin: entry.plugin,
      kind: entry.kind,
      status: {
        state: next.state,
        since: sameState ? prior.status.since : options.nowISO(),
        code: next.code,
        lastFiredAt: entry.lastFiredAt ?? prior?.status.lastFiredAt ?? null,
        retryAt: next.retryAt ?? null,
      },
    });
  }

  /** Forget `id`'s listener, and the problem it had. */
  function drop(id: string): void {
    const prior = listeners.get(id);
    if (prior === undefined) return;
    if (prior.status.state === 'failed') options.clearFailure(prior.plugin, id);
    listeners.delete(id);
  }

  /**
   * Arm `entry`'s retry: the next delay after the failures it follows, 1 second doubling to 300,
   * with its due time as `retryAt`. Only a current entry arms one.
   */
  function armRetry(id: string, entry: RunningTrigger): void {
    if (!isCurrent(id, entry)) return;
    const delay = Math.min(
      RETRY_FIRST_DELAY_MILLISECONDS * 2 ** entry.failures,
      RETRY_LONGEST_DELAY_MILLISECONDS,
    );
    entry.failures += 1;
    entry.retryAt = new Date(Date.parse(options.nowISO()) + delay).toISOString();
    entry.timer = options.timers.setTimeout(() => onTimer(id, entry), delay);
  }

  /**
   * The listener of `id` failed: its controller is aborted, so a `fire` it captured answers
   * `skipped: 'stopped'`, and it is recorded failed. The entry stays, so an unchanged file is not
   * started again. A `start-failed` listener is retried; a refused configuration is not.
   */
  function fail(id: string, entry: RunningTrigger, code: ListenerCode, message: string): void {
    entry.settled = true;
    entry.controller.abort();
    if (code === 'start-failed') armRetry(id, entry);
    record(id, entry, { state: 'failed', code, message, retryAt: entry.retryAt ?? null });
  }

  async function stopQuietly(
    id: string,
    stop: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    try {
      await stop?.();
    } catch (error) {
      options.diagnose(`Could not stop the trigger of workflow "${id}".`, error);
    }
  }

  async function stopTrigger(id: string, trigger: RunningTrigger): Promise<void> {
    if (running.get(id) === trigger) running.delete(id);
    trigger.retired = true;
    cancelTimer(id, trigger);
    trigger.controller.abort();
    await trigger.stopping;
    await stopQuietly(id, trigger.stop);
  }

  /** A fire that started a run: remember when, on the listener and on its record. */
  function noteFired(id: string, entry: RunningTrigger): void {
    if (!isCurrent(id, entry)) return;
    const at = options.nowISO();
    entry.lastFiredAt = at;
    const prior = listeners.get(id);
    if (prior !== undefined) {
      listeners.set(id, { ...prior, status: { ...prior.status, lastFiredAt: at } });
    }
  }

  /** What a kind said about its listener, once it counts: the entry is current and has settled. */
  function applyReport(id: string, entry: RunningTrigger, report: ListenerReport): void {
    if (report.state !== 'failed') {
      record(id, entry, { state: report.state, code: null });
      return;
    }
    options.diagnose(
      `The "${entry.kind}" trigger of workflow "${id}" failed to start again; it is reported failed, and starts again with a growing delay.`,
      report.error,
    );
    // The kind stopped following its secret when it was stopped, so the supervisor stops it, as it
    // does a listener whose `start` threw, but not here: the kind reports from inside its own queue,
    // and a stop queues behind it.
    const stop = entry.stop;
    entry.stop = undefined;
    fail(id, entry, 'start-failed', messageOf(report.error));
    entry.stopping = stopQuietly(id, stop);
  }

  /**
   * Start workflow `id`'s listener for `desired`, as the entry `key` names, after `failures`
   * failures in a row. The entry is the trigger of `id` from the first line, so a stop that lands
   * while `start` is pending reaches it.
   */
  function startTrigger(
    id: string,
    desired: DesiredTrigger,
    key: string,
    failures: number,
  ): Promise<void> {
    // A close that landed while the previous trigger was starting or stopping: start nothing.
    if (closed) return Promise.resolve();
    const entry: RunningTrigger = {
      key,
      desired,
      plugin: desired.kind.source.name,
      kind: desired.kind.name,
      paused: desired.paused === true,
      controller: new AbortController(),
      attempt: Promise.resolve(),
      retired: false,
      settled: false,
      failures,
    };
    running.set(id, entry);
    entry.attempt = attemptOf(id, entry);
    return entry.attempt;
  }

  async function attemptOf(id: string, entry: RunningTrigger): Promise<void> {
    const { kind, trigger } = entry.desired;
    const { controller } = entry;
    if (entry.paused) {
      entry.settled = true;
      controller.abort();
      record(id, entry, { state: 'stopped', code: null });
      return;
    }
    // Captured now, as part of the listener that is starting: a fire records the version of the
    // listener it came from, however the catalog moves afterwards.
    const version = kind.version;
    const { kind: _kind, ...rest } = trigger;
    const parsed = kind.value.configuration.safeParse(rest);
    if (!parsed.success) {
      options.diagnose(
        `The "${kind.name}" trigger of workflow "${id}" has a configuration its kind refuses, so it is failed until its file changes: ${parsed.error.message}`,
        undefined,
      );
      fail(id, entry, 'configuration-refused', parsed.error.message);
      return;
    }
    let storage: Storage;
    try {
      storage = createTriggerStorage(options.storage, kind.name, id);
    } catch (error) {
      options.diagnose(
        `Could not give the "${kind.name}" trigger of workflow "${id}" its storage; it is failed, and starts again with a growing delay.`,
        error,
      );
      fail(id, entry, 'start-failed', messageOf(error));
      return;
    }
    // A kind that only receives has no listener to run: it is ready once its configuration and its
    // storage are, whatever its secrets, and its entry stays so a fire noted by `receive` finds it.
    if (kind.value.start === undefined) {
      entry.settled = true;
      record(id, entry, { state: 'ready', code: null });
      return;
    }
    const context: PluginTriggerContext = {
      configuration: parsed.data,
      workflowId: id,
      storage,
      signal: controller.signal,
      fire: (payload, fireOptions) => {
        // The plugin owns `fireOptions`: read the key once, before anything awaits. Closed is
        // checked before aborted, because `close` aborts every listener and that is not a stop.
        const idempotencyKey: unknown = fireOptions?.idempotencyKey;
        if (closed) return Promise.resolve<PluginTriggerOutcome>(skipped('closed'));
        if (controller.signal.aborted) {
          return Promise.resolve<PluginTriggerOutcome>(skipped('stopped'));
        }
        return options
          .fire({
            workflowId: id,
            kind: kind.name,
            version,
            payload,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          })
          .then((outcome) => {
            if (outcome.outcome === 'started') noteFired(id, entry);
            return outcome;
          });
      },
    };
    // What a gated kind says about its own listener reaches the entry, not the status: it is held
    // until `start` settles, and ignored once the entry is stale.
    listenForReports(context, (report) => {
      if (!isCurrent(id, entry)) return;
      if (entry.settled) applyReport(id, entry, report);
      else entry.pendingReport = report;
    });
    try {
      entry.stop = await kind.value.start(context);
    } catch (error) {
      entry.settled = true;
      options.diagnose(
        `Could not start the "${kind.name}" trigger of workflow "${id}"; it is failed, and starts again with a growing delay.`,
        error,
      );
      // A start that fails after its listener was stopped says nothing about the listener now.
      if (isCurrent(id, entry)) fail(id, entry, 'start-failed', messageOf(error));
      return;
    }
    entry.settled = true;
    // Stopped while `start` was still resolving: it listens for nothing now, and says nothing.
    if (!isCurrent(id, entry)) {
      await stopQuietly(id, entry.stop);
      return;
    }
    const report = entry.pendingReport;
    entry.pendingReport = undefined;
    if (report === undefined) record(id, entry, { state: 'listening', code: null });
    else applyReport(id, entry, report);
  }

  /**
   * Start `id`'s failed listener again, in place of `entry`, which is over: the new attempt is the
   * trigger of `id` from the first line, and the old status stays until it settles. The serialization
   * lock is the caller's.
   */
  async function replaceAttempt(
    id: string,
    entry: RunningTrigger,
    failures: number,
  ): Promise<void> {
    entry.retired = true;
    cancelTimer(id, entry);
    const next = startTrigger(id, entry.desired, entry.key, failures);
    await entry.stopping;
    await next;
  }

  /** The retry timer of `entry` fired: queue the attempt, unless something else already did. */
  function onTimer(id: string, entry: RunningTrigger): void {
    // The timer is spent: the attempt is under way from here, and the status says so by dropping
    // its due time.
    cancelTimer(id, entry);
    if (!isCurrent(id, entry) || entry.queued !== undefined) return;
    entry.queued = options
      .exclusive(async () => {
        // Checked again once the lock is ours: a reconcile, a pause or a close can have come first.
        if (!isCurrent(id, entry)) return;
        await replaceAttempt(id, entry, entry.failures);
      })
      .catch((error: unknown) => {
        options.diagnose(`Could not retry the trigger of workflow "${id}".`, error);
      });
  }

  return {
    async reconcile(desired, keep) {
      if (closed) return;
      for (const [id, trigger] of running) {
        if (closed) return;
        if (!desired.has(id) && !keep.has(id)) {
          await stopTrigger(id, trigger);
          drop(id);
        }
      }
      for (const id of listeners.keys()) {
        if (!desired.has(id) && !keep.has(id)) drop(id);
      }
      for (const [id, wanted] of desired) {
        // Checked after every await above and below: `close` can land at any of them, and a
        // trigger started after it would listen forever with nothing left to stop it.
        if (closed) return;
        const key = JSON.stringify([
          wanted.kind.name,
          wanted.kind.version,
          wanted.trigger,
          wanted.paused === true,
        ]);
        const current = running.get(id);
        if (current?.key === key) continue;
        if (current !== undefined) await stopTrigger(id, current);
        await startTrigger(id, wanted, key, 0);
      }
    },

    listener(id, kind) {
      const found = listeners.get(id);
      return found?.kind === kind ? found.status : undefined;
    },

    async retry(id) {
      const entry = running.get(id);
      if (closed || entry === undefined) return undefined;
      // An attempt in flight, or queued for its timer, is the answer: never a second `start`.
      if (!entry.settled) await entry.attempt;
      else if (entry.queued !== undefined) await entry.queued;
      else if (listeners.get(id)?.status.state === 'failed') {
        entry.queued = options
          .exclusive(async () => {
            if (!isCurrent(id, entry)) return;
            await replaceAttempt(id, entry, 0);
          })
          .catch((error: unknown) => {
            options.diagnose(`Could not retry the trigger of workflow "${id}".`, error);
          });
        await entry.queued;
      }
      return listeners.get(id)?.status;
    },

    noteFired(id, kind) {
      const entry = running.get(id);
      if (entry !== undefined && entry.kind === kind) noteFired(id, entry);
    },

    async close() {
      closed = true;
      for (const [id, trigger] of running) await stopTrigger(id, trigger);
    },
  };
}
