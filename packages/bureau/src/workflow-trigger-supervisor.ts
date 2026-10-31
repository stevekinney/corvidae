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

import type { PluginTriggerKind } from '@lostgradient/interborough-plugin';

import type { VersionedCatalogEntry } from './versioned-catalog';

/** A file's trigger that should be listening. */
export interface DesiredTrigger {
  /** The contributed kind, with the plugin it came from. */
  readonly kind: VersionedCatalogEntry<PluginTriggerKind>;
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

export interface WorkflowTriggerSupervisorOptions {
  /**
   * Starts an instance of workflow `id` for the trigger `kind`; called by a trigger's `fire`, which
   * may come before its `start` resolves. It must never wait for a reconcile: a reconcile awaits a
   * trigger's `stop`, and a `stop` may wait for the trigger's fires in flight.
   */
  readonly fire: (id: string, kind: string, payload: unknown) => Promise<void>;
  readonly diagnose: (message: string, cause: unknown) => void;
}

interface RunningTrigger {
  /** The kind, its version and the trigger object: a change to any restarts the trigger. */
  readonly key: string;
  readonly controller: AbortController;
  /** What `start` resolved with; absent when `start` failed, so the same trigger is not retried. */
  stop?: (() => void | Promise<void>) | undefined;
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
    const { kind: _kind, ...rest } = trigger;
    const parsed = kind.value.configuration.safeParse(rest);
    if (!parsed.success) {
      options.diagnose(
        `The "${kind.name}" trigger of workflow "${id}" has a configuration its kind refuses: ${parsed.error.message}`,
        undefined,
      );
      return;
    }
    try {
      entry.stop = await kind.value.start({
        configuration: parsed.data,
        signal: controller.signal,
        fire: (payload) =>
          controller.signal.aborted ? Promise.resolve() : options.fire(id, kind.name, payload),
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
