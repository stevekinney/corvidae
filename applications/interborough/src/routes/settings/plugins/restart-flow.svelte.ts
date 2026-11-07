/**
 * The restart Settings › Plugins asks for: write the changed plugins, ask the host to restart, then
 * watch the host until it answers again with the new plugins loaded. The restart and the watch are
 * the shell's (`app/restart/host-restart-flow.svelte.ts`); this adds the writes before them and
 * what to read afterwards (`GET /host/plugins`).
 *
 * The host answers each write with whether the change waits for a restart. A write it applied at
 * once (a provider's allowlist) does not; when no write answered that it does and no plugin was
 * already waiting, the flow ends as saved and the host is never restarted.
 *
 * What waits for a restart is a plugin or a setting (`engine.maxConcurrentRuns`), and the restart
 * can be for a setting alone, so the watch reads both, the way the settings page does
 * (`settings-session.svelte.ts`): the host is back when it answered after being down, or when
 * neither a plugin nor a setting waits for a restart any more. Reading the plugins alone would call
 * the host back on the first answer, before it had stopped.
 */
import {
  HostRestartFlow,
  type RestartIntent,
} from '../../../app/restart/host-restart-flow.svelte.ts';
import { getSettings, type SettingsSnapshot } from '../../../lib/bureau-settings.ts';
import {
  getPlugins,
  HostPluginError,
  updatePlugin,
  type PluginsSnapshot,
} from '../../../lib/host-plugins.ts';
import type { PluginWrite } from './plugin-drafts.svelte.ts';

/** A write the host rejected: which plugin, the field it named and its message. */
export type WriteRejection = {
  readonly plugin: string;
  readonly field: string;
  readonly message: string;
};

/** What the watch reads from the host: the plugins and the settings, both of which can wait for a restart. */
export type RestartSnapshot = {
  readonly plugins: PluginsSnapshot;
  readonly settings: SettingsSnapshot;
};

/**
 * Reads the plugins and then the settings. One after the other, so a host that is down fails the
 * first read and a host that has just started answers both from its new run.
 */
async function readHost(): Promise<RestartSnapshot> {
  const plugins = await getPlugins();
  const settings = await getSettings();
  return { plugins, settings };
}

/** Whether a plugin or a setting still waits for a restart. */
function restartWaits(snapshot: RestartSnapshot): boolean {
  return (
    snapshot.plugins.plugins.some((plugin) => plugin.restartRequired) ||
    Object.values(snapshot.settings.keys).some((key) => key.pendingRestart)
  );
}

/** One restart of the host for Settings › Plugins, and the state the page shows while it runs. */
export class RestartFlow extends HostRestartFlow<RestartSnapshot> {
  /** The write the host rejected as invalid, or `undefined`. */
  rejection = $state<WriteRejection | undefined>(undefined);
  /** Whether the last run saved its changes and the host applied them without a restart. */
  saved = $state(false);

  #stopped = false;

  constructor() {
    super({ read: readHost, waiting: restartWaits });
  }

  /**
   * Writes `writes`, restarts the host, and watches it come back. Settles when the host answers
   * again, when it is plain it did not restart, when it never came back, or when the restart could
   * not begin (`refusal`). A restart that is already under way is not started a second time.
   * `restartPending` is whether a plugin the host already holds waits for a restart, which this one
   * then also covers. `intent` is what the dialog and the banner after it say the restart is for.
   */
  async run(
    writes: readonly PluginWrite[],
    restartPending: boolean,
    intent: RestartIntent,
  ): Promise<void> {
    if (this.running) return;
    this.refusal = undefined;
    this.rejection = undefined;
    this.saved = false;
    this.result = undefined;
    this.setPhase('saving');
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
      this.refuse(
        error instanceof HostPluginError && error.kind === 'locked' ? 'locked' : 'save-failed',
      );
      return;
    }
    if (!restartRequired) {
      await this.#finishSaved();
      return;
    }
    await this.begin(intent);
  }

  /** Every write was applied at once: read the plugins again and end without a restart. */
  async #finishSaved(): Promise<void> {
    try {
      const snapshot = await readHost();
      if (!this.#stopped) this.result = snapshot;
    } catch {
      // The page reads the plugins again when it sees `saved`.
    }
    this.setPhase('idle');
    this.saved = true;
  }

  /** Stops watching: the page is gone. */
  override dispose(): void {
    this.#stopped = true;
    super.dispose();
  }
}
