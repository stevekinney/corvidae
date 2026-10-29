/**
 * Follows `bureau.settings.events` for the settings page (COR-1751): it tells the page when the
 * settings change so the page reads them again, and keeps the stream open across a network drop.
 *
 * ## Resuming
 *
 * Every event names the revision it reports as its `cursor`, and a stream opened with that cursor
 * in `Last-Event-ID` carries on from it: when the settings have moved on since, the Bureau opens
 * with one event for the current revision, so a change made while the stream was down is not lost.
 * The follower keeps the last cursor it was given and resumes from it. The first stream has none, so
 * the page reads the settings once the Bureau has accepted the subscription (`onOpen`), which closes
 * the gap between that read and the subscription.
 *
 * ## Reconnecting
 *
 * A stream that drops, fails to open, or that the Bureau ends (it ends every stream at the
 * subscription route's time limit) is opened again after the shared reconnect backoff, and at once
 * when the browser reports it is back online. A refusal that retrying cannot change (the caller may
 * not read the settings, or the Bureau serves no such stream) ends the following for good; the page
 * still reads the settings again when the window regains focus.
 */
import type { Fetcher } from '../../lib/bureau-client.ts';
import { followSettingsEvents } from '../../lib/bureau-settings.ts';
import { classifyFault } from '../../lib/faults.ts';
import { computeReconnectDelayMs } from '../../lib/live-source/backoff.ts';

function sleepFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    // poll-reason: timer
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** What the follower reads from its page. */
export type SettingsFollowerOptions = {
  /**
   * Called when the Bureau accepts a subscription (with no revision), and after every change (with
   * the revision it reports).
   */
  readonly onChange: (revision?: number) => void;
  readonly fetch?: Fetcher;
  /** Waits out a backoff. Tests stand a sleep they release themselves in for the timer. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export class SettingsFollower {
  readonly #options: SettingsFollowerOptions;
  readonly #controller = new AbortController();
  #cursor: string | undefined;
  #started = false;

  constructor(options: SettingsFollowerOptions) {
    this.#options = options;
  }

  /**
   * Opens the stream, and keeps it open until the follower is disposed. The promise settles when
   * the following has stopped: on dispose, or on a refusal retrying cannot change.
   */
  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    this.#started = true;
    return this.#run();
  }

  /** Stops following, closes the stream, and stops any reconnect that is waiting. */
  dispose(): void {
    this.#controller.abort();
  }

  get #disposed(): boolean {
    return this.#controller.signal.aborted;
  }

  /** Waits out a backoff, or until the browser reports it is back online, or until disposed. */
  async #wait(milliseconds: number): Promise<void> {
    const signal = this.#controller.signal;
    let onOnline: (() => void) | undefined;
    const online = new Promise<void>((resolve) => {
      onOnline = resolve;
      window.addEventListener('online', onOnline, { once: true });
    });
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    try {
      await Promise.race([
        (this.#options.sleep ?? sleepFor)(milliseconds, signal),
        online,
        aborted,
      ]);
    } finally {
      if (onOnline !== undefined) window.removeEventListener('online', onOnline);
    }
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#disposed) {
      try {
        const changes = followSettingsEvents({
          signal: this.#controller.signal,
          ...(this.#cursor === undefined ? {} : { cursor: this.#cursor }),
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
          onOpen: () => {
            attempt = 0;
            this.#options.onChange();
          },
        });
        for await (const change of changes) {
          this.#cursor = change.cursor;
          this.#options.onChange(change.revision);
        }
        if (this.#disposed) return;
        // The Bureau ended the stream, which is not a failure: open it again after the first step.
        await this.#wait(computeReconnectDelayMs(1));
        continue;
      } catch (error) {
        if (this.#disposed) return;
        const treatment = classifyFault(error);
        if (
          treatment?.kind === 'not-found' ||
          treatment?.kind === 'not-supported' ||
          treatment?.kind === 'unauthorized'
        ) {
          return;
        }
      }
      attempt += 1;
      await this.#wait(computeReconnectDelayMs(attempt));
    }
  }
}
