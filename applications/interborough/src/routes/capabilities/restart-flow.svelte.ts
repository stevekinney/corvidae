/**
 * The restart Capabilities › Sources offers once a source is saved: ask the host to restart
 * (`POST /host/restart`, answered `202` before it stops), then watch the host until it answers
 * again with nothing left waiting for a restart. It is the sibling of the plugins page's flow
 * (`settings/plugins/restart-flow.svelte.ts`), which reads the plugins and writes before it asks;
 * this one only asks and reads the tool sources, and both share one timing (`restartProbing`) so a
 * test shortens the wait once.
 *
 * Watching is a read of `GET /host/tool-sources` on a timer. The host is back when a read succeeds
 * after one failed (it was down and is up), or when a read succeeds and no source waits for a
 * restart (a restart too quick to catch down still counts). A host that keeps answering with a
 * source still waiting for `restartProbing.unchangedLimit` reads was never restarted, which is said
 * instead of waited for: nothing supervises it, or the restart failed. The wait is on the host's
 * answer and never on a duration, so a slow start is waited out.
 */
import { HostPluginError, restartHost } from '../../lib/host-plugins.ts';
import { getToolSources, type ToolSourcesSnapshot } from '../../lib/host-tool-sources.ts';
import { restartProbing } from '../settings/plugins/restart-flow.svelte.ts';
import { sourceWaitsForRestart } from './capability-presentation.ts';

/** Where a restart stands. */
export type SourcesRestartPhase =
  | 'idle'
  /** The restart is being asked for. */
  | 'requesting'
  /** The host accepted and is still answering. */
  | 'stopping'
  /** The host stopped and has not answered yet. */
  | 'starting'
  /** The host answers again. */
  | 'back'
  /** The host kept answering with the old sources loaded. */
  | 'unconfirmed';

/** Why a restart did not begin. */
export type SourcesRestartRefusal = 'locked' | 'refused' | 'unreachable';

/** One restart of the host, and the state the page shows while it runs. */
export class SourcesRestartFlow {
  /** Where the restart stands. */
  phase = $state<SourcesRestartPhase>('idle');
  /** Why the last restart did not begin, or `undefined`. */
  refusal = $state<SourcesRestartRefusal | undefined>(undefined);
  /** The sources once the host answered again. */
  result = $state<ToolSourcesSnapshot | undefined>(undefined);

  #disposed = false;

  /** Whether a restart is under way: the page shows its progress and holds the rest still. */
  get running(): boolean {
    return this.phase !== 'idle' && this.phase !== 'back' && this.phase !== 'unconfirmed';
  }

  /**
   * Asks the host to restart and watches it come back. Settles when the host answers again, when it
   * is plain it did not restart, or when the restart could not begin (`refusal`). A restart that is
   * already under way is not started a second time.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.refusal = undefined;
    this.result = undefined;
    this.phase = 'requesting';
    try {
      await restartHost();
    } catch (error) {
      this.refusal = !(error instanceof HostPluginError)
        ? 'unreachable'
        : error.kind === 'locked'
          ? 'locked'
          : 'refused';
      this.phase = 'idle';
      return;
    }
    this.phase = 'stopping';
    await this.#watch();
  }

  /** Puts the flow back to rest, after the person has read how it ended. */
  close(): void {
    if (this.running) return;
    this.phase = 'idle';
    this.refusal = undefined;
    this.result = undefined;
  }

  /** Stops watching: the page is gone. */
  dispose(): void {
    this.#disposed = true;
  }

  async #watch(): Promise<void> {
    let sawDown = false;
    let unchanged = 0;
    while (!this.#disposed) {
      let snapshot: ToolSourcesSnapshot | undefined;
      try {
        snapshot = await getToolSources();
      } catch {
        snapshot = undefined;
      }
      if (this.#disposed) return;
      if (snapshot === undefined) {
        sawDown = true;
        this.phase = 'starting';
      } else if (sawDown || !snapshot.sources.some(sourceWaitsForRestart)) {
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
