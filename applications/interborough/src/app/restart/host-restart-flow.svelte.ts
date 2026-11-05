/**
 * One restart of the host, as the shell shows it (`shell:restart-flow`): ask the host to restart
 * (`POST /host/restart`, answered `202` before it stops), then watch it until it answers again.
 * Settings › Plugins and the settings page each drive one of these, and one dialog
 * (`restart-dialog.svelte`) and one confirmation banner (`restart-back-banner.svelte`) show it.
 *
 * The phases are the ones the design draws. While the host still answers the person sees the steps
 * (`requesting`, `stopping`). Once a read gets no answer the host is down: `starting` counts the
 * reconnect attempts, backing off 1, 2, 4 and 8 seconds like the app-wide banner
 * (`connectionProbeDelayMs`), and Retry now probes at once and counts from 1 again. After
 * {@link CONNECTION_MAX_ATTEMPTS} attempts the flow is `failed`, which names the exact command the
 * host was launched with, read before the request while the host still answered. Keep waiting
 * watches again from the first attempt. There is no restart-again action, because the route that
 * restarts the host lives on the host that is not answering.
 *
 * The host is back when a read succeeds after one failed (it was down and is up), or when a read
 * succeeds and nothing waits for a restart any more (a restart too quick to catch down still
 * counts). A host that keeps answering with a change still waiting for `restartProbing.unchangedLimit`
 * reads was never restarted, which is said instead of waited for: nothing supervises it, or the
 * restart failed. The wait is on the host's answer and never on a duration, so a slow start is
 * waited out.
 *
 * While a restart runs, the shell does not raise its own "can't reach the server" banner behind the
 * dialog (`restartActivity`): the dialog is the one account of what the host is doing.
 */
import { getRestartStanding, HostPluginError, restartHost } from '../../lib/host-plugins.ts';
import { CONNECTION_MAX_ATTEMPTS, connectionProbeDelayMs } from '../connection.svelte.ts';

/** Where a restart stands. */
export type RestartPhase =
  | 'idle'
  /** The changes the restart applies are being written (Settings › Plugins writes before it asks). */
  | 'saving'
  /** The restart is being asked for. */
  | 'requesting'
  /** The host accepted and is still answering. */
  | 'stopping'
  /** The host stopped and has not answered yet: the reconnect attempts count here. */
  | 'starting'
  /** The host did not answer after {@link CONNECTION_MAX_ATTEMPTS} attempts. */
  | 'failed'
  /** The host answers again. */
  | 'back'
  /** The host kept answering with the change still waiting for a restart. */
  | 'unconfirmed';

/** Why a restart did not begin. */
export type RestartRefusal = 'save-failed' | 'locked' | 'refused' | 'unreachable';

/**
 * What the restart is for, in the person's words: the changes it applies and, when it unloads one
 * plugin, which. The dialog and the banner that follows it word themselves from this.
 */
export type RestartIntent = {
  /** The changes the restart applies, such as "Workflow claim renew interval" or "Linear". */
  readonly changes: readonly string[];
  /** Set when the one change is turning a plugin off. */
  readonly disabling?: {
    /** The plugin's name as a person reads it, such as "Web search". */
    readonly title: string;
    /** What stops working without it, such as "2 agents and 1 schedule", or `undefined` for nothing. */
    readonly unavailable: string | undefined;
  };
};

/** How the watch on the host runs. A test shortens the waits; the page never changes them. */
export const restartProbing = {
  /** Milliseconds between two reads while the host still answers. */
  delayMs: 500,
  /** Reads that find the host answering with a restart still pending before the page says it did not restart. */
  unchangedLimit: 20,
  /** Milliseconds to wait before reconnect attempt `attempt`, counted from 1. */
  retryDelayMs: (attempt: number): number => connectionProbeDelayMs(attempt),
};

/**
 * Whether a restart is under way anywhere on the page, which the shell reads to keep its own
 * connection banner from speaking over the restart dialog.
 */
export const restartActivity = $state({ active: false });

/** What the flow needs from the host to know the restart happened. */
export type HostRestartWatch<Snapshot> = {
  /** Reads the host's state; rejects when the host does not answer. */
  readonly read: () => Promise<Snapshot>;
  /** Whether the state still has a change waiting for a restart. */
  readonly waiting: (snapshot: Snapshot) => boolean;
};

function describe(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'No answer.';
}

/** One restart of the host, and the state the dialog and the page show while it runs. */
export class HostRestartFlow<Snapshot> {
  /** Where the restart stands. */
  phase = $state<RestartPhase>('idle');
  /** Why the last restart did not begin, or `undefined`. */
  refusal = $state<RestartRefusal | undefined>(undefined);
  /** The host's state once it answered again. */
  result = $state<Snapshot | undefined>(undefined);
  /** What the restart is for. */
  intent = $state<RestartIntent>({ changes: [] });
  /** The reconnect attempt under way, counted from 1, or 0 before the host is seen down. */
  attempt = $state(0);
  /** Seconds until the next automatic attempt, or `undefined` while none is counting down. */
  retryInSeconds = $state<number | undefined>(undefined);
  /** The command the host was launched with, read before the restart, or `undefined` when it is unknown. */
  launchCommand = $state<string | undefined>(undefined);
  /** What the last read that got no answer said, for the failed state's details. */
  lastError = $state<string | undefined>(undefined);

  readonly #watch: HostRestartWatch<Snapshot>;
  #disposed = false;
  #generation = 0;
  #wake: (() => void) | undefined;

  constructor(watch: HostRestartWatch<Snapshot>) {
    this.#watch = watch;
  }

  /** Whether a restart is under way: the page shows its progress and holds the rest still. */
  get running(): boolean {
    return (
      this.phase === 'saving' ||
      this.phase === 'requesting' ||
      this.phase === 'stopping' ||
      this.phase === 'starting'
    );
  }

  /** Whether the dialog is showing: a restart under way, or one that did not come back. */
  get open(): boolean {
    return this.running || this.phase === 'failed';
  }

  /** Moves to `phase` and tells the shell whether a restart is showing. */
  protected setPhase(phase: RestartPhase): void {
    this.phase = phase;
    restartActivity.active = this.open;
  }

  /**
   * Asks the host to restart and watches it come back. Settles when the host answers again, when it
   * is plain it did not restart, when it never came back, or when the restart could not begin
   * (`refusal`). A restart that is already under way is not started a second time.
   */
  async restart(intent: RestartIntent): Promise<void> {
    if (this.running) return;
    await this.begin(intent);
  }

  /**
   * Asks the host to restart and watches it come back, for a flow that has already taken the
   * restart for its own (Settings › Plugins is `saving` while it writes, and `running`).
   */
  protected async begin(intent: RestartIntent): Promise<void> {
    this.intent = intent;
    this.refusal = undefined;
    this.result = undefined;
    this.lastError = undefined;
    this.launchCommand = undefined;
    this.attempt = 0;
    this.retryInSeconds = undefined;
    this.setPhase('requesting');
    await this.#readLaunchCommand();
    try {
      await restartHost();
    } catch (error) {
      this.refuse(
        !(error instanceof HostPluginError)
          ? 'unreachable'
          : error.kind === 'locked'
            ? 'locked'
            : 'refused',
      );
      return;
    }
    await this.#follow(false);
  }

  /** Ends the restart before it began, with the reason the page says. */
  protected refuse(refusal: RestartRefusal): void {
    this.refusal = refusal;
    this.setPhase('idle');
  }

  /**
   * Probes the host now instead of waiting out the countdown, and counts the attempts from the
   * first again. Always available while the host is not answering.
   */
  retryNow(): void {
    if (this.phase !== 'starting') return;
    this.attempt = 0;
    this.#wake?.();
  }

  /** Watches again from the first attempt, after the host did not answer. */
  keepWaiting(): void {
    if (this.phase !== 'failed') return;
    this.attempt = 0;
    void this.#follow(true);
  }

  /** Puts the flow back to rest, after the person has read how it ended. */
  close(): void {
    if (this.running) return;
    this.setPhase('idle');
    this.result = undefined;
  }

  /** Stops watching: the page is gone. */
  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#wake?.();
    restartActivity.active = false;
  }

  /** The command is read while the host still answers; once it stops, there is nobody to ask. */
  async #readLaunchCommand(): Promise<void> {
    try {
      const standing = await getRestartStanding();
      if (!this.#disposed) this.launchCommand = standing.launch?.command;
    } catch {
      // The failed state then leaves the command out rather than guessing at one.
    }
  }

  /** Waits `milliseconds`, or less when Retry now cuts it short. */
  #wait(milliseconds: number, countdown: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const retryAt = Date.now() + milliseconds;
      let ticker: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        clearTimeout(timer);
        clearInterval(ticker);
        this.#wake = undefined;
        this.retryInSeconds = undefined;
        resolve();
      };
      this.#wake = finish;
      if (countdown) {
        this.retryInSeconds = Math.ceil(milliseconds / 1_000);
        // poll-reason: timer
        ticker = setInterval(() => {
          this.retryInSeconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
        }, 1_000);
      }
      // poll-reason: timer
      timer = setTimeout(finish, milliseconds);
    });
  }

  async #follow(sawDown: boolean): Promise<void> {
    const generation = (this.#generation += 1);
    this.setPhase(sawDown ? 'starting' : 'stopping');
    let unchanged = 0;
    let down = sawDown;
    while (!this.#disposed && generation === this.#generation) {
      let outcome: { readonly snapshot: Snapshot } | { readonly failure: unknown };
      try {
        outcome = { snapshot: await this.#watch.read() };
      } catch (error) {
        outcome = { failure: error };
      }
      if (this.#disposed || generation !== this.#generation) return;
      if ('failure' in outcome) {
        down = true;
        this.lastError = describe(outcome.failure);
        if (this.attempt >= CONNECTION_MAX_ATTEMPTS) {
          this.setPhase('failed');
          return;
        }
        this.attempt += 1;
        this.setPhase('starting');
        await this.#wait(restartProbing.retryDelayMs(this.attempt), true);
        continue;
      }
      const { snapshot } = outcome;
      if (down || !this.#watch.waiting(snapshot)) {
        this.result = snapshot;
        this.attempt = 0;
        this.setPhase('back');
        return;
      }
      unchanged += 1;
      if (unchanged >= restartProbing.unchangedLimit) {
        this.result = snapshot;
        this.setPhase('unconfirmed');
        return;
      }
      await this.#wait(restartProbing.delayMs, false);
    }
  }
}
