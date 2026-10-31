/**
 * The restart Settings › Plugins asks for: write the changed plugins, ask the host to restart
 * (`POST /host/restart`, answered `202` before it stops), then watch the host until it answers
 * again with the new plugins loaded.
 *
 * Watching is a read of `GET /host/plugins` on a timer. The host is back when a read succeeds after
 * one failed (it was down and is up), or when a read succeeds and no plugin reports a restart
 * pending (the stored choices are now the loaded ones, so a restart too quick to catch down still
 * counts). A host that keeps answering with a restart still pending for `restartProbing.unchangedLimit`
 * reads was never restarted, which is said instead of waited for: nothing supervises it, or the
 * restart failed. The wait is on the host's answer and never on a duration, so a slow start is
 * waited out.
 *
 * The host answers each write with whether the change waits for a restart. A write it applied at
 * once (a provider's allowlist) does not; when no write answered that it does and no plugin was
 * already waiting, the flow ends as saved and the host is never restarted.
 */
import {
  getPlugins,
  HostPluginError,
  restartHost,
  updatePlugin,
  type PluginsSnapshot,
} from '../../../lib/host-plugins.ts';
import type { PluginWrite } from './plugin-drafts.svelte.ts';

/** Where a restart stands. */
export type RestartPhase =
  | 'idle'
  /** The changed plugins are being written. */
  | 'saving'
  /** The restart is being asked for. */
  | 'requesting'
  /** The host accepted and is still answering. */
  | 'stopping'
  /** The host stopped and has not answered yet. */
  | 'starting'
  /** The host answers again. */
  | 'back'
  /** The host kept answering with the old plugins loaded. */
  | 'unconfirmed';

/** Why a restart did not begin. */
export type RestartRefusal = 'save-failed' | 'locked' | 'refused' | 'unreachable';

/** A write the host rejected: which plugin, the field it named and its message. */
export type WriteRejection = {
  readonly plugin: string;
  readonly field: string;
  readonly message: string;
};

/** How the watch on the host runs. A test shortens the wait; the page never changes it. */
export const restartProbing = {
  /** Milliseconds between two reads of the host. */
  delayMs: 500,
  /** Reads that find the host answering with a restart still pending before the page says it did not restart. */
  unchangedLimit: 20,
};

/** One restart of the host, and the state the page shows while it runs. */
export class RestartFlow {
  /** Where the restart stands. */
  phase = $state<RestartPhase>('idle');
  /** Why the last restart did not begin, or `undefined`. */
  refusal = $state<RestartRefusal | undefined>(undefined);
  /** The plugins once the host answered again. */
  result = $state<PluginsSnapshot | undefined>(undefined);
  /** The write the host rejected as invalid, or `undefined`. */
  rejection = $state<WriteRejection | undefined>(undefined);
  /** Whether the last run saved its changes and the host applied them without a restart. */
  saved = $state(false);

  #disposed = false;

  /** Whether a restart is under way: the page shows its progress and holds the rest still. */
  get running(): boolean {
    return this.phase !== 'idle' && this.phase !== 'back' && this.phase !== 'unconfirmed';
  }

  /**
   * Writes `writes`, restarts the host, and watches it come back. Settles when the host answers
   * again, when it is plain it did not restart, or when the restart could not begin (`refusal`).
   * A restart that is already under way is not started a second time. `restartPending` is whether
   * a plugin the host already holds waits for a restart, which this one then also covers.
   */
  async run(writes: readonly PluginWrite[], restartPending = false): Promise<void> {
    if (this.running) return;
    this.refusal = undefined;
    this.rejection = undefined;
    this.saved = false;
    this.result = undefined;
    this.phase = 'saving';
    // The caller owns the array and may change it while the writes wait; the flow keeps its own.
    const pending = [...writes];
    let restartRequired = restartPending;
    let writing = '';
    try {
      for (const write of pending) {
        const { name, ...choices } = write;
        writing = name;
        const change = await updatePlugin(name, choices);
        if (change.restartRequired) restartRequired = true;
      }
    } catch (error) {
      if (error instanceof HostPluginError && error.kind === 'invalid') {
        this.rejection = {
          plugin: writing,
          field: error.field ?? '',
          message: error.message,
        };
      }
      this.#refuse(
        error instanceof HostPluginError && error.kind === 'locked' ? 'locked' : 'save-failed',
      );
      return;
    }
    if (!restartRequired) {
      await this.#finishSaved();
      return;
    }
    this.phase = 'requesting';
    try {
      await restartHost();
    } catch (error) {
      this.#refuse(
        !(error instanceof HostPluginError)
          ? 'unreachable'
          : error.kind === 'locked'
            ? 'locked'
            : 'refused',
      );
      return;
    }
    this.phase = 'stopping';
    await this.#watch();
  }

  /** Puts the flow back to rest, after the person has read how it ended. */
  close(): void {
    if (this.running) return;
    this.phase = 'idle';
    this.result = undefined;
  }

  /** Stops watching: the page is gone. */
  dispose(): void {
    this.#disposed = true;
  }

  /** Every write was applied at once: read the plugins again and end without a restart. */
  async #finishSaved(): Promise<void> {
    try {
      const snapshot = await getPlugins();
      if (!this.#disposed) this.result = snapshot;
    } catch {
      // The page reads the plugins again when it sees `saved`.
    }
    this.phase = 'idle';
    this.saved = true;
  }

  #refuse(refusal: RestartRefusal): void {
    this.refusal = refusal;
    this.phase = 'idle';
  }

  async #watch(): Promise<void> {
    let sawDown = false;
    let unchanged = 0;
    while (!this.#disposed) {
      let snapshot: PluginsSnapshot | undefined;
      try {
        snapshot = await getPlugins();
      } catch {
        snapshot = undefined;
      }
      if (this.#disposed) return;
      if (snapshot === undefined) {
        sawDown = true;
        this.phase = 'starting';
      } else if (sawDown || !snapshot.plugins.some((plugin) => plugin.restartRequired)) {
        this.result = snapshot;
        this.phase = 'back';
        return;
      } else {
        unchanged += 1;
        if (unchanged >= restartProbing.unchangedLimit) {
          this.result = snapshot;
          this.phase = 'unconfirmed';
          return;
        }
      }
      await new Promise<void>((resolve) => {
        // poll-reason: timer
        setTimeout(resolve, restartProbing.delayMs);
      });
    }
  }
}
