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
 * @module workflow-trigger-supervisor
 */

import type { PluginTrigger, PluginTriggerOutcome } from '@lostgradient/interborough-plugin';
import type { Storage } from '@lostgradient/storage';

import type { VersionedCatalogEntry } from './versioned-catalog';
import { createTriggerStorage } from './workflow-trigger-state';

/** A file's trigger that should be listening. */
export interface DesiredTrigger {
  /** The contributed kind, with the plugin it came from. */
  readonly kind: VersionedCatalogEntry<PluginTrigger>;
  /** The file's `trigger` object, `kind` included. */
  readonly trigger: Readonly<Record<string, unknown>>;
}

/** Keeps the running triggers equal to the files'. */
export interface WorkflowTriggerSupervisor {
  /**
   * Start the triggers in `desired` that are not running, restart those whose kind or trigger
   * changed, and stop the others, except the workflows in `keep`, which are left as they are.
   */
  reconcile(desired: ReadonlyMap<string, DesiredTrigger>, keep: ReadonlySet<string>): Promise<void>;
  /** Stop every trigger and refuse to start another. */
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
}

interface RunningTrigger {
  /** The kind, its version and the trigger object: a change to any restarts the trigger. */
  readonly key: string;
  readonly controller: AbortController;
  /** What `start` resolved with; absent when `start` failed, so the same trigger is not retried. */
  stop?: (() => void | Promise<void>) | undefined;
}

/** A fire that started nothing, and why. */
function skipped(reason: 'stopped' | 'paused' | 'closed'): PluginTriggerOutcome {
  return { outcome: 'skipped', reason };
}

/** Build a supervisor. */
export function createWorkflowTriggerSupervisor(
  options: WorkflowTriggerSupervisorOptions,
): WorkflowTriggerSupervisor {
  const running = new Map<string, RunningTrigger>();
  let closed = false;

  async function stopTrigger(id: string, trigger: RunningTrigger): Promise<void> {
    running.delete(id);
    trigger.controller.abort();
    try {
      await trigger.stop?.();
    } catch (error) {
      options.diagnose(`Could not stop the trigger of workflow "${id}".`, error);
    }
  }

  async function startTrigger(id: string, desired: DesiredTrigger, key: string): Promise<void> {
    // A close that landed while the previous trigger was starting or stopping: start nothing.
    if (closed) return;
    const controller = new AbortController();
    const entry: RunningTrigger = { key, controller };
    running.set(id, entry);
    const { kind, trigger } = desired;
    // Captured now, as part of the listener that is starting: a fire records the version of the
    // listener it came from, however the catalog moves afterwards.
    const version = kind.version;
    const { kind: _kind, ...rest } = trigger;
    const parsed = kind.value.configuration.safeParse(rest);
    if (!parsed.success) {
      options.diagnose(
        `The "${kind.name}" trigger of workflow "${id}" has a configuration its kind refuses: ${parsed.error.message}`,
        undefined,
      );
      return;
    }
    let storage: Storage;
    try {
      storage = createTriggerStorage(options.storage, kind.name, id);
    } catch (error) {
      options.diagnose(
        `Could not give the "${kind.name}" trigger of workflow "${id}" its storage; it stays stopped until its file changes or Bureau restarts.`,
        error,
      );
      return;
    }
    try {
      entry.stop = await kind.value.start({
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
          return options.fire({
            workflowId: id,
            kind: kind.name,
            version,
            payload,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          });
        },
      });
    } catch (error) {
      options.diagnose(
        `Could not start the "${kind.name}" trigger of workflow "${id}"; it stays stopped until its file changes or Bureau restarts.`,
        error,
      );
      return;
    }
    // Stopped while `start` was still resolving: it listens for nothing now.
    if (controller.signal.aborted) {
      try {
        await entry.stop?.();
      } catch (error) {
        options.diagnose(`Could not stop the trigger of workflow "${id}".`, error);
      }
    }
  }

  return {
    async reconcile(desired, keep) {
      if (closed) return;
      for (const [id, trigger] of running) {
        if (closed) return;
        if (!desired.has(id) && !keep.has(id)) await stopTrigger(id, trigger);
      }
      for (const [id, wanted] of desired) {
        // Checked after every await above and below: `close` can land at any of them, and a
        // trigger started after it would listen forever with nothing left to stop it.
        if (closed) return;
        const key = JSON.stringify([wanted.kind.name, wanted.kind.version, wanted.trigger]);
        const current = running.get(id);
        if (current?.key === key) continue;
        if (current !== undefined) await stopTrigger(id, current);
        await startTrigger(id, wanted, key);
      }
    },

    async close() {
      closed = true;
      for (const [id, trigger] of running) await stopTrigger(id, trigger);
    },
  };
}
